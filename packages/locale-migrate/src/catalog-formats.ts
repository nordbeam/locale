import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parse as parseModule } from '@babel/parser';
import type { Comment, Expression, Node, ObjectExpression, Statement } from '@babel/types';
import { XMLParser } from 'fast-xml-parser';
import gettext from 'gettext-parser';
import { parse as parseYaml } from 'yaml';
import type { Diagnostic } from '@nordbeam/locale/internal/migrate';

export type MigrationFormat = 'i18next' | 'vue-i18n' | 'next-intl' | 'formatjs' | 'lingui' | 'tolgee'
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

/** Escape literal text for ICU; inside a plural branch a bare # would be the count. */
function icuText(text: string, inPlural: boolean): string {
  return text.replace(/'/g, "''").replace(/[{}]/g, brace => `'${brace}'`).replace(/#/g, inPlural ? "'#'" : '#');
}

/** Lingui compiled arrays: strings are literals, [name] is an argument, [name, type, options] is a typed argument. */
function linguiCompiled(parts: unknown, inPlural = false): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  let text = '';
  for (const part of parts) {
    if (typeof part === 'string') { text += icuText(part, inPlural); continue; }
    if (!Array.isArray(part) || typeof part[0] !== 'string') return undefined;
    const argument = linguiArgument(part, inPlural);
    if (argument === undefined) return undefined;
    text += argument;
  }
  return text;
}

