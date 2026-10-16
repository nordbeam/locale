import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse, parseExpression } from '@babel/parser';

/** react-intl support for the source codemod: message descriptors declared with
 * `defineMessages`/`defineMessage` (in the file or a relative module), values that
 * hold React elements or rich renderers, and `tagName`. */

type Node = { type?: string; start?: number | null; end?: number | null; [key: string]: unknown };

/** The IDs one `defineMessages` constant holds by key, or the ID of a `defineMessage` constant. */
export type FormatJsMessages = ReadonlyMap<string, string> | string;
/** Descriptor constants another module exports, by the local name this file imports them as. */
export type FormatJsImportedMessages = ReadonlyMap<string, FormatJsMessages>;

const plugins = ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] as never;
const descriptorModules = new Set(['react-intl', '@formatjs/intl']);
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

function parseProgram(text: string): Node | undefined {
  try { return parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins }).program as unknown as Node; }
  catch { return undefined; }
}

function walk(node: unknown, visit: (node: Node, parent: Node | undefined) => void, parent?: Node): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, parent); return; }
  const current = node as Node;
  if (typeof current.type !== 'string') return;
  visit(current, parent);
  for (const [key, value] of Object.entries(current)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    if (value && typeof value === 'object') walk(value, visit, current);
  }
}

/** Drop TypeScript-only wrappers and parentheses around an expression. */
function unwrap(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && /^(?:TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion|ParenthesizedExpression|TypeCastExpression)$/.test(current.type ?? '')) current = current.expression as Node | undefined;
  return current;
}

function staticText(node: Node | undefined): string | undefined {
  const value = unwrap(node);
  if (value?.type === 'StringLiteral') return value.value as string;
  if (value?.type === 'TemplateLiteral' && !(value.expressions as Node[]).length) return ((value.quasis as Node[])[0]!.value as { cooked?: string }).cooked ?? undefined;
}

function propertyKey(property: Node): string | undefined {
  const key = property.key as Node;
  if (!property.computed) return key.type === 'Identifier' ? key.name as string : key.type === 'StringLiteral' || key.type === 'NumericLiteral' ? String(key.value) : undefined;
  return staticText(key);
}

/** The `id` of a descriptor object literal, when it is a static string. */
function descriptorObjectId(node: Node | undefined): string | undefined {
  const value = unwrap(node);
  if (value?.type !== 'ObjectExpression') return;
  for (const property of value.properties as Node[]) {
    if (property.type === 'ObjectProperty' && propertyKey(property) === 'id') return staticText(property.value as Node);
  }
}

/** The local names `defineMessages` and `defineMessage` have in this file, when imported from react-intl. */
function descriptorFactories(program: Node): { many: Set<string>; one: Set<string> } {
  const many = new Set<string>(), one = new Set<string>();
  for (const statement of program.body as Node[]) {
    if (statement.type !== 'ImportDeclaration' || !descriptorModules.has((statement.source as Node).value as string)) continue;
    for (const specifier of statement.specifiers as Node[]) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = staticText(specifier.imported as Node) ?? (specifier.imported as Node).name as string;
      const local = (specifier.local as Node).name as string;
      if (imported === 'defineMessages') many.add(local);
      else if (imported === 'defineMessage') one.add(local);
    }
  }
  return { many, one };
}

/** The descriptor table a `defineMessages(…)`/`defineMessage(…)` call declares. */
function descriptorTable(init: Node | undefined, factories: { many: Set<string>; one: Set<string> }): FormatJsMessages | undefined {
  const call = unwrap(init);
  if (call?.type !== 'CallExpression') return;
  const callee = call.callee as Node;
  if (callee.type !== 'Identifier') return;
  const argument = (call.arguments as Node[])[0];
  if (factories.one.has(callee.name as string)) return descriptorObjectId(argument);
  if (!factories.many.has(callee.name as string)) return;
  const object = unwrap(argument);
  if (object?.type !== 'ObjectExpression') return;
  const table = new Map<string, string>();
  for (const property of object.properties as Node[]) {
    if (property.type !== 'ObjectProperty') continue;
    const key = propertyKey(property), id = descriptorObjectId(property.value as Node);
    if (key !== undefined && id !== undefined) table.set(key, id);
  }
  return table;
}

