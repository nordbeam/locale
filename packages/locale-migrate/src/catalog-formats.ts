import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parse as parseModule } from '@babel/parser';
import type { Comment, Expression, Node, ObjectExpression, Statement } from '@babel/types';
import { XMLParser } from 'fast-xml-parser';
import gettext from 'gettext-parser';
import { parse as parseYaml } from 'yaml';
import type { Diagnostic } from 'nordbeam-locale/internal/migrate';
import { convertLinguiNodes, decodeLinguiMessage } from './lingui-messages.js';
import type { LinguiNode } from './lingui-messages.js';
import { grouped, linguiSourceIdWarning } from './grouped-warnings.js';

export type MigrationFormat = 'i18next' | 'vue-i18n' | 'next-intl' | 'formatjs' | 'lingui' | 'lingui-po' | 'tolgee'
  | 'arb' | 'yaml' | 'android-xml' | 'apple-strings' | 'apple-xcstrings'
  | 'po' | 'pot' | 'mo' | 'json-gettext' | 'module';

export interface DecodedCatalog {
  value: Record<string, unknown>;
  traversal: 'i18next' | 'vue-i18n' | 'next-intl' | 'formatjs';
  warnings: Diagnostic[];
  /** Translator notes by message ID, from source comments or descriptions. */
  notes?: Record<string, string>;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const warning = (code: string, message: string, hint?: string): Diagnostic => ({ code, message, ...(hint ? { hint } : {}) });

function json(buffer: Buffer, file: string): unknown {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch (error) { throw new SyntaxError(`Invalid JSON catalog ${file}: ${(error as Error).message}`); }
}

/** Plural branches use {count} for the first integer placeholder, which is the selector's value. */
function normalizePrintf(text: string, id: string, warnings: Diagnostic[], plural = false): string {
  let sequential = 0, counted = false;
  // The space flag is omitted so prose such as "50% off" is not read as an octal conversion.
  return text.replace(/%(?:(\d+)\$)?(?:[-+0#']*\d*(?:\.\d+)?)?(?:hh|ll|[hlLjztq])?([@diuoxXfFeEgGaAcCsSp%])/g, (token, position: string | undefined, conversion: string) => {
    if (conversion === '%') return '%';
    const index = position ? Number(position) : ++sequential;
    if (plural && !counted && /[diu]/.test(conversion)) {
      counted = true;
      warnings.push(warning('MIGRATION_PRINTF_PLACEHOLDER', `Converted ${token} in ${JSON.stringify(id)} to {count}.`, 'The plural selector supplies this count.'));
      return '{count}';
    }
    warnings.push(warning('MIGRATION_PRINTF_PLACEHOLDER', `Converted ${token} in ${JSON.stringify(id)} to {arg${index}}.`, 'Rename positional arguments after migrating call sites.'));
    return `{arg${index}}`;
  });
}

function appleStrings(text: string, warnings: Diagnostic[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  const pattern = /"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"\s*;/g;
  for (const match of text.matchAll(pattern)) {
    const id = JSON.parse(`"${match[1]}"`) as string;
    result[id] = normalizePrintf(JSON.parse(`"${match[2]}"`) as string, id, warnings);
  }
  return result;
}

function androidXml(text: string, warnings: Diagnostic[]): Record<string, unknown> {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true }).parse(text) as Record<string, unknown>;
  const resources = object(parsed.resources) ? parsed.resources : {};
  const output: Record<string, unknown> = Object.create(null);
  const entries = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
  for (const item of entries(resources.string)) {
    if (!object(item) || typeof item['@_name'] !== 'string') continue;
    const id = item['@_name'];
    const value = typeof item['#text'] === 'string' ? item['#text'] : '';
    output[id] = normalizePrintf(value, id, warnings);
  }
  for (const plural of entries(resources.plurals)) {
    if (!object(plural) || typeof plural['@_name'] !== 'string') continue;
    const id = plural['@_name'];
    const variants = entries(plural.item).flatMap(item => object(item) && typeof item['@_quantity'] === 'string'
      ? [[item['@_quantity'], normalizePrintf(String(item['#text'] ?? ''), id, warnings)] as const] : []);
    if (variants.length) output[id] = `{count, plural, ${variants.map(([quantity, value]) => `${quantity} {${value}}`).join(' ')}}`;
  }
  return output;
}

function arb(value: unknown, warnings: Diagnostic[], notes: Record<string, string>): Record<string, unknown> {
  if (!object(value)) throw new TypeError('ARB input must be a JSON object.');
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('@')) {
      if (key.startsWith('@@')) continue;
      // The description is a note; placeholder types and examples have no catalog equivalent.
      const metadata = object(item) ? item : {};
      if (typeof metadata.description === 'string' && metadata.description.trim()) notes[key.slice(1)] = metadata.description;
      if (Object.keys(metadata).some(name => name !== 'description')) warnings.push(warning('MIGRATION_METADATA_DROPPED', `Dropped ARB metadata ${JSON.stringify(key)}.`));
      continue;
    }
    output[key] = item;
  }
  return output;
}

