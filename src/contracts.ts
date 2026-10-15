import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import type { Catalog } from './compiler.js';
import { CompileError, describeIcuError } from './diagnostics.js';

export type ContractArgumentKind = 'value' | 'number' | 'date' | 'select' | 'slot';

export interface MessageArgumentContract {
  readonly kind: ContractArgumentKind;
  /** Select branch names excluding the required `other` fallback. */
  readonly choices: readonly string[];
}

export interface MessageBranchContract {
  readonly kind: 'plural' | 'select';
  readonly argument: string;
  /** Enclosing branch path, encoded as stable `kind:argument=value` parts. */
  readonly path: readonly string[];
  /** All branch names, including the required `other` fallback. */
  readonly choices: readonly string[];
  /** Set on plural branches: `selectordinal` is `ordinal`, `plural` is `cardinal`. */
  readonly pluralType?: 'cardinal' | 'ordinal';
}

/** The source contract of one ICU message. `hash` excludes the source text. */
export interface MessageContract {
  readonly id: string;
  readonly source: string;
  readonly arguments: Readonly<Record<string, MessageArgumentContract>>;
  readonly branches: readonly MessageBranchContract[];
  readonly slots: readonly string[];
  readonly hash: string;
}

export interface DescribedMessage extends MessageContract {
  readonly locale: string;
}

export interface DescribeCatalogOptions {
  readonly catalogs?: Readonly<Record<string, Catalog>>;
  /** Convenience form for describing one catalog without a locale map. */
  readonly catalog?: Catalog;
  readonly baseLocale?: string;
  readonly locale?: string;
}

export interface CatalogDescription {
  readonly baseLocale?: string;
  readonly locales: readonly string[];
  /** Stable locale/ID order, useful for streaming a catalog to a worker. */
  readonly messages: readonly DescribedMessage[];
  readonly byLocale: Readonly<Record<string, readonly MessageContract[]>>;
  /** Base-locale contracts keyed by message ID, when `baseLocale` is known. */
  readonly contracts: Readonly<Record<string, MessageContract>>;
  readonly hash: string;
}

export interface ContractDiagnostic {
  readonly code: string;
  /** Warnings still render; errors fail `check`. */
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly messageId?: string;
  readonly locale?: string;
  readonly argument?: string;
  readonly branch?: string;
  readonly kind?: ContractArgumentKind;
  /** Rich-text tag names dropped by the translation. */
  readonly tags?: readonly string[];
  /** CLDR plural categories the locale requires but the message does not branch on. */
  readonly categories?: readonly string[];
  readonly hint?: string;
}