/** How often each name is declared anywhere in a file: parameters, variables, functions,
 * classes, catch clauses and imports. A descriptor constant is only resolved by name when
 * nothing else in the file declares that name, so a shadowing parameter cannot be mistaken
 * for it. */
function declarationCounts(program: Node): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: unknown): void => { if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1); };
  const pattern = (node: Node | undefined): void => {
    if (!node) return;
    if (node.type === 'Identifier') add(node.name);
    else if (node.type === 'AssignmentPattern') pattern(node.left as Node);
    else if (node.type === 'RestElement') pattern(node.argument as Node);
    else if (node.type === 'TSParameterProperty') pattern(node.parameter as Node);
    else if (node.type === 'ObjectPattern') for (const property of node.properties as Node[]) pattern((property.type === 'RestElement' ? property.argument : property.value) as Node);
    else if (node.type === 'ArrayPattern') for (const element of node.elements as Array<Node | null>) pattern(element ?? undefined);
  };
  walk(program, node => {
    if (node.type === 'VariableDeclarator') pattern(node.id as Node);
    else if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/.test(node.type!)) {
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') add((node.id as Node | null)?.name);
      for (const parameter of node.params as Node[]) pattern(parameter);
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') add((node.id as Node | null)?.name);
    else if (node.type === 'CatchClause') pattern(node.param as Node | undefined);
    else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') add((node.local as Node).name);
  });
  return counts;
}

/** What a module exports through `defineMessages`/`defineMessage`, for other files to import. */
export interface FormatJsModuleExports { readonly default?: FormatJsMessages; readonly named: ReadonlyMap<string, FormatJsMessages> }

export function formatJsModuleExports(text: string): FormatJsModuleExports | undefined {
  if (!/\bdefineMessages?\s*[(<]/.test(text)) return;
  const program = parseProgram(text);
  if (!program) return;
  const factories = descriptorFactories(program);
  if (!factories.many.size && !factories.one.size) return;
  const declared = new Map<string, FormatJsMessages>(), named = new Map<string, FormatJsMessages>();
  let fallback: FormatJsMessages | undefined;
  const declare = (declaration: Node | undefined, exported: boolean): void => {
    if (declaration?.type !== 'VariableDeclaration') return;
    for (const declarator of declaration.declarations as Node[]) {
      const id = declarator.id as Node;
      if (id.type !== 'Identifier') continue;
      const table = descriptorTable(declarator.init as Node, factories);
      if (table === undefined) continue;
      declared.set(id.name as string, table);
      if (exported) named.set(id.name as string, table);
    }
  };
  for (const statement of program.body as Node[]) {
    if (statement.type === 'VariableDeclaration') declare(statement, false);
    else if (statement.type === 'ExportNamedDeclaration') declare(statement.declaration as Node | undefined, true);
  }
  for (const statement of program.body as Node[]) {
    if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
      for (const specifier of (statement.specifiers as Node[] | undefined) ?? []) {
        const local = (specifier.local as Node | undefined)?.name as string | undefined, exported = staticText(specifier.exported as Node) ?? (specifier.exported as Node).name as string;
        const table = local === undefined ? undefined : declared.get(local);
        if (table !== undefined) { if (exported === 'default') fallback = table; else named.set(exported, table); }
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const value = statement.declaration as Node;
      fallback = value.type === 'Identifier' ? declared.get(value.name as string) : descriptorTable(value, factories);
    }
  }
  if (fallback === undefined && !named.size) return;
  return { ...(fallback !== undefined ? { default: fallback } : {}), named };
}

/** Resolve a relative import to one of the scanned files: the exact path, with an extension,
 * or as a directory index. */
function resolveModule(from: string, specifier: string, modules: ReadonlyMap<string, unknown>): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, ...sourceExtensions.map(extension => `${base}${extension}`), ...sourceExtensions.map(extension => `${base}/index${extension}`)];
  // `./messages.js` written for TypeScript's node resolution names `./messages.ts`.
  const withoutExtension = /\.[cm]?js$/.exec(base) ? base.replace(/\.[cm]?js$/, '') : undefined;
  if (withoutExtension) candidates.push(...sourceExtensions.map(extension => `${withoutExtension}${extension}`));
  return candidates.find(candidate => modules.has(candidate));
}