/** Lingui compiled arrays: strings are literal text, [name] is an argument, [name, type, options] is a typed argument.
 * Inside a plural, Lingui's runtime replaces every `#` of a branch with the count. */
function linguiCompiled(parts: unknown, inPlural = false): LinguiNode[] | undefined {
  if (!Array.isArray(parts)) return undefined;
  const nodes: LinguiNode[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      if (!inPlural) { nodes.push({ kind: 'text', value: part }); continue; }
      part.split('#').forEach((text, index) => { if (index) nodes.push({ kind: 'pound' }); if (text) nodes.push({ kind: 'text', value: text }); });
      continue;
    }
    if (!Array.isArray(part) || typeof part[0] !== 'string') return undefined;
    const argument = linguiArgument(part, inPlural);
    if (argument === undefined) return undefined;
    nodes.push(argument);
  }
  return nodes;
}

function linguiArgument(part: unknown[], inPlural: boolean): LinguiNode | undefined {
  const [name, type, options] = part;
  if (typeof name !== 'string' || !name || /[\s{}#'|,:]/.test(name)) return name === '#' && inPlural ? { kind: 'pound' } : undefined;
  if (part.length === 1) return { kind: 'argument', name };
  if (type === 'number' || type === 'date' || type === 'time') {
    if (part.length === 2) return { kind: 'argument', name, type };
    return part.length === 3 && typeof options === 'string' && !/[{}',]/.test(options) ? { kind: 'argument', name, type, style: options } : undefined;
  }
  if ((type === 'plural' || type === 'selectordinal' || type === 'select') && part.length === 3 && object(options)) {
    const pluralBranches = type !== 'select';
    let offset: string | undefined;
    if (pluralBranches && options.offset !== undefined) {
      if (typeof options.offset !== 'number' || !Number.isInteger(options.offset)) return undefined;
      offset = String(options.offset);
    }
    const cases: Array<readonly [string, LinguiNode[]]> = [];
    for (const [key, branch] of Object.entries(options)) {
      if (key === 'offset' && pluralBranches) continue;
      if (!/^(=\d+|[a-z]+)$/.test(key)) return undefined;
      const body = linguiCompiled(branch, inPlural || pluralBranches);
      if (body === undefined) return undefined;
      cases.push([key, body]);
    }
    return cases.length ? { kind: 'branches', name, type, ...(offset !== undefined ? { offset } : {}), cases } : undefined;
  }
  return undefined;
}

/** Messages the Lingui conversion trimmed or changed, reported once per catalog. */
interface LinguiTally { trimmed: string[]; changed: Array<{ id: string; source: string; converted: string }> }

function linguiConverted(id: string, nodes: LinguiNode[], tally: LinguiTally): string {
  const conversion = convertLinguiNodes(nodes);
  if (conversion.trimmed) tally.trimmed.push(id);
  if (conversion.changed) tally.changed.push({ id, ...conversion.changed });
  return conversion.text;
}

function linguiTallyWarnings(tally: LinguiTally, warnings: Diagnostic[]): void {
  if (tally.trimmed.length) warnings.push(grouped('LINGUI_WHITESPACE_TRIMMED', tally.trimmed,
    (count, examples) => `Trimmed leading or trailing whitespace from ${count} message${count === 1 ? '' : 's'} with arguments, as Lingui renders them${examples}.`,
    'Lingui 3 trims what a message with arguments renders and shows plain text as written. Nothing to do unless a page relied on the space.'));
  for (const item of tally.changed) warnings.push({ ...warning('MIGRATION_TEXT_CHANGED', `The converted message ${JSON.stringify(item.id)} does not read back as its source: ${JSON.stringify(item.source)} became ${JSON.stringify(item.converted)}.`, 'Correct this message in the migrated catalog, and report the source text as a migration bug.'), messageId: item.id });
}

function lingui(value: unknown, warnings: Diagnostic[]): Record<string, unknown> {
  if (!object(value)) throw new TypeError('Lingui JSON input must be an object.');
  const output: Record<string, unknown> = Object.create(null);
  const tally: LinguiTally = { trimmed: [], changed: [] }, dropped: string[] = [];
  for (const [id, item] of Object.entries(value)) {
    const source = object(item) ? item.translation ?? item.message : item;
    let nodes: LinguiNode[] | undefined;
    if (typeof source === 'string') {
      try { nodes = decodeLinguiMessage(source); }
      catch (error) { warnings.push({ ...warning('LINGUI_COMPILED_ENTRY', `Could not read Lingui message ${JSON.stringify(id)} (${(error as Error).message}); it was not migrated.`, 'Correct the message in the Lingui catalog, or migrate it by hand.'), messageId: id }); continue; }
    } else nodes = linguiCompiled(source);
    if (nodes) output[id] = linguiConverted(id, nodes, tally);
    else warnings.push(warning('LINGUI_COMPILED_ENTRY', `Could not convert Lingui entry ${JSON.stringify(id)}; it was not migrated.`, 'Only string, [name], number/date/time, plural, selectordinal and select compiled forms are converted. Recompile with ICU messages or migrate this entry by hand.'));
    if (object(item) && Object.keys(item).some(key => !['translation', 'message'].includes(key))) dropped.push(id);
  }
  linguiTallyWarnings(tally, warnings);
  if (dropped.length) warnings.push(grouped('MIGRATION_METADATA_DROPPED', dropped, (count, examples) => `Dropped Lingui metadata (comments, origins, flags) of ${count} message${count === 1 ? '' : 's'}${examples}.`));
  return output;
}

function tolgee(value: unknown, locale: string | undefined, warnings: Diagnostic[]): Record<string, unknown> {
  if (Array.isArray(value)) {
    const output: Record<string, unknown> = Object.create(null);
    for (const row of value) {
      if (!object(row)) continue;
      const id = typeof row.keyName === 'string' ? row.keyName : typeof row.key === 'string' ? row.key : undefined;
      if (!id) continue;
      const translations = object(row.translations) ? row.translations : undefined;
      const selected = locale && translations ? translations[locale] : row.translation ?? row.text;
      if (typeof selected === 'string') output[id] = selected;
      else warnings.push(warning('MIGRATION_LOCALE_REQUIRED', `Tolgee key ${JSON.stringify(id)} has no selected string translation.`, 'Pass --locale for multi-locale Tolgee exports.'));
    }
    return output;
  }
  if (!object(value)) throw new TypeError('Tolgee input must be an object or export array.');
  return value;
}

function xcstrings(value: unknown, locale: string | undefined, warnings: Diagnostic[]): Record<string, unknown> {
  if (!object(value) || !object(value.strings)) throw new TypeError('Apple string catalog must contain a strings object.');
  const selectedLocale = locale ?? (typeof value.sourceLanguage === 'string' ? value.sourceLanguage : undefined);
  if (!selectedLocale) throw new TypeError('Apple string catalog needs --locale or sourceLanguage.');
  const output: Record<string, unknown> = Object.create(null);
  for (const [id, record] of Object.entries(value.strings)) {
    if (!object(record)) continue;
    const localization = object(record.localizations) && object(record.localizations[selectedLocale]) ? record.localizations[selectedLocale] : undefined;
    const unit = localization && object(localization.stringUnit) ? localization.stringUnit : undefined;
    if (unit && typeof unit.value === 'string') { output[id] = normalizePrintf(unit.value, id, warnings); continue; }
    const variations = localization && object(localization.variations) ? localization.variations : undefined;
    const plural = variations && object(variations.plural) ? variations.plural : undefined;
    if (plural) {
      const variants = Object.entries(plural).flatMap(([category, entry]) => object(entry) && object(entry.stringUnit) && typeof entry.stringUnit.value === 'string'
        ? [[category, normalizePrintf(entry.stringUnit.value, id, warnings)] as const] : []);
      if (variants.length) output[id] = `{count, plural, ${variants.map(([category, text]) => `${category} {${text}}`).join(' ')}}`;
    }
  }
  return output;
}

type PluralPlan = Array<[category: string, index: number]>;

/** Plural-Forms expressions are parsed by a tiny recursive-descent parser: no eval, no Function. */
type PluralNode =
  | { kind: 'n' }
  | { kind: 'number'; value: number }
  | { kind: 'unary'; operator: '!' | '-'; operand: PluralNode }
  | { kind: 'binary'; operator: string; left: PluralNode; right: PluralNode }
  | { kind: 'conditional'; test: PluralNode; yes: PluralNode; no: PluralNode };

const pluralLevels = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
const pluralToken = /\s*(?:(\d+)|(n)|(==|!=|<=|>=|&&|\|\||[-+*\/%()?:<>!]))/y;

function parsePluralExpression(source: string): PluralNode {
  if (source.length > 512) throw new SyntaxError('expression is too long');
  const tokens: string[] = [];
  let position = 0;
  while (position < source.length) {
    pluralToken.lastIndex = position;
    const match = pluralToken.exec(source);
    if (!match) {
      if (source.slice(position).trim()) throw new SyntaxError(`unsupported text ${JSON.stringify(source.slice(position).trim())}`);
      break;
    }
    tokens.push(match[1] ?? match[2] ?? match[3]!);
    position = pluralToken.lastIndex;
  }
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const take = (expected?: string): string => {
    const token = tokens[index++];
    if (token === undefined || (expected !== undefined && token !== expected)) throw new SyntaxError(`expected ${expected ?? 'an operand'}`);
    return token;
  };
  const primary = (): PluralNode => {
    const token = take();
    if (token === 'n') return { kind: 'n' };
    if (token === '(') {
      const node = conditional();
      take(')');
      return node;
    }
    if (/^\d+$/.test(token)) return { kind: 'number', value: Number(token) };
    throw new SyntaxError(`unexpected ${JSON.stringify(token)}`);
  };
  const unary = (): PluralNode => peek() === '!' || peek() === '-' ? { kind: 'unary', operator: take() as '!' | '-', operand: unary() } : primary();
  const binary = (level: number): PluralNode => {
    if (level === pluralLevels.length) return unary();
    let left = binary(level + 1);
    while (pluralLevels[level]!.includes(peek() ?? '')) left = { kind: 'binary', operator: take(), left, right: binary(level + 1) };
    return left;
  };
  const conditional = (): PluralNode => {
    const test = binary(0);
    if (peek() !== '?') return test;
    take('?');
    const yes = conditional();
    take(':');
    return { kind: 'conditional', test, yes, no: conditional() };
  };
  const root = conditional();
  if (index !== tokens.length) throw new SyntaxError(`unexpected ${JSON.stringify(tokens[index])}`);
  return root;
}

/** C-style integer semantics, as used by gettext's plural expressions. */
function evaluatePlural(node: PluralNode, n: number): number {
  switch (node.kind) {
    case 'n': return n;
    case 'number': return node.value;
    case 'unary': {
      const value = evaluatePlural(node.operand, n);
      return node.operator === '!' ? Number(value === 0) : -value;
    }
    case 'conditional': return evaluatePlural(node.test, n) !== 0 ? evaluatePlural(node.yes, n) : evaluatePlural(node.no, n);
    case 'binary': {
      const left = evaluatePlural(node.left, n);
      if (node.operator === '&&') return Number(left !== 0 && evaluatePlural(node.right, n) !== 0);
      if (node.operator === '||') return Number(left !== 0 || evaluatePlural(node.right, n) !== 0);
      const right = evaluatePlural(node.right, n);
      switch (node.operator) {
        case '==': return Number(left === right);
        case '!=': return Number(left !== right);
        case '<': return Number(left < right);
        case '>': return Number(left > right);
        case '<=': return Number(left <= right);
        case '>=': return Number(left >= right);
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/':
          if (right === 0) throw new RangeError('division by zero');
          return Math.trunc(left / right);
        case '%':
          if (right === 0) throw new RangeError('division by zero');
          return left % right;
        default: throw new SyntaxError(`unsupported operator ${node.operator}`);
      }
    }
  }
}

/** Sample n = 0..200 and map each CLDR category to the msgstr index that gettext serves it with. */
function pluralPlanFromHeader(header: string | undefined, language: string | undefined, warnings: Diagnostic[]): PluralPlan | undefined {
  const count = header ? /(?:^|;)\s*nplurals\s*=\s*(\d+)/.exec(header) : null;
  const expression = header ? /(?:^|;)\s*plural\s*=\s*([^;]+)/.exec(header) : null;
  if (!count || !expression) {
    warnings.push(warning('PO_PLURAL_FORMS_MISSING', 'Plural-Forms header is missing; plural messages keep only their one and other forms.', 'Add nplurals and plural to the Plural-Forms header so every plural form is converted.'));
    return undefined;
  }
  const nplurals = Number(count[1]);
  let locale: string | undefined;
  try { locale = Intl.getCanonicalLocales(language?.replace(/_/g, '-') ?? '')[0]; }
  catch { locale = undefined; }
  if (!locale) {
    warnings.push(warning('PO_PLURAL_FORMS_INVALID', 'Cannot map plural forms because the catalog language is missing or invalid.', 'Set a canonical Language header, such as pl or pt-BR.'));
    return undefined;
  }
  try {
    const node = parsePluralExpression(expression[1]!.trim());
    const rules = new Intl.PluralRules(locale);
    const tallies = new Map<string, Map<number, number>>();
    let outOfRange = false;
    for (let n = 0; n <= 200; n++) {
      const index = evaluatePlural(node, n);
      if (!Number.isInteger(index) || index < 0 || index >= nplurals) { outOfRange = true; continue; }
      const category = rules.select(n);
      const tally = tallies.get(category) ?? new Map<number, number>();
      tally.set(index, (tally.get(index) ?? 0) + 1);
      tallies.set(category, tally);
    }
    if (outOfRange) warnings.push(warning('PO_PLURAL_FORMS_INVALID', `Plural-Forms for ${locale} selects a form outside nplurals=${nplurals}.`, 'Check nplurals and the plural expression in the Plural-Forms header.'));
    // CLDR order, so the converted message is the same on every ICU version (Node 22 lists categories differently).
    const order = ['zero', 'one', 'two', 'few', 'many', 'other'];
    const categories = [...rules.resolvedOptions().pluralCategories].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return categories.map((category): [string, number] => {
      const ranked = [...(tallies.get(category) ?? new Map<number, number>())].sort(([ia, ca], [ib, cb]) => cb - ca || ia - ib);
      if (ranked.length > 1) warnings.push(warning('PO_PLURAL_MAPPING', `Plural category ${category} for ${locale} maps to several msgstr forms (${ranked.map(([index]) => index).join(', ')}); using form ${ranked[0]![0]}.`, 'Check the Plural-Forms header.'));
      return [category, ranked[0]?.[0] ?? nplurals - 1];
    });
  } catch (error) {
    warnings.push(warning('PO_PLURAL_FORMS_INVALID', `Cannot evaluate Plural-Forms for ${locale}: ${(error as Error).message}.`, 'Only n, integers, parentheses, ?:, comparisons, &&, ||, !, + - * / % are supported.'));
    return undefined;
  }
}

function once<T>(compute: () => T): () => T {
  let done = false, value!: T;
  return () => {
    if (!done) { value = compute(); done = true; }
    return value;
  };
}

/** Shared PO and Jed rules: gettext forms are indexed as msgstr[]; an empty form is untranslated. */
/** IDs whose warnings are reported once per catalog. */
interface GettextTally { untranslated: string[]; fuzzy: string[]; dotted: string[]; obsolete: string[]; sourceIds: string[] }

const newTally = (): GettextTally => ({ untranslated: [], fuzzy: [], dotted: [], obsolete: [], sourceIds: [] });

function gettextTallyWarnings(tally: GettextTally, warnings: Diagnostic[]): void {
  const plural = (count: number, noun: string, suffix = 's'): string => `${count} ${noun}${count === 1 ? (suffix === 's' ? '' : 'y') : suffix}`;
  if (tally.fuzzy.length) warnings.push(grouped('PO_FUZZY_SKIPPED', tally.fuzzy, (count, examples) => `Skipped ${plural(count, 'fuzzy translation')}${examples}.`, 'Review the translations and remove the fuzzy flag before migrating them.'));
  if (tally.untranslated.length) warnings.push(grouped('PO_UNTRANSLATED_SKIPPED', tally.untranslated, (count, examples) => `Skipped ${plural(count, 'untranslated message')}${examples}.`, 'They fall back to the base locale. Translate them before migrating, or after.'));
  if (tally.obsolete.length) warnings.push(grouped('LINGUI_OBSOLETE_INCLUDED', tally.obsolete, (count, examples) => `Migrated ${plural(count, 'obsolete (#~) entr', 'ies')}, which Lingui 3 compiles and renders${examples}.`, 'Run nordbeam-locale prune after the source migration to find the ones no code uses.'));
  if (tally.sourceIds.length) warnings.push(linguiSourceIdWarning(tally.sourceIds));
  if (tally.dotted.length) {
    // Show how one ID nests, an awkward one when there is one: that is what the warning is about.
    const sample = tally.dotted.find(id => id.split('.').some(segment => !segment || segment !== segment.trim())) ?? tally.dotted[0]!;
    warnings.push(grouped('DOTTED_SOURCE_ID', tally.dotted, (count, examples) => `${plural(count, 'message ID')} ${count === 1 ? 'contains' : 'contain'} "." and ${count === 1 ? 'migrates' : 'migrate'} as nested keys${examples}; ${JSON.stringify(sample)} nests as ${sample.split('.').map(segment => JSON.stringify(segment)).join(' > ')}.`,
      'Expected for keyed IDs. For source sentences, use --message-id-map or keyed IDs so a sentence stays one message.'));
  }
}

function gettextMessage(id: string, forms: string[], plural: boolean, plan: () => PluralPlan | undefined, warnings: Diagnostic[], tally: GettextTally): string | undefined {
  if (!plural) {
    if (forms[0]) return normalizePrintf(forms[0], id, warnings);
    tally.untranslated.push(id);
    return undefined;
  }
  const variants: PluralPlan = plan() ?? [['one', 0], ['other', Math.max(forms.length - 1, 0)]];
  if (variants.some(([, index]) => !forms[index])) {
    warnings.push(warning('PO_UNTRANSLATED_SKIPPED', `Skipped ${JSON.stringify(id)} because a plural form is untranslated.`, 'Translate every plural form before migrating it.'));
    return undefined;
  }
  const branches = variants.map(([category, index]) => {
    const branchWarnings: Diagnostic[] = [];
    const text = normalizePrintf(forms[index]!, id, branchWarnings, true);
    for (const item of branchWarnings) if (!warnings.some(existing => existing.message === item.message)) warnings.push(item);
    return `${category} {${text}}`;
  });
  return `{count, plural, ${branches.join(' ')}}`;
}

/** Dotted IDs are split into nested keys by the migrator, which can turn a sentence into a tree.
 * One that cannot nest as written (`"Try again."`) is renamed and reported as MIGRATION_ID_RENAMED. */
function dottedId(id: string, tally: GettextTally): void {
  if (id.includes('.')) tally.dotted.push(id);
}

const headerValue = (headers: Record<string, string> | undefined, name: string): string | undefined => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

// gettext-parser 8 takes an options object here; @types/gettext-parser still declares a charset string, which the parser ignores.
const parsePo = gettext.po.parse as unknown as (buffer: Buffer, options: { defaultCharset: string }) => ReturnType<typeof gettext.po.parse>;

/** Lingui writes `X-Generator: @lingui/cli` in the PO header. */
const linguiGeneratedPo = (text: string): boolean => /^"X-Generator: @lingui\/cli\\n"\r?$/m.test(text);

/** Lingui's PO reader keeps a line's text between its first and last quote, so catalogs it
 * wrote can hold unescaped quotes (`msgstr "Read the "FAQ""`), which gettext-parser rejects. */
function repairLinguiQuotes(text: string): { text: string; lines: number } {
  let lines = 0;
  const repaired = text.split('\n').map(line => {
    const match = /^((?:#~ )?(?:msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+|(?:#~ )?)"(.*)"(\r?)$/.exec(line);
    if (!match) return line;
    const inner = match[2]!.replace(/(?<!\\)((?:\\\\)*)"/g, (_, slashes: string) => `${slashes}\\"`);
    if (inner === match[2]) return line;
    lines++;
    return `${match[1]}"${inner}"${match[3]}`;
  }).join('\n');
  return { text: repaired, lines };
}

/** Comments a translator or developer wrote become notes; references and flags are regenerated by extraction. */
function gettextNote(comments: { translator?: string; extracted?: string } | undefined): string | undefined {
  const note = [comments?.extracted, comments?.translator].map(text => text?.trim()).filter(Boolean).join('\n');
  return note || undefined;
}

function gettextCatalog(buffer: Buffer, format: 'po' | 'pot' | 'mo' | 'lingui-po', locale: string | undefined, warnings: Diagnostic[], notes: Record<string, string>, options: { sourceLocale?: boolean }): Record<string, unknown> {
  // Lingui catalogs hold ICU, not printf text, and need Lingui's reading of them (see lingui-messages.ts).
  const text = format === 'mo' ? '' : buffer.toString('utf8');
  const linguiPo = format === 'lingui-po' || (format === 'po' && linguiGeneratedPo(text));
  let input = buffer;
  if (linguiPo) {
    const repaired = repairLinguiQuotes(text);
    if (repaired.lines) {
      input = Buffer.from(repaired.text);
      warnings.push(warning('LINGUI_PO_QUOTES', `Read ${repaired.lines} PO line${repaired.lines === 1 ? '' : 's'} with unescaped quotes the way Lingui does, as the text between the first and last quote.`, 'Nothing to do; the migrated catalog holds the text Lingui showed.'));
    }
  }
  // gettext-parser assumes ISO-8859-1 when the header declares no charset; read such files as UTF-8, while a declared charset still wins.
  const parsed = format === 'mo' ? gettext.mo.parse(buffer, 'utf-8') : parsePo(input, { defaultCharset: 'utf-8' });
  const plan = once(() => pluralPlanFromHeader(headerValue(parsed.headers, 'plural-forms'), headerValue(parsed.headers, 'language') ?? locale, warnings));
  const output: Record<string, unknown> = Object.create(null);
  const tally = newTally(), lingui: LinguiTally = { trimmed: [], changed: [] };
  // Lingui 3 compiles obsolete (#~) entries too, and code can still name them.
  const entries = [...Object.entries(parsed.translations).map(([context, messages]) => [context, messages, false] as const),
    ...(linguiPo ? Object.entries((parsed as { obsolete?: typeof parsed.translations }).obsolete ?? {}).map(([context, messages]) => [context, messages, true] as const) : [])];
  for (const [context, messages, obsolete] of entries) for (const [msgid, record] of Object.entries(messages)) {
    if (!msgid) continue;
    const id = context ? `${context}.${msgid}` : msgid;
    if (obsolete && Object.hasOwn(output, id)) continue;
    if (record.comments?.flag?.split(',').some(flag => flag.trim() === 'fuzzy')) { tally.fuzzy.push(id); continue; }
    let message: string | undefined;
    if (linguiPo && record.msgid_plural === undefined && record.msgstr.length <= 1) {
      let source = record.msgstr[0];
      if (!source && options.sourceLocale) { source = msgid; tally.sourceIds.push(id); }
      if (!source) { tally.untranslated.push(id); continue; }
      try { message = linguiConverted(id, decodeLinguiMessage(source), lingui); }
      catch (error) { warnings.push({ ...warning('LINGUI_COMPILED_ENTRY', `Could not read Lingui message ${JSON.stringify(id)} (${(error as Error).message}); it was not migrated.`, 'Correct the message in the Lingui catalog, or migrate it by hand.'), messageId: id }); continue; }
    } else message = gettextMessage(id, record.msgstr, record.msgid_plural !== undefined || record.msgstr.length > 1, plan, warnings, tally);
    if (message === undefined) continue;
    output[id] = message;
    if (obsolete) tally.obsolete.push(id);
    dottedId(id, tally);
    const note = gettextNote(record.comments);
    if (note) notes[id] = note;
  }
  linguiTallyWarnings(lingui, warnings);
  gettextTallyWarnings(tally, warnings);
  return output;
}

function jsonGettext(value: unknown, locale: string | undefined, warnings: Diagnostic[]): Record<string, unknown> {
  if (!object(value)) throw new TypeError('Jed/json-gettext input must be an object.');
  const localeData = object(value.locale_data) ? value.locale_data : value;
  const domain = Object.values(localeData).find(object);
  if (!domain) return {};
  const meta = domain[''], header = object(meta) ? meta : {};
  const stringOf = (item: unknown): string | undefined => typeof item === 'string' ? item : undefined;
  const plan = once(() => pluralPlanFromHeader(stringOf(header.plural_forms) ?? stringOf(header['Plural-Forms']), stringOf(header.lang) ?? locale, warnings));
  const output: Record<string, unknown> = Object.create(null);
  const tally = newTally();
  for (const [id, entry] of Object.entries(domain)) {
    if (!id || !Array.isArray(entry)) continue;
    // Jed keeps a msgid_plural (or null) before the msgstr forms; a lone entry is already the translation.
    const plural = entry.length > 2 || (entry.length === 2 && typeof entry[0] === 'string' && entry[0] !== '');
    const forms = (entry.length > 1 ? entry.slice(1) : entry).map(item => typeof item === 'string' ? item : '');
    const message = gettextMessage(id, forms, plural, plan, warnings, tally);
    if (message !== undefined) { output[id] = message; dottedId(id, tally); }
  }
  gettextTallyWarnings(tally, warnings);
  return output;
}

/** The object a dictionary module exports, without running it: TypeScript wrappers
 * (`as const`, `satisfies`, `<T>`) are looked through, and an exported name is followed
 * to its top-level `const`. */
function exportedObject(program: Statement[]): ObjectExpression {
  const unwrap = (node: Node | null | undefined): Node | null | undefined => {
    while (node && (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSTypeAssertion'
      || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression')) node = node.expression;
    return node;
  };
  const declared = (name: string): Node | null | undefined => {
    for (const statement of program) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type !== 'VariableDeclaration') continue;
      for (const item of declaration.declarations) if (item.id.type === 'Identifier' && item.id.name === name) return unwrap(item.init);
    }
  };
  const object = (node: Node | null | undefined): ObjectExpression | undefined => {
    const value = unwrap(node);
    if (value?.type === 'ObjectExpression') return value;
    if (value?.type === 'Identifier') { const target = declared(value.name); if (target?.type === 'ObjectExpression') return target; }
  };
  const candidates: (ObjectExpression | undefined)[] = [];
  for (const statement of program) {
    if (statement.type === 'ExportDefaultDeclaration') return object(statement.declaration as Node) ?? fail();
    if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression'
      && statement.expression.left.type === 'MemberExpression' && statement.expression.left.object.type === 'Identifier'
      && statement.expression.left.object.name === 'module' && statement.expression.left.property.type === 'Identifier'
      && statement.expression.left.property.name === 'exports') return object(statement.expression.right) ?? fail();
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration') {
      for (const item of statement.declaration.declarations) candidates.push(object(item.init));
    }
  }
  const found = candidates.filter(Boolean);
  if (found.length === 1) return found[0]!;
  return fail();
  function fail(): never {
    throw new TypeError('A dictionary module must export one object literal of strings, as its default export or its only exported const.');
  }
}

/** Comments directly above a property, or after it on its line, become its note. */
function commentNote(comments: readonly Comment[]): string | undefined {
  const text = comments.map(comment => comment.type === 'CommentLine' ? comment.value.trim()
    : comment.value.split('\n').map(line => line.replace(/^\s*\*?\s?/, '').trimEnd()).join('\n').trim()).filter(Boolean).join('\n');
  return text || undefined;
}

/** A JavaScript or TypeScript dictionary module, read statically: nothing in it runs.
 * Values must be string literals, template literals without substitutions, `+`
 * concatenations of those, or nested object literals. */
function dictionaryModule(text: string, file: string, warnings: Diagnostic[]): { value: Record<string, unknown>; notes: Record<string, string> } {
  const extension = extname(file).toLowerCase();
  const typescript = ['.ts', '.mts', '.cts', '.tsx'].includes(extension);
  let program: Statement[];
  try {
    program = parseModule(text, { sourceType: 'unambiguous', plugins: typescript ? ['typescript', ...(extension === '.tsx' ? ['jsx' as const] : [])] : ['jsx'] }).program.body;
  } catch (error) { throw new SyntaxError(`Invalid module ${file}: ${(error as Error).message}`); }
  const notes: Record<string, string> = Object.create(null);
  const literal = (node: Expression): string | undefined => {
    if (node.type === 'StringLiteral') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('');
    if (node.type === 'BinaryExpression' && node.operator === '+' && node.left.type !== 'PrivateName') {
      const left = literal(node.left), right = literal(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression') return literal(node.expression);
  };
  const convert = (object: ObjectExpression, path: string[]): Record<string, unknown> => {
    const output: Record<string, unknown> = Object.create(null);
    // Babel can give one comment to two neighbours, and gives `a: 'x', // note` to the
    // property after it. A comment belongs to the property that ends on its line, or
    // else to the property below it.
    const owned = object.properties.map(() => new Set<Comment>());
    object.properties.forEach((property, index) => {
      for (const comment of [...property.leadingComments ?? [], ...property.trailingComments ?? []]) {
        const line = comment.loc?.start.line;
        const owner = object.properties.findIndex(item => item.loc?.end.line === line && (item.loc?.end.index ?? 0) <= (comment.loc?.start.index ?? 0));
        if (owner >= 0) owned[owner]!.add(comment);
        else if (comment.loc && property.loc && comment.loc.end.index <= property.loc.start.index) owned[index]!.add(comment);
      }
    });
    object.properties.forEach((property, index) => {
      const key = property.type === 'ObjectProperty' && !property.computed
        ? property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' || property.key.type === 'NumericLiteral' ? String(property.key.value) : undefined
        : undefined;
      if (property.type !== 'ObjectProperty' || key === undefined) {
        warnings.push(warning('MIGRATION_UNSUPPORTED_VALUE', `Skipped ${property.type === 'SpreadElement' ? 'a spread' : 'a computed or method property'} in ${JSON.stringify(path.join('.') || 'the dictionary')}.`, 'Write the messages out as literal properties.'));
        return;
      }
      const id = [...path, key].join('.');
      const note = commentNote([...owned[index]!].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)));
      const value = property.value as Expression;
      const inner = value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression' ? value.expression : value;
      if (inner.type === 'ObjectExpression') { output[key] = convert(inner, [...path, key]); if (note) notes[id] = note; return; }
      const string = literal(value);
      if (string === undefined) {
        warnings.push(warning('MIGRATION_UNSUPPORTED_VALUE', `Skipped ${JSON.stringify(id)}: its value is computed, not a string literal.`, 'Write the message as a string literal, or add it to the catalog by hand.'));
        return;
      }
      output[key] = string;
      if (note) notes[id] = note;
    });
    return output;
  };
  return { value: convert(exportedObject(program), []), notes };
}

/** i18next-style `<locale>/<namespace>.json` folders: each file becomes a top-level key, so `common.json` > `hi` migrates to `common.hi`.
 * A folder holding only the default `translation` namespace stays unprefixed, as i18next calls without a namespace expect. */
async function namespaceFolder(directory: string, format: MigrationFormat): Promise<DecodedCatalog> {
  if (format !== 'i18next' && format !== 'vue-i18n' && format !== 'next-intl' && format !== 'formatjs') {
    throw new TypeError(`${directory} is a directory; --format ${format} migrates one catalog file at a time. Only the JSON formats (i18next, vue-i18n, next-intl, formatjs) accept a <locale> folder of <namespace>.json files.`);
  }
  const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
    .map(entry => entry.name).sort();
  if (!files.length) throw new TypeError(`${directory} contains no <namespace>.json files.`);
  const value: Record<string, unknown> = Object.create(null);
  for (const name of files) {
    const namespace = basename(name, extname(name)), parsed = json(await readFile(join(directory, name)), join(directory, name));
    if (!object(parsed)) throw new TypeError(`${format} input must be a JSON object: ${join(directory, name)}`);
    value[namespace] = parsed;
  }
  return { value: files.length === 1 && Object.hasOwn(value, 'translation') ? value.translation as Record<string, unknown> : value, traversal: format, warnings: [] };
}

/** `sourceLocale`: the catalog is the base locale's, where Lingui renders an untranslated message's ID. */
export async function decodeMigrationCatalog(file: string, format: MigrationFormat, locale?: string, options: { sourceLocale?: boolean } = {}): Promise<DecodedCatalog> {
  const absolute = resolve(file), warnings: Diagnostic[] = [];
  if ((await stat(absolute)).isDirectory()) return namespaceFolder(absolute, format);
  const buffer = await readFile(absolute);
  if (format === 'module') {
    const { value, notes } = dictionaryModule(buffer.toString('utf8'), absolute, warnings);
    return { value, traversal: 'next-intl', warnings, notes };
  }
  if (format === 'yaml') {
    const value = parseYaml(buffer.toString('utf8')) as unknown;
    if (!object(value)) throw new TypeError('YAML catalog must contain a mapping.');
    return { value, traversal: 'next-intl', warnings };
  }
  if (format === 'android-xml') return { value: androidXml(buffer.toString('utf8'), warnings), traversal: 'next-intl', warnings };
  if (format === 'apple-strings') return { value: appleStrings(buffer.toString('utf8'), warnings), traversal: 'next-intl', warnings };
  if (format === 'po' || format === 'pot' || format === 'mo' || format === 'lingui-po') {
    const notes: Record<string, string> = Object.create(null);
    return { value: gettextCatalog(buffer, format, locale, warnings, notes, options), traversal: 'next-intl', warnings, notes };
  }
  const value = json(buffer, absolute);
  if (format === 'arb') { const notes: Record<string, string> = Object.create(null); return { value: arb(value, warnings, notes), traversal: 'next-intl', warnings, notes }; }
  if (format === 'lingui') return { value: lingui(value, warnings), traversal: 'next-intl', warnings };
  if (format === 'tolgee') return { value: tolgee(value, locale, warnings), traversal: 'next-intl', warnings };
  if (format === 'apple-xcstrings') return { value: xcstrings(value, locale, warnings), traversal: 'next-intl', warnings };
  if (format === 'json-gettext') return { value: jsonGettext(value, locale, warnings), traversal: 'next-intl', warnings };
  if (!object(value)) throw new TypeError(`${format} input must be a JSON object.`);
  return { value, traversal: format, warnings };
}

export function inferMigrationFormat(file: string): MigrationFormat | undefined {
  const extension = extname(file).toLowerCase();
  return extension === '.arb' ? 'arb' : extension === '.yaml' || extension === '.yml' ? 'yaml'
    : extension === '.xml' ? 'android-xml' : extension === '.strings' ? 'apple-strings'
    : extension === '.xcstrings' ? 'apple-xcstrings' : extension === '.po' ? 'po'
    : extension === '.pot' ? 'pot' : extension === '.mo' ? 'mo'
    : ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].includes(extension) ? 'module' : undefined;
}