export interface CompareContractOptions {
  readonly source: string | MessageContract;
  readonly translation: string | MessageContract;
  readonly id?: string;
  /** Locale of the translation; enables the plural category check on it. */
  readonly locale?: string;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

const warningCodes = new Set(['DROPPED_RICH_TAG', 'MISSING_PLURAL_CATEGORY']);

const pluralCategoryCache = new Map<string, readonly string[] | null>();

/** CLDR category order. Older ICU versions (Node 22) list `pluralCategories` in a different order. */
const cldrPluralOrder = ['zero', 'one', 'two', 'few', 'many', 'other'];

/**
 * CLDR categories that a count from 0 to 999 can select, or null when Intl does not support the locale.
 * Large-only categories, such as French `many` at 1000000, are left out so `one`/`other` stays complete.
 * Cached per locale and type.
 */
export function pluralCategories(locale: string, type: 'cardinal' | 'ordinal'): readonly string[] | null {
  const key = `${type}\0${locale}`;
  let categories = pluralCategoryCache.get(key);
  if (categories === undefined) {
    try {
      if (!Intl.PluralRules.supportedLocalesOf(locale).length) categories = null;
      else {
        const rules = new Intl.PluralRules(locale, { type });
        const reachable = new Set(Array.from({ length: 1000 }, (_, n) => rules.select(n)));
        categories = rules.resolvedOptions().pluralCategories.filter(category => reachable.has(category))
          .sort((a, b) => cldrPluralOrder.indexOf(a) - cldrPluralOrder.indexOf(b));
      }
    } catch { categories = null; }
    pluralCategoryCache.set(key, categories);
  }
  return categories;
}

/** Small deterministic non-cryptographic hash for contract identity. */
function stableHash(value: string): string {
  let hash = 14695981039346656037n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`;
}

function contractKey(contract: Pick<MessageContract, 'arguments' | 'branches' | 'slots'>): string {
  const args = Object.keys(contract.arguments).sort(compare).map(name => [name, contract.arguments[name]!.kind, [...contract.arguments[name]!.choices].sort(compare)]);
  const branches = [...contract.branches].map(branch => ({
    kind: branch.kind,
    argument: branch.argument,
    path: [...branch.path],
    choices: [...branch.choices].sort(compare),
  })).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return JSON.stringify({ arguments: args, branches, slots: [...contract.slots].sort(compare) });
}

function contractError(code: string, message: string, context: Partial<ContractDiagnostic> = {}): never {
  throw new CompileError([{ code, message, messageId: context.messageId }]);
}

function mergeArgument(target: Map<string, MessageArgumentContract>, name: string, kind: ContractArgumentKind, choices: readonly string[], id: string): void {
  const previous = target.get(name);
  if (!previous) {
    target.set(name, { kind, choices: [...new Set(choices)].sort(compare) });
    return;
  }
  if ((previous.kind === 'slot' || kind === 'slot') && previous.kind !== kind) {
    contractError('ARGUMENT_TYPE_CONFLICT', `Message ${JSON.stringify(id)} uses ${JSON.stringify(name)} as both a rich-text slot and a value.`);
  }
  let merged = previous.kind;
  if (previous.kind === 'value') merged = kind;
  else if (kind !== 'value' && kind !== previous.kind) {
    contractError('ARGUMENT_TYPE_CONFLICT', `Message ${JSON.stringify(id)} uses ${JSON.stringify(name)} as both ${previous.kind} and ${kind}.`);
  }
  target.set(name, { kind: merged, choices: [...new Set([...previous.choices, ...choices])].sort(compare) });
}

function parseContract(source: string, id = ''): MessageContract {
  if (typeof source !== 'string') throw new TypeError('Message source must be a string.');
  let ast: MessageFormatElement[];
  try { ast = parse(source, { captureLocation: true, shouldParseSkeletons: true }); }
  catch (error) {
    const e = error as Error & { location?: { start?: { line: number; column: number; offset: number } } };
    const description = describeIcuError(e.message);
    throw new CompileError([{ code: 'INVALID_ICU', message: description.message, reason: description.reason, hint: description.hint, messageId: id, source, ...e.location?.start }]);
  }
  const argumentsMap = new Map<string, MessageArgumentContract>();
  const branches: MessageBranchContract[] = [];
  const slots = new Set<string>();
  const visit = (nodes: readonly MessageFormatElement[], path: readonly string[]): void => {
    for (const node of nodes) {
      if (node.type === TYPE.literal || node.type === TYPE.pound) continue;
      if (node.type === TYPE.tag) {
        mergeArgument(argumentsMap, node.value, 'slot', [], id);
        slots.add(node.value);
        visit(node.children, path);
        continue;
      }
      const kind: ContractArgumentKind = node.type === TYPE.number || node.type === TYPE.plural ? 'number'
        : node.type === TYPE.date || node.type === TYPE.time ? 'date'
        : node.type === TYPE.select ? 'select' : 'value';
      const choices = node.type === TYPE.select ? Object.keys(node.options).filter(choice => choice !== 'other') : [];
      mergeArgument(argumentsMap, node.value, kind, choices, id);
      if (node.type === TYPE.select || node.type === TYPE.plural) {
        const branchChoices = Object.keys(node.options).sort(compare);
        branches.push({ kind: node.type === TYPE.select ? 'select' : 'plural', argument: node.value, path: [...path], choices: branchChoices, ...node.type === TYPE.plural ? { pluralType: node.pluralType } : {} });
        for (const choice of branchChoices) visit(node.options[choice]!.value, [...path, `${node.type === TYPE.select ? 'select' : 'plural'}:${node.value}=${choice}`]);
      }
    }
  };
  visit(ast, []);
  const args = Object.fromEntries([...argumentsMap].sort(([a], [b]) => compare(a, b)).map(([name, value]) => [name, Object.freeze({ kind: value.kind, choices: Object.freeze([...value.choices]) })]));
  const normalizedBranches = Object.freeze(branches.map(branch => Object.freeze({ ...branch, path: Object.freeze([...branch.path]), choices: Object.freeze([...branch.choices]) })));
  const normalized = { id, source, arguments: args, branches: normalizedBranches, slots: Object.freeze([...slots].sort(compare)) } as Omit<MessageContract, 'hash'>;
  return Object.freeze({ ...normalized, hash: stableHash(contractKey(normalized)) });
}

function flattenCatalog(catalog: Catalog, locale: string): Array<{ id: string; source: string }> {
  const result: Array<{ id: string; source: string }> = [];
  const ancestors = new Set<object>();
  const seen = new Set<string>();
  const visit = (value: unknown, prefix: string): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Expected an object containing strings or nested catalogs.', locale, messageId: prefix }]);
    if (ancestors.has(value)) throw new CompileError([{ code: 'INVALID_CATALOG', message: 'Catalog contains a circular reference.', locale, messageId: prefix }]);
    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (!key) throw new CompileError([{ code: 'INVALID_KEY', message: 'Message keys must not be empty.', locale, messageId: prefix }]);
      const id = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === 'string') {
        if (seen.has(id)) throw new CompileError([{ code: 'DUPLICATE_KEY', message: `Nested and flat keys both resolve to ${JSON.stringify(id)}.`, locale, messageId: id }]);
        seen.add(id); result.push({ id, source: entry });
      } else visit(entry, id);
    }
    ancestors.delete(value);
  };
  visit(catalog, '');
  return result.sort((a, b) => compare(a.id, b.id));
}

function messageContract(value: string | MessageContract, id?: string): MessageContract {
  if (typeof value === 'string') return parseContract(value, id ?? '');
  if (!value || typeof value !== 'object' || typeof value.source !== 'string' || !value.arguments || !Array.isArray(value.branches) || !Array.isArray(value.slots)) {
    throw new TypeError('Expected a message source or MessageContract.');
  }
  const normalized = {
    id: id ?? value.id ?? '',
    source: value.source,
    arguments: value.arguments,
    branches: value.branches,
    slots: value.slots,
  } as Omit<MessageContract, 'hash'>;
  return { ...normalized, hash: value.hash || stableHash(contractKey(normalized)) };
}

/** Describe all in-memory locale catalogs with deterministic per-message contracts. */
export function describeCatalog(options: DescribeCatalogOptions): CatalogDescription;
export function describeCatalog(catalog: Catalog, locale?: string): CatalogDescription;
export function describeCatalog(optionsOrCatalog: DescribeCatalogOptions | Catalog, directLocale?: string): CatalogDescription {
  const options = ('catalogs' in (optionsOrCatalog as object) || 'catalog' in (optionsOrCatalog as object))
    ? optionsOrCatalog as DescribeCatalogOptions
    : { catalog: optionsOrCatalog as Catalog, locale: directLocale };
  const catalogs = options.catalogs ?? (options.catalog ? { [options.locale ?? 'default']: options.catalog } : undefined);
  if (!catalogs || typeof catalogs !== 'object') throw new TypeError('describeCatalog requires an in-memory catalog or catalogs map.');
  const locales = Object.keys(catalogs).sort(compare);
  if (options.baseLocale !== undefined && !Object.hasOwn(catalogs, options.baseLocale)) {
    throw new CompileError([{ code: 'BASE_LOCALE_MISSING', message: `No catalog for base locale ${JSON.stringify(options.baseLocale)}.`, locale: options.baseLocale }]);
  }
  const messages: DescribedMessage[] = [];
  const byLocale: Record<string, readonly MessageContract[]> = Object.create(null);
  for (const locale of locales) {
    const described = flattenCatalog(catalogs[locale]!, locale).map(({ id, source }) => Object.freeze({ locale, ...parseContract(source, id) }));
    messages.push(...described);
    byLocale[locale] = Object.freeze(described.map(({ locale: _locale, ...contract }) => Object.freeze(contract)));
  }
  const base = options.baseLocale ?? (locales.length === 1 ? locales[0] : undefined);
  const contracts: Record<string, MessageContract> = Object.create(null);
  if (base) for (const message of messages) if (message.locale === base) contracts[message.id] = message;
  const hashInput = messages.map(message => `${message.locale}\0${message.id}\0${message.hash}`).join('\n');
  return Object.freeze({ baseLocale: base, locales: Object.freeze(locales), messages: Object.freeze(messages), byLocale: Object.freeze(byLocale), contracts: Object.freeze(contracts), hash: stableHash(hashInput) });
}

function branchIdentity(branch: MessageBranchContract): string {
  return JSON.stringify({ kind: branch.kind, argument: branch.argument, path: branch.path });
}

/** One plural or selectordinal branch's missing-category warning, or undefined when the locale is unsupported or complete. `choices` are the branch keys as written, so exact `=N` keys never satisfy a category. */
export function pluralCategoryDiagnostic(locale: string, branch: Pick<MessageBranchContract, 'argument' | 'path' | 'choices' | 'pluralType'>, messageId?: string): ContractDiagnostic | undefined {
  const type = branch.pluralType ?? 'cardinal';
  const required = pluralCategories(locale, type);
  if (!required) return undefined;
  const missing = required.filter(category => category !== 'other' && !branch.choices.includes(category));
  if (!missing.length) return undefined;
  const label = `${type === 'ordinal' ? 'selectordinal' : 'plural'} ${JSON.stringify(branch.argument)}${branch.path.length ? ` under ${branch.path.join(' / ')}` : ''}`;
  return {
    code: 'MISSING_PLURAL_CATEGORY', severity: 'warning', locale, ...messageId ? { messageId } : {},
    message: `${locale} ${label} has no ${missing.join(', ')} branch.`,
    argument: branch.argument, branch: label, categories: missing,
    hint: `Add ${missing.map(category => `${category} {…}`).join(', ')}. Counts without a matching branch use other.`,
  };
}

/** Warn about plural and selectordinal branches that omit a category the locale requires, such as Arabic `zero` or Polish `few`. Exact `=N` branches do not count. */
export function pluralCategoryDiagnostics(contract: MessageContract, locale: string): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  for (const branch of contract.branches) {
    if (branch.kind !== 'plural') continue;
    const diagnostic = pluralCategoryDiagnostic(locale, branch, contract.id || undefined);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/** Message, hint and tag list for a translation that omits rich-text tags. Tags are sorted by the caller. */
export function droppedTagDiagnostic(tags: readonly string[]): Pick<ContractDiagnostic, 'message' | 'hint' | 'tags'> {
  const one = tags.length === 1;
  return {
    message: `Translation drops rich-text ${one ? 'tag' : 'tags'} ${tags.map(tag => `<${tag}>`).join(', ')}; the text renders without ${one ? 'it' : 'them'}.`,
    hint: `Keep ${tags.map(tag => `<${tag}>…</${tag}>`).join(' and ')} around the translated text, or remove the tag from the base message.`,
    tags,
  };
}

/** Compare a source and translated message, including omitted arguments and branches. */
export function compareContract(source: string | MessageContract, translation: string | MessageContract, options?: { readonly id?: string; readonly locale?: string }): ContractDiagnostic[];
export function compareContract(options: CompareContractOptions): ContractDiagnostic[];
export function compareContract(sourceOrOptions: string | MessageContract | CompareContractOptions, translation?: string | MessageContract, suppliedOptions?: { readonly id?: string; readonly locale?: string }): ContractDiagnostic[] {
  // MessageContract also has a `source` field. Require the second overload's
  // own `translation` field so a parsed contract passed positionally is not
  // mistaken for the options object.
  const options = typeof sourceOrOptions === 'object' && sourceOrOptions !== null && Object.hasOwn(sourceOrOptions, 'translation')
    ? sourceOrOptions as CompareContractOptions
    : { source: sourceOrOptions as string | MessageContract, translation: translation!, id: suppliedOptions?.id, locale: suppliedOptions?.locale };
  const sourceContract = messageContract(options.source, options.id);
  const translationContract = messageContract(options.translation, options.id ?? sourceContract.id);
  const diagnostics: ContractDiagnostic[] = [];
  const context = sourceContract.id ? { messageId: sourceContract.id } : {};
  const add = (code: string, message: string, extra: Partial<ContractDiagnostic> = {}) => diagnostics.push({ code, message, severity: warningCodes.has(code) ? 'warning' : 'error', ...context, ...extra });
  const sourceArgs = sourceContract.arguments, targetArgs = translationContract.arguments;
  const dropped: string[] = [];
  for (const name of Object.keys(sourceArgs).sort(compare)) {
    const sourceArg = sourceArgs[name]!, targetArg = targetArgs[name];
    if (!targetArg) {
      if (sourceArg.kind === 'slot') dropped.push(name);
      else add('MISSING_ARGUMENT', `Translation is missing argument ${JSON.stringify(name)}.`, { argument: name, kind: sourceArg.kind });
      continue;
    }
    if (sourceArg.kind !== targetArg.kind) {
      add(sourceArg.kind === 'slot' || targetArg.kind === 'slot' ? 'SLOT_MISMATCH' : 'ARGUMENT_KIND_MISMATCH', `Argument ${JSON.stringify(name)} is ${sourceArg.kind} in the source but ${targetArg.kind} in the translation.`, { argument: name, kind: sourceArg.kind });
    }
  }
  if (dropped.length) {
    const { message, ...extra } = droppedTagDiagnostic(dropped);
    add('DROPPED_RICH_TAG', message, extra);
  }
  for (const name of Object.keys(targetArgs).sort(compare)) if (!sourceArgs[name]) {
    const targetArg = targetArgs[name]!;
    add(targetArg.kind === 'slot' ? 'UNEXPECTED_SLOT' : 'UNKNOWN_ARGUMENT', `Translation introduces ${targetArg.kind === 'slot' ? 'rich-text slot' : 'argument'} ${JSON.stringify(name)}.`, { argument: name, kind: targetArg.kind });
  }
  const sourceBranches = new Map(sourceContract.branches.map(branch => [branchIdentity(branch), branch]));
  const targetBranches = new Map(translationContract.branches.map(branch => [branchIdentity(branch), branch]));
  for (const [identity, sourceBranch] of sourceBranches) {
    if (!targetArgs[sourceBranch.argument]) continue;
    const targetBranch = targetBranches.get(identity);
    const label = `${sourceBranch.kind} ${JSON.stringify(sourceBranch.argument)}${sourceBranch.path.length ? ` under ${sourceBranch.path.join(' / ')}` : ''}`;
    if (!targetBranch) {
      add(sourceBranch.kind === 'plural' ? 'MISSING_PLURAL_BRANCH' : 'MISSING_SELECT_BRANCH', `Translation is missing the ${label} contract.`, { argument: sourceBranch.argument, branch: label });
      continue;
    }
    const sourceChoices = new Set(sourceBranch.choices), targetChoices = new Set(targetBranch.choices);
    for (const choice of sourceChoices) if (!targetChoices.has(choice)) {
      add(sourceBranch.kind === 'plural' ? 'MISSING_PLURAL_BRANCH' : 'MISSING_SELECT_BRANCH', `Translation is missing ${sourceBranch.kind} branch ${JSON.stringify(choice)} for ${JSON.stringify(sourceBranch.argument)}.`, { argument: sourceBranch.argument, branch: choice });
    }
    for (const choice of targetChoices) if (!sourceChoices.has(choice)) {
      add(sourceBranch.kind === 'plural' ? 'UNKNOWN_PLURAL_BRANCH' : 'UNKNOWN_SELECT_BRANCH', `Translation adds ${sourceBranch.kind} branch ${JSON.stringify(choice)} for ${JSON.stringify(sourceBranch.argument)}.`, { argument: sourceBranch.argument, branch: choice });
    }
  }
  for (const [identity, targetBranch] of targetBranches) if (!sourceBranches.has(identity) && sourceArgs[targetBranch.argument]) {
    const label = `${targetBranch.kind} ${JSON.stringify(targetBranch.argument)}${targetBranch.path.length ? ` under ${targetBranch.path.join(' / ')}` : ''}`;
    add(targetBranch.kind === 'plural' ? 'UNKNOWN_PLURAL_BRANCH' : 'UNKNOWN_SELECT_BRANCH', `Translation adds an unexpected ${label} contract.`, { argument: targetBranch.argument, branch: label });
  }
  if (options.locale) diagnostics.push(...pluralCategoryDiagnostics(translationContract, options.locale));
  return diagnostics;
}

export { parseContract as describeMessageContract };