/** Descriptor constants that each file imports from another scanned module, by local name. */
export async function formatJsProjectMessages(files: readonly string[]): Promise<Map<string, FormatJsImportedMessages>> {
  const modules = new Map<string, FormatJsModuleExports>(), texts = new Map<string, string>();
  for (const file of files) {
    if (!sourceExtensions.some(extension => file.endsWith(extension))) continue;
    const text = await readFile(file, 'utf8');
    texts.set(file, text);
    const exports = formatJsModuleExports(text);
    if (exports) modules.set(file, exports);
  }
  const result = new Map<string, FormatJsImportedMessages>();
  if (!modules.size) return result;
  for (const [file, text] of texts) {
    // Parse only a file whose relative imports name one of the descriptor modules.
    const specifiers = [...text.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => match[1]!);
    if (!specifiers.some(specifier => resolveModule(file, specifier, modules))) continue;
    const program = parseProgram(text);
    if (!program) continue;
    const imported = new Map<string, FormatJsMessages>();
    for (const statement of program.body as Node[]) {
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
      const specifier = (statement.source as Node).value as string;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const target = resolveModule(file, specifier, modules);
      if (!target) continue;
      const exports = modules.get(target)!;
      for (const item of statement.specifiers as Node[]) {
        const local = (item.local as Node).name as string;
        const table = item.type === 'ImportDefaultSpecifier' ? exports.default
          : item.type === 'ImportSpecifier' && item.importKind !== 'type' ? exports.named.get(staticText(item.imported as Node) ?? (item.imported as Node).name as string) : undefined;
        if (table !== undefined) imported.set(local, table);
      }
    }
    if (imported.size) result.set(file, imported);
  }
  return result;
}

/** Names a file binds to a React element (`const link = <a …/>`, also parenthesized,
 * conditional or `cond && <x/>`, or assigned later) and to a function, which react-intl only
 * calls as a rich-text renderer. */
function richBindings(program: Node): { elements: Set<string>; functions: Set<string> } {
  const elements = new Set<string>(), functions = new Set<string>();
  const bind = (name: unknown, value: Node | undefined): void => {
    if (typeof name !== 'string' || !value) return;
    if (holdsElement(value)) elements.add(name);
    const inner = unwrap(value);
    if (inner?.type === 'ArrowFunctionExpression' || inner?.type === 'FunctionExpression') functions.add(name);
  };
  walk(program, node => {
    if (node.type === 'VariableDeclarator' && (node.id as Node).type === 'Identifier') bind((node.id as Node).name, node.init as Node | undefined);
    else if (node.type === 'AssignmentExpression' && (node.left as Node).type === 'Identifier') bind((node.left as Node).name, node.right as Node);
    else if (node.type === 'FunctionDeclaration') { const id = node.id as Node | null; if (id) functions.add(id.name as string); }
  });
  return { elements, functions };
}

function holdsElement(node: Node | undefined): boolean {
  const value = unwrap(node);
  if (!value) return false;
  if (value.type === 'JSXElement' || value.type === 'JSXFragment') return true;
  if (value.type === 'ConditionalExpression') return holdsElement(value.consequent as Node) || holdsElement(value.alternate as Node);
  if (value.type === 'LogicalExpression') return holdsElement(value.left as Node) || holdsElement(value.right as Node);
  return false;
}