function linguiArgument(part: unknown[], inPlural: boolean): string | undefined {
  const [name, type, options] = part;
  if (typeof name !== 'string' || !name || /[\s{}#'|,:]/.test(name)) return name === '#' && inPlural ? '#' : undefined;
  if (part.length === 1) return `{${name}}`;
  if (type === 'number' || type === 'date' || type === 'time') {
    if (part.length === 2) return `{${name}, ${type}}`;
    return part.length === 3 && typeof options === 'string' && !/[{}',]/.test(options) ? `{${name}, ${type}, ${options}}` : undefined;
  }
  if ((type === 'plural' || type === 'selectordinal' || type === 'select') && part.length === 3 && object(options)) {
    const pluralBranches = type !== 'select';
    const cases: string[] = [];
    if (pluralBranches && options.offset !== undefined) {
      if (typeof options.offset !== 'number' || !Number.isInteger(options.offset)) return undefined;
      cases.push(`offset:${options.offset}`);
    }
    for (const [key, branch] of Object.entries(options)) {
      if (key === 'offset' && pluralBranches) continue;
      if (!/^(=\d+|[a-z]+)$/.test(key)) return undefined;
      const body = linguiCompiled(branch, inPlural || pluralBranches);
      if (body === undefined) return undefined;
      cases.push(`${key} {${body}}`);
    }
    return cases.length ? `{${name}, ${type}, ${cases.join(' ')}}` : undefined;
  }
  return undefined;
}

function lingui(value: unknown, warnings: Diagnostic[]): Record<string, unknown> {
  if (!object(value)) throw new TypeError('Lingui JSON input must be an object.');
  const output: Record<string, unknown> = Object.create(null);
  for (const [id, item] of Object.entries(value)) {
    const source = object(item) ? item.translation ?? item.message : item;
    const message = typeof source === 'string' ? source : Array.isArray(source) ? linguiCompiled(source) : undefined;
    if (message !== undefined) output[id] = message;
    else warnings.push(warning('LINGUI_COMPILED_ENTRY', `Could not convert Lingui entry ${JSON.stringify(id)}; it was not migrated.`, 'Only string, [name], number/date/time, plural, selectordinal and select compiled forms are converted. Recompile with ICU messages or migrate this entry by hand.'));
    if (object(item)) {
      const metadata = Object.keys(item).filter(key => !['translation', 'message'].includes(key));
      if (metadata.length) warnings.push(warning('MIGRATION_METADATA_DROPPED', `Dropped Lingui metadata for ${JSON.stringify(id)} (${metadata.join(', ')}).`));
    }
  }
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
function gettextMessage(id: string, forms: string[], plural: boolean, plan: () => PluralPlan | undefined, warnings: Diagnostic[]): string | undefined {
  if (!plural) {
    if (forms[0]) return normalizePrintf(forms[0], id, warnings);
    warnings.push(warning('PO_UNTRANSLATED_SKIPPED', `Skipped untranslated ${JSON.stringify(id)}.`, 'Translate the entry before migrating it.'));
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

/** Dotted IDs are split into nested keys by the migrator, which can turn a sentence into a tree. */
function dottedId(id: string, warnings: Diagnostic[]): void {
  if (!id.includes('.')) return;
  const segments = id.split('.');
  const edges = segments.filter(segment => !segment || segment !== segment.trim());
  warnings.push(warning('DOTTED_SOURCE_ID', `Message ID ${JSON.stringify(id)} contains "." and migrates as nested keys ${segments.map(segment => JSON.stringify(segment)).join(' > ')}${edges.length ? ` (awkward segments: ${edges.map(segment => JSON.stringify(segment)).join(', ')})` : ''}.`, 'Use --message-id-map or keyed IDs so a source sentence stays one message.'));
}

const headerValue = (headers: Record<string, string> | undefined, name: string): string | undefined => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

// gettext-parser 8 takes an options object here; @types/gettext-parser still declares a charset string, which the parser ignores.
const parsePo = gettext.po.parse as unknown as (buffer: Buffer, options: { defaultCharset: string }) => ReturnType<typeof gettext.po.parse>;

function gettextCatalog(buffer: Buffer, format: 'po' | 'pot' | 'mo', locale: string | undefined, warnings: Diagnostic[]): Record<string, unknown> {
  // gettext-parser assumes ISO-8859-1 when the header declares no charset; read such files as UTF-8, while a declared charset still wins.
  const parsed = format === 'mo' ? gettext.mo.parse(buffer, 'utf-8') : parsePo(buffer, { defaultCharset: 'utf-8' });
  const plan = once(() => pluralPlanFromHeader(headerValue(parsed.headers, 'plural-forms'), headerValue(parsed.headers, 'language') ?? locale, warnings));
  const output: Record<string, unknown> = Object.create(null);
  for (const [context, messages] of Object.entries(parsed.translations)) for (const [msgid, record] of Object.entries(messages)) {
    if (!msgid) continue;
    const id = context ? `${context}.${msgid}` : msgid;
    if (record.comments?.flag?.split(',').some(flag => flag.trim() === 'fuzzy')) {
      warnings.push(warning('PO_FUZZY_SKIPPED', `Skipped fuzzy translation ${JSON.stringify(id)}.`, 'Review the translation and remove the fuzzy flag before migrating it.'));
      continue;
    }
    const message = gettextMessage(id, record.msgstr, record.msgid_plural !== undefined || record.msgstr.length > 1, plan, warnings);
    if (message !== undefined) { output[id] = message; dottedId(id, warnings); }
    if (record.comments && Object.keys(record.comments).some(key => key !== 'flag')) warnings.push(warning('MIGRATION_METADATA_DROPPED', `Dropped gettext comments for ${JSON.stringify(id)}.`));
  }
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
  for (const [id, entry] of Object.entries(domain)) {
    if (!id || !Array.isArray(entry)) continue;
    // Jed keeps a msgid_plural (or null) before the msgstr forms; a lone entry is already the translation.
    const plural = entry.length > 2 || (entry.length === 2 && typeof entry[0] === 'string' && entry[0] !== '');
    const forms = (entry.length > 1 ? entry.slice(1) : entry).map(item => typeof item === 'string' ? item : '');
    const message = gettextMessage(id, forms, plural, plan, warnings);
    if (message !== undefined) { output[id] = message; dottedId(id, warnings); }
  }
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

export async function decodeMigrationCatalog(file: string, format: MigrationFormat, locale?: string): Promise<DecodedCatalog> {
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
  if (format === 'po' || format === 'pot' || format === 'mo') return { value: gettextCatalog(buffer, format, locale, warnings), traversal: 'next-intl', warnings };
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