export interface FormatJsElementContext {
  readonly root: string;
  readonly access: (id: string) => string;
  readonly renamed: (id: string) => string;
  readonly allowedIds?: ReadonlySet<string>;
  /** The element may become a bare call (`return <X/>` → `return m.x()`); otherwise it is a JSX
   * child or attribute value and needs braces. */
  readonly expression: boolean;
  /** A `render={(m) => …}` component that keeps an element outside any component lazy. */
  readonly messageComponent?: string;
}

export type FormatJsElementResult =
  | { readonly replacement: { readonly text: string; readonly rich: boolean } }
  | { readonly skip: { readonly reason: string; readonly code?: string } };

/** The react-intl state of one source file: its descriptor constants and the names it binds
 * to elements and renderers. Parsing happens once, on first use. */
export class FormatJsSource {
  #program: Node | null | undefined;
  #tables: Map<string, FormatJsMessages> | undefined;
  #rich: { elements: Set<string>; functions: Set<string> } | undefined;

  constructor(private readonly text: string, private readonly imported: FormatJsImportedMessages = new Map()) {}

  private get program(): Node | undefined {
    if (this.#program === undefined) this.#program = parseProgram(this.text) ?? null;
    return this.#program ?? undefined;
  }

  /** Descriptor constants visible by name: declared in this file, or imported from a module
   * that exports them. A name declared more than once in the file is never resolved. */
  private get tables(): Map<string, FormatJsMessages> {
    if (this.#tables) return this.#tables;
    const tables = new Map<string, FormatJsMessages>();
    this.#tables = tables;
    if (!this.imported.size && !/\bdefineMessages?\s*[(<]/.test(this.text)) return tables;
    const program = this.program;
    if (!program) return tables;
    const counts = declarationCounts(program), factories = descriptorFactories(program);
    for (const [name, table] of this.imported) if (counts.get(name) === 1) tables.set(name, table);
    if (factories.many.size || factories.one.size) walk(program, node => {
      if (node.type !== 'VariableDeclarator' || (node.id as Node).type !== 'Identifier') return;
      const name = (node.id as Node).name as string, table = descriptorTable(node.init as Node | undefined, factories);
      if (table !== undefined && counts.get(name) === 1) tables.set(name, table);
    });
    return tables;
  }

  private get richNames(): { elements: Set<string>; functions: Set<string> } {
    if (!this.#rich) this.#rich = this.program ? richBindings(this.program) : { elements: new Set(), functions: new Set() };
    return this.#rich;
  }

  /** The ID a descriptor expression names: `messages.key`, `messages['key']`, or a
   * `defineMessage` constant. */
  descriptorId(expression: string): string | undefined {
    if (!this.tables.size) return;
    let node: Node | undefined;
    try { node = unwrap(parseExpression(expression.trim(), { plugins }) as unknown as Node); }
    catch { return; }
    if (node?.type === 'Identifier') {
      const table = this.tables.get(node.name as string);
      return typeof table === 'string' ? table : undefined;
    }
    if (node?.type !== 'MemberExpression' || (node.object as Node).type !== 'Identifier') return;
    const table = this.tables.get((node.object as Node).name as string);
    if (table === undefined || typeof table === 'string') return;
    const key = node.computed ? staticText(node.property as Node) : (node.property as Node).name as string | undefined;
    return key === undefined ? undefined : table.get(key);
  }

  /** `{ id: '…' }` for a resolvable descriptor reference, so the inline-descriptor path reads it. */
  inlineDescriptor(expression: string): string | undefined {
    const id = this.descriptorId(expression);
    return id === undefined ? undefined : `{ id: ${JSON.stringify(id)} }`;
  }

  /** A finite conditional between descriptors (`open ? messages.close : messages.open`) as the
   * same conditional between their ID strings, which the conditional-key lowering turns into one
   * call per branch. Undefined unless every leaf is a resolvable descriptor or `{ id: '…' }`. */
  conditionalIds(expression: string): string | undefined {
    const source = expression.trim();
    let root: Node;
    try { root = parseExpression(source, { plugins }) as unknown as Node; }
    catch { return; }
    if (unwrap(root)?.type !== 'ConditionalExpression') return;
    const leaves: Array<{ start: number; end: number; id: string }> = [];
    const visit = (node: Node | undefined): boolean => {
      const value = unwrap(node);
      if (!value) return false;
      if (value.type === 'ConditionalExpression') return visit(value.consequent as Node) && visit(value.alternate as Node);
      const id = value.type === 'ObjectExpression' ? descriptorObjectId(value) : this.descriptorId(source.slice(value.start!, value.end!));
      if (id === undefined) return false;
      leaves.push({ start: value.start!, end: value.end!, id });
      return true;
    };
    if (!visit(root)) return;
    let result = source;
    for (const leaf of leaves.sort((left, right) => right.start - left.start)) result = result.slice(0, leaf.start) + JSON.stringify(leaf.id) + result.slice(leaf.end);
    return result;
  }

  /** Whether a `values` expression holds a React element or a rich renderer, which only
   * `rich()` renders: inline JSX, a function, or a name this file binds to either. */
  needsRich(values: string | undefined): boolean {
    if (!values?.trim()) return false;
    let node: Node | undefined;
    try { node = unwrap(parseExpression(values.trim(), { plugins }) as unknown as Node); }
    catch { return false; }
    if (node?.type !== 'ObjectExpression') return false;
    return (node.properties as Node[]).some(property => property.type === 'ObjectProperty' && this.richValue(property.value as Node));
  }

  /** Whether a values object passes a name this file binds to a React element, which a plain
   * message call would print as `[object Object]`. */
  holdsBoundElement(values: string | undefined): boolean {
    if (!values?.trim() || !/[A-Za-z_$]/.test(values)) return false;
    let node: Node | undefined;
    try { node = unwrap(parseExpression(values.trim(), { plugins }) as unknown as Node); }
    catch { return false; }
    if (node?.type !== 'ObjectExpression') return false;
    return (node.properties as Node[]).some(property => {
      const value = unwrap(property.type === 'ObjectProperty' ? property.value as Node : undefined);
      return value?.type === 'Identifier' && this.richNames.elements.has(value.name as string);
    });
  }

  private richValue(node: Node | undefined): boolean {
    const value = unwrap(node);
    if (!value) return false;
    if (value.type === 'JSXElement' || value.type === 'JSXFragment' || value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') return true;
    if (value.type === 'ConditionalExpression') return this.richValue(value.consequent as Node) || this.richValue(value.alternate as Node);
    if (value.type === 'LogicalExpression') return this.richValue(value.left as Node) || this.richValue(value.right as Node);
    if (value.type === 'Identifier') return this.richNames.elements.has(value.name as string) || this.richNames.functions.has(value.name as string);
    return false;
  }

  /** A `<FormattedMessage …/>` element as a message call, or why it stays. Undefined leaves the
   * element to the general component rewrite (children, an id expression, no id at all). */
  element(source: string, context: FormatJsElementContext): FormatJsElementResult | undefined {
    let element: Node;
    try { element = parseExpression(source, { plugins }) as unknown as Node; }
    catch { return; }
    if (element.type !== 'JSXElement') return;
    const slice = (node: Node): string => source.slice(node.start!, node.end!);
    const children = (element.children as Node[]).filter(child => !(child.type === 'JSXText' && !(child.value as string).trim()));
    if (children.length) return;
    let id: string | undefined, values: string | undefined, tag: string | undefined, key: string | undefined;
    for (const attribute of (element.openingElement as Node).attributes as Node[]) {
      if (attribute.type === 'JSXSpreadAttribute') {
        const spreadId = this.descriptorId(slice(attribute.argument as Node));
        if (spreadId === undefined) return { skip: { reason: `component spreads ${slice(attribute.argument as Node)}, a descriptor with no static id` } };
        id = spreadId;
        continue;
      }
      const name = (attribute.name as Node).type === 'JSXIdentifier' ? (attribute.name as Node).name as string : undefined;
      const value = attribute.value as Node | null;
      const expression = value?.type === 'JSXExpressionContainer' ? value.expression as Node : value ?? undefined;
      if (name === 'id') {
        const literal = staticText(expression);
        if (literal === undefined) return;
        id = literal;
      } else if (name === 'values') {
        if (expression?.type === 'JSXEmptyExpression' || !expression) continue;
        values = slice(expression);
      } else if (name === 'tagName') {
        const literal = staticText(expression);
        if (literal !== undefined) { if (!/^[a-z][\w-]*$/.test(literal)) return; tag = literal; }
        else if (expression && /^(?:Identifier|MemberExpression)$/.test(expression.type!) && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(slice(expression))) tag = slice(expression);
        else return;
      } else if (name === 'key') key = value ? slice(value) : undefined;
    }
    if (id === undefined) return;
    const target = context.renamed(id);
    if (context.allowedIds && !context.allowedIds.has(target)) return { skip: { reason: `message id ${JSON.stringify(target)} is absent from generated message types`, code: 'UNKNOWN_MESSAGE_ID' } };
    const rich = this.needsRich(values);
    const access = context.access(target);
    const call = rich ? `rich(${access}, ${values})` : `${access}(${values ?? ''})`;
    const lazy = context.messageComponent === undefined ? undefined : `<${context.messageComponent} render={(${context.root}) => ${call}} />`;
    // tagName wraps the text in that element; the wrapper is itself JSX, so it needs no braces.
    if (tag) return { replacement: { text: `<${tag}${key ? ` key=${key}` : ''}>${lazy ?? `{${call}}`}</${tag}>`, rich } };
    return { replacement: { text: lazy ?? (context.expression ? call : `{${call}}`), rich } };
  }
}

/** After calls were rewritten: remove `defineMessages`/`defineMessage` constants nothing reads
 * any more (unless exported), imports of descriptor constants from other modules that nothing
 * reads, and the react-intl `defineMessages`/`defineMessage` import once unused. */
export function removeUnusedDescriptors(before: string, text: string, importedNames: ReadonlySet<string>): string {
  if (!/\bdefineMessages?\b/.test(text) && !importedNames.size) return text;
  const program = parseProgram(text), original = parseProgram(before);
  if (!program || !original) return text;
  const factories = descriptorFactories(program);
  const counts = declarationCounts(program);
  const references = referenceCounts(program), read = referenceCounts(original);
  // Only what the rewrite stopped reading goes; a constant nothing read before stays as written.
  const unread = (name: string): boolean => !!read.get(name) && !references.get(name);
  const removals: Array<{ start: number; end: number }> = [];
  const exported = new Set<string>();
  for (const statement of program.body as Node[]) {
    if (statement.type === 'ExportNamedDeclaration' && !statement.source) for (const specifier of (statement.specifiers as Node[] | undefined) ?? []) exported.add((specifier.local as Node).name as string);
    if (statement.type === 'ExportDefaultDeclaration' && (statement.declaration as Node).type === 'Identifier') exported.add((statement.declaration as Node).name as string);
  }
  const removedFactoryCalls = new Map<string, number>();
  walk(program, (node, parent) => {
    if (node.type !== 'VariableDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ForStatement' || parent?.type === 'ForInStatement' || parent?.type === 'ForOfStatement') return;
    const declarators = node.declarations as Node[];
    if (declarators.length !== 1) return;
    const declarator = declarators[0]!, id = declarator.id as Node;
    if (id.type !== 'Identifier' || exported.has(id.name as string) || counts.get(id.name as string) !== 1 || !unread(id.name as string)) return;
    if (descriptorTable(declarator.init as Node | undefined, factories) === undefined) return;
    const factory = ((unwrap(declarator.init as Node) as Node).callee as Node).name as string;
    removedFactoryCalls.set(factory, (removedFactoryCalls.get(factory) ?? 0) + 1);
    removals.push(statementRange(text, node));
  });
  for (const statement of program.body as Node[]) {
    if (statement.type !== 'ImportDeclaration') continue;
    const specifiers = statement.specifiers as Node[];
    const source = (statement.source as Node).value as string;
    const unused = specifiers.filter(specifier => {
      const local = (specifier.local as Node).name as string;
      if (importedNames.has(local) && !descriptorModules.has(source)) return unread(local);
      if (descriptorModules.has(source) && (factories.many.has(local) || factories.one.has(local))) return !!removedFactoryCalls.get(local) && (references.get(local) ?? 0) <= removedFactoryCalls.get(local)!;
      return false;
    });
    if (!unused.length) continue;
    if (unused.length === specifiers.length) { removals.push(statementRange(text, statement)); continue; }
    for (const specifier of unused) removals.push(specifierRange(text, specifier));
  }
  if (!removals.length) return text;
  removals.sort((left, right) => left.start - right.start);
  const pieces: string[] = [];
  let cursor = 0;
  for (const removal of removals) {
    if (removal.start < cursor) { cursor = Math.max(cursor, removal.end); continue; }
    pieces.push(text.slice(cursor, removal.start));
    cursor = removal.end;
  }
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

/** How often each name is read: identifiers that are not a declaration, a property key or a type. */
function referenceCounts(program: Node): Map<string, number> {
  const references = new Map<string, number>();
  walk(program, (node, parent) => {
    if (node.type !== 'Identifier' && node.type !== 'JSXIdentifier') return;
    if (parent && isDeclarationOrKey(node, parent)) return;
    references.set(node.name as string, (references.get(node.name as string) ?? 0) + 1);
  });
  return references;
}

function isDeclarationOrKey(node: Node, parent: Node): boolean {
  if (parent.type === 'VariableDeclarator' && parent.id === node) return true;
  if ((parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') && (parent.local === node || parent.imported === node)) return true;
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression' || parent.type === 'JSXMemberExpression') && parent.property === node && !parent.computed) return true;
  if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassProperty' || parent.type === 'ClassMethod') && parent.key === node && !parent.computed && !(parent.type === 'ObjectProperty' && parent.shorthand)) return true;
  if (parent.type === 'JSXAttribute' && parent.name === node) return true;
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration') && parent.id === node) return true;
  if (parent.type === 'JSXOpeningElement' || parent.type === 'JSXClosingElement' || parent.type === 'TSTypeQuery') return false;
  if (/^TS/.test(parent.type ?? '') && parent.type !== 'TSAsExpression' && parent.type !== 'TSSatisfiesExpression' && parent.type !== 'TSNonNullExpression') return true;
  return false;
}

/** A statement's range with its own line, so removing it leaves no empty line behind. A blank
 * line after it goes too when one precedes it (or it opens the file), so the blank lines that
 * separated it from its neighbours do not double up. */
function statementRange(text: string, node: Node): { start: number; end: number } {
  let start = node.start!, end = node.end!;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (!text.slice(lineStart, start).trim()) start = lineStart;
  const lineEnd = text.indexOf('\n', end);
  if (!text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim()) end = lineEnd < 0 ? text.length : lineEnd + 1;
  if (start === lineStart && (start === 0 || /\n[ \t]*\n$/.test(text.slice(0, start)))) {
    const blank = /^[ \t]*\n/.exec(text.slice(end));
    if (blank) end += blank[0].length;
  }
  return { start, end };
}

/** A specifier and the comma that separates it from its neighbour. */
function specifierRange(text: string, node: Node): { start: number; end: number } {
  const after = /^\s*,\s*/.exec(text.slice(node.end!));
  if (after) return { start: node.start!, end: node.end! + after[0].length };
  const before = /,\s*$/.exec(text.slice(0, node.start!));
  return before ? { start: node.start! - before[0].length, end: node.end! } : { start: node.start!, end: node.end! };
}
