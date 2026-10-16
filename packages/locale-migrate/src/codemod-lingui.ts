import { parse, parseExpression } from '@babel/parser';

/** Lingui 4 and 5 macros name a message by its source text, so the codemod rebuilds that
 * text the way the macro extracts it, finds the catalog ID through the source-to-ID map,
 * and passes the values the macro would have passed. */

type Node = { type: string; start?: number | null; end?: number | null; [key: string]: any };

const plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] = ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'];

/** A message as a Lingui macro extracts it. */
export interface LinguiMessage {
  /** An explicit `id`; without one the message is found by its source text. */
  readonly id?: string;
  readonly source: string;
  /** The same message as the other macro version extracts it (see Spelling), tried when the
   * catalog has no entry for `source`. */
  readonly alternatives?: readonly string[];
  /** A message with a context is a different catalog entry from the same text without one. */
  readonly context?: string;
  /** Object literal fields for the call: `name` or `0: expression`. */
  readonly values: readonly string[];
  /** rich() slots for the elements of a `<Trans>`, `tag0: (children) => …`. */
  readonly slots: readonly string[];
  /** Offsets, in the source given, of `<Trans>` elements inside this one, whose children the
   * macro reads as part of this message. */
  readonly nested?: readonly number[];
}

export type LinguiExtraction = LinguiMessage | { readonly unsupported: string };

export interface LinguiLookup {
  readonly sourceIds: ReadonlyMap<string, string>;
  readonly allowedIds?: ReadonlySet<string>;
  readonly renamed: (id: string) => string;
}

class Unsupported extends Error {}

const choiceMacros = new Set(['plural', 'select', 'selectOrdinal']);
const choiceComponents = new Set(['Plural', 'Select', 'SelectOrdinal']);
const descriptorFields = new Set(['id', 'message', 'comment', 'context', 'values']);
// Props of a choice component that describe the message, not one of its cases.
const choiceMetaProps = new Set(['id', 'comment', 'message', 'context', 'key', 'render', 'i18n']);
// A JSX prop that names a case: `_0` is the exact match `=0`, `_male` the case `male`.
const pluralRule = /(_[\d\w]+|zero|one|two|few|many|other)/;

/** Choice macros a file imports from a Lingui macro package, by local name. Only these are
 * read as ICU choices: a `<Select>` or `select()` from anywhere else is not Lingui's. */
export type LinguiChoiceNames = ReadonlyMap<string, string>;

export function linguiChoiceNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of text.matchAll(/\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](@lingui\/(?:core\/macro|react\/macro|macro))['"]/g)) {
    if (match[1]) continue;
    for (const specifier of match[2]!.split(',')) {
      const [imported, local = imported] = specifier.trim().split(/\s+as\s+/).map(part => part.trim());
      if (imported && (choiceMacros.has(imported) || choiceComponents.has(imported))) names.set(local!, imported);
    }
  }
  return names;
}

/** Lingui 5's Babel macro reads JSX text the way React renders it and keeps every other
 * character; Lingui 4 normalizes whitespace across the whole message. A catalog holds one
 * spelling or the other, so a message is looked up in both. */
type Spelling = 'exact' | 'normalized';

// Lingui 4's normalizeWhitespace for JSX messages: a line break and the indentation around it
// next to a tag or a placeholder disappear, any other becomes one space.
const stripAroundTags = /(?:([>}])(?:\r\n|\r|\n)+\s*|(?:\r\n|\r|\n)+\s*(?=[<{]))/g;
const keepSpace = /\s*(?:\r\n|\r|\n)+\s*/g;

function normalizeWhitespace(text: string): string {
  return text.replace(stripAroundTags, '$1').replace(keepSpace, ' ').replace(/\\n/g, '\n').replace(/\\s/g, ' ').replace(/(\s+})/gm, '}').trim();
}

// Lingui 4's normalizeWhitespace for JS macros: an escaped line break joins with a space, a line
// break keeps one newline without the indentation after it, and the message is trimmed.
function normalizeJsWhitespace(text: string): string {
  return text.replace(/(?:\\(?:\r\n|\r|\n))+\s+/g, ' ').replace(/(?:\r\n|\r|\n)+\s+/g, '\n').trim();
}

/** A JSX text child as React renders it (Babel's cleanJSXElementLiteralChild): lines are trimmed
 * where they meet a line break, empty lines go, and the rest join with one space. */
function jsxText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((line, index) => { if (/[^ \t]/.test(line)) last = index; });
  let text = '';
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, ' ');
    if (index > 0) trimmed = trimmed.replace(/^[ ]+/, '');
    if (index < lines.length - 1) trimmed = trimmed.replace(/[ ]+$/, '');
    if (trimmed) text += index === last ? trimmed : `${trimmed} `;
  });
  return text;
}

class MessageBuilder {
  message = '';
  private readonly values = new Map<string, string>();
  readonly slots: string[] = [];
  private position = 0;
  private element = 0;
  private readonly nested: number[] = [];

  constructor(private readonly code: string, private readonly spelling: Spelling, private readonly choices: LinguiChoiceNames = new Map(), private readonly transNames: ReadonlySet<string> = new Set()) {}

  private slice(node: Node): string { return this.code.slice(node.start!, node.end!); }

  result(source: string, id?: string, context?: string): LinguiMessage {
    const values = [...this.values].map(([name, expression]) => name === expression ? name : `${/^(?:\d+|[A-Za-z_$][\w$]*)$/.test(name) ? name : JSON.stringify(name)}: ${expression}`);
    return { ...(id === undefined ? {} : { id }), source, ...(context === undefined ? {} : { context }), values, slots: this.slots, ...(this.nested.length ? { nested: this.nested } : {}) };
  }

  /** The choice macro a call or element is, when the file imports it from Lingui. */
  choice(name: string, kind: ReadonlySet<string>): string | undefined {
    const imported = this.choices.get(name);
    if (imported !== undefined && kind.has(imported)) return imported;
    if (imported === undefined && kind.has(name)) throw new Unsupported(kind === choiceMacros
      ? `Lingui ${name}() inside a message is not imported from a Lingui macro package; migrate it manually to an ICU plural or select`
      : `<${name}> inside <Trans> is not imported from a Lingui macro package; migrate it manually to an ICU plural or select`);
    return undefined;
  }

  /** A placeholder's name: `${name}` is `{name}`, `ph({ label: value })` and `${{ label: value }}`
   * are `{label}`, and any other expression takes the next position, `{0}`, `{1}`… */
  private placeholder(node: Node): string {
    let inner = node;
    while (inner.type === 'TSAsExpression') inner = inner.expression;
    if (inner.type === 'Identifier') {
      this.values.set(inner.name, inner.name);
      return inner.name;
    }
    const labelled = inner.type === 'ObjectExpression' ? inner
      : inner.type === 'CallExpression' && inner.callee?.type === 'Identifier' && inner.callee.name === 'ph' && inner.arguments.length === 1 ? inner.arguments[0] : undefined;
    if (labelled?.type === 'ObjectExpression' && labelled.properties.length === 1) {
      const property = labelled.properties[0];
      const label = propertyName(property);
      if (label !== undefined) {
        this.values.set(label, this.slice(property.value));
        return label;
      }
    }
    const name = String(this.position++);
    this.values.set(name, this.slice(node));
    return name;
  }

  expression(node: Node): void {
    const choice = node.type === 'CallExpression' && node.callee?.type === 'Identifier' ? this.choice(node.callee.name, choiceMacros) : undefined;
    if (choice) this.choiceCall(node, choice);
    else this.message += `{${this.placeholder(node)}}`;
  }

  /** Lingui 5 reads a template's cooked text; Lingui 4 its raw source, unless it holds a unicode escape. */
  template(node: Node, jsx = false): void {
    node.quasis.forEach((quasi: Node, index: number) => {
      const raw = quasi.value.raw as string, cooked = (quasi.value.cooked ?? raw) as string;
      let text = this.spelling === 'exact' ? cooked : (/\\u[a-fA-F0-9]{4}|\\x[a-fA-F0-9]{2}/.test(raw) ? cooked : raw).replace(/\\`/g, '`');
      if (jsx && this.spelling === 'normalized') text = text.replace(/\n/g, '\\n');
      this.message += text;
      const expression = node.expressions[index];
      if (expression) this.expression(expression);
    });
  }

  children(nodes: readonly Node[]): void {
    for (const child of nodes) {
      if (child.type === 'JSXText') this.message += this.spelling === 'exact' ? jsxText(child.value) : child.value;
      else if (child.type === 'JSXExpressionContainer') {
        const expression = child.expression as Node;
        if (expression.type === 'JSXEmptyExpression') continue;
        if (expression.type === 'StringLiteral') this.message += this.spelling === 'exact' ? expression.value as string : (expression.value as string).replace(/\n/g, '\\n');
        else if (expression.type === 'TemplateLiteral') this.template(expression, true);
        else if (expression.type === 'JSXElement') this.jsxElement(expression);
        else if (expression.type === 'JSXFragment') throw new Unsupported('a fragment inside <Trans> needs a manual rich-message migration');
        else if (expression.type === 'CallExpression' && expression.callee?.type === 'Identifier' && (choiceMacros.has(expression.callee.name) || this.choices.has(expression.callee.name))) throw new Unsupported(`Lingui ${expression.callee.name}() inside <Trans> needs a manual migration; use <${expression.callee.name[0]!.toUpperCase()}${expression.callee.name.slice(1)}> instead`);
        else this.message += `{${this.placeholder(expression)}}`;
      } else if (child.type === 'JSXElement') this.jsxElement(child);
      else if (child.type === 'JSXFragment') throw new Unsupported('a fragment inside <Trans> needs a manual rich-message migration');
    }
  }

  /** Elements are numbered in the order they open, outer before inner, as `<0>…</0>` or `<0/>`.
   * The catalog migration renames them `tag0`, so each becomes a rich() slot. */
  private jsxElement(node: Node): void {
    const opening = node.openingElement as Node;
    const name = this.slice(opening.name);
    const choice = this.choice(name, choiceComponents);
    if (choice) {
      this.nested.push(node.start!);
      this.choiceElement(node, choice);
      return;
    }
    // The macro reads a <Trans> inside another as part of the outer message.
    if (this.transNames.has(name)) {
      this.nested.push(node.start!);
      this.children(node.children);
      return;
    }
    const index = this.element++;
    const children = node.children as Node[];
    if (!children.length) {
      this.message += `<${index}/>`;
      this.slots.push(`tag${index}: () => ${this.slice(node)}`);
      return;
    }
    this.message += `<${index}>`;
    this.children(children);
    this.message += `</${index}>`;
    const head = this.slice(opening);
    const parameter = /\bchildren\b/.test(head) ? 'chunks' : 'children';
    this.slots.push(`tag${index}: (${parameter}) => ${head}{${parameter}}</${name}>`);
  }

  /** The text `build` adds, without adding it: a case is built in the order it is written,
   * so its placeholders take their positions there, and serialized with the choice. */
  private capture(build: () => void): string {
    const outer = this.message;
    this.message = '';
    build();
    const text = this.message;
    this.message = outer;
    return text;
  }

  /** `{value, plural, offset:1 =0 {…} one {…} other {…}}`: offset first, then the cases in the
   * order they are written. */
  private choiceMessage(name: string, format: string, offset: string | undefined, cases: ReadonlyArray<readonly [string, string]>): void {
    const parts = [...(offset === undefined ? [] : [`offset:${offset}`]), ...cases.map(([key, text]) => `${key} {${text}}`)];
    this.message += `{${name}, ${format}, ${parts.join(' ')}}`;
  }

  /** `plural(count, { one: '# item', other: '# items' })`, also nested in a case or a template. */
  private choiceCall(node: Node, choice: string): void {
    const format = choice.toLowerCase();
    const [value, cases] = (node.arguments ?? []) as Node[];
    if (node.arguments.length !== 2 || !value || value.type === 'SpreadElement' || cases?.type !== 'ObjectExpression') throw new Unsupported(`Lingui ${choice}() takes a value and an object of cases; this one cannot be read statically`);
    // The value is named before the cases, so it takes the first position.
    const name = this.placeholder(value);
    let offset: string | undefined;
    const built: Array<readonly [string, string]> = [];
    for (const property of cases.properties as Node[]) {
      if (property.type !== 'ObjectProperty' || property.computed) throw new Unsupported(`Lingui ${choice}() has a spread or computed case, so its message cannot be read statically`);
      const key = property.key.type === 'NumericLiteral' ? `=${property.key.value}` : property.key.type === 'Identifier' ? property.key.name as string : property.key.type === 'StringLiteral' ? property.key.value as string : undefined;
      if (key === undefined) throw new Unsupported(`Lingui ${choice}() has a case key that cannot be read statically`);
      const item = property.value as Node;
      if (format !== 'select' && key === 'offset') {
        if (item.type !== 'StringLiteral' && item.type !== 'NumericLiteral') throw new Unsupported(`Lingui ${choice}() offset is not a literal`);
        offset = String(item.value);
        continue;
      }
      // Lingui 4 wrote `_0` as `=0`; Lingui 5 keeps it and unescapes `_id`, `_comment` and `_props`.
      const written = this.spelling === 'exact' ? key.replace(/^_(id|comment|props)$/, '$1') : key.replace('_', '=');
      built.push([written, this.capture(() => {
        if (item.type === 'StringLiteral') this.message += item.value as string;
        else if (item.type === 'TemplateLiteral') this.template(item);
        else this.expression(item);
      })]);
    }
    this.choiceMessage(name, format, offset, built);
  }

  /** `<Plural value={count} one="# item" other={<b># items</b>} />`, alone or inside a `<Trans>`. */
  choiceElement(node: Node, choice: string): void {
    const format = choice.toLowerCase();
    let name: string | undefined, offset: string | undefined;
    const cases: Array<readonly [string, string]> = [];
    for (const attribute of node.openingElement.attributes as Node[]) {
      if (attribute.type !== 'JSXAttribute') throw new Unsupported(`<${choice}> spreads its props, so its message cannot be read statically`);
      if (attribute.name.type !== 'JSXIdentifier') continue;
      const key = attribute.name.name as string, value = attribute.value as Node | null;
      if (choiceMetaProps.has(key)) continue;
      if (key === 'value') {
        if (value?.type !== 'JSXExpressionContainer' || value.expression.type === 'JSXEmptyExpression') throw new Unsupported(`<${choice}> value is not an expression, so its message cannot be read statically`);
        name = this.placeholder(value.expression);
        continue;
      }
      if (format !== 'select' && key === 'offset') {
        const literal = value?.type === 'JSXExpressionContainer' ? value.expression : value;
        if (literal?.type !== 'StringLiteral' && literal?.type !== 'NumericLiteral') throw new Unsupported(`<${choice}> offset is not a literal`);
        offset = String(literal.value);
        continue;
      }
      if (!value) throw new Unsupported(`<${choice}> case ${key} has no text`);
      const written = pluralRule.test(key) ? key.replace(/_(\d+)/, '=$1').replace(/_(\w+)/, '$1') : key;
      // A quoted case is its source text between the quotes, as the macro reads it.
      cases.push([written, this.capture(() => { if (value.type === 'StringLiteral') this.message += this.slice(value).slice(1, -1); else this.children([value]); })]);
    }
    if (name === undefined) throw new Unsupported(`<${choice}> has no value, so its message cannot be read statically`);
    this.choiceMessage(name, format, offset, cases);
  }
}

function attempt(build: () => LinguiMessage): LinguiExtraction {
  try { return build(); }
  catch (error) {
    if (error instanceof Unsupported) return { unsupported: error.message };
    throw error;
  }
}

/** Builds a message in both spellings: the exact one names it, the normalized one is the
 * alternative the lookup tries next. Values and slots are the same in both. */
function spelled(build: (spelling: Spelling) => LinguiMessage): LinguiExtraction {
  return attempt(() => {
    const exact = build('exact'), normalized = build('normalized');
    return normalized.source === exact.source ? exact : { ...exact, alternatives: [normalized.source] };
  });
}

const isChoiceCall = (node: Node, choices: LinguiChoiceNames): boolean =>
  node.type === 'CallExpression' && node.callee?.type === 'Identifier' && (choiceMacros.has(choices.get(node.callee.name) ?? '') || (!choices.has(node.callee.name) && choiceMacros.has(node.callee.name)));

function propertyName(property: Node): string | undefined {
  if (property.type !== 'ObjectProperty' || property.computed) return;
  return property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : undefined;
}

function staticText(node: Node): string | undefined {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
}

/** A descriptor object, `{ id?, message, comment?, context?, values? }`. Undefined when it is
 * not provably one, or when it has a static id and no placeholders, which the codemod
 * already migrates. */
function descriptorMessage(node: Node, code: string, choices: LinguiChoiceNames): LinguiExtraction | undefined {
  if (node.type !== 'ObjectExpression') return;
  let id: string | undefined, message: Node | undefined, values: Node | undefined, context: string | undefined;
  for (const property of node.properties as Node[]) {
    const name = propertyName(property);
    if (property.type === 'ObjectProperty' && property.shorthand && name === 'values') { values = property.value; continue; }
    if (name === undefined || !descriptorFields.has(name)) return;
    if (name === 'id') { id = staticText(property.value); if (id === undefined) return; }
    else if (name === 'message') message = property.value;
    else if (name === 'values') values = property.value;
    else if (name === 'context') { context = staticText(property.value); if (context === undefined) return; }
  }
  if (!message) return;
  const choice = isChoiceCall(message, choices);
  const placeholders = (message.type === 'TemplateLiteral' && message.expressions.length > 0) || choice;
  // A static id with a plain message and no values object is the codemod's id form.
  if (id !== undefined && !placeholders && values?.type !== 'ObjectExpression') return;
  if (message.type !== 'StringLiteral' && message.type !== 'TemplateLiteral' && !choice) return;
  return spelled(spelling => {
    const builder = new MessageBuilder(code, spelling, choices);
    if (message!.type === 'StringLiteral') builder.message = message!.value;
    else if (message!.type === 'TemplateLiteral') builder.template(message!);
    else builder.expression(message!);
    const result = builder.result(spelling === 'exact' ? builder.message : normalizeJsWhitespace(builder.message), id, context);
    if (!values) return result;
    if (values.type !== 'ObjectExpression') throw new Unsupported('descriptor values are not an object literal');
    const extra = (values.properties as Node[]).map(property => code.slice(property.start!, property.end!));
    return { ...result, values: [...result.values, ...extra] };
  });
}

/** A Lingui macro that names a message: `t\`…\``, `msg\`…\``, `msg({ message })`,
 * `defineMessage({ … })`, a bare descriptor, or a choice macro on its own,
 * `plural(count, { one: '# item', other: '# items' })`, which translates itself. Undefined for
 * anything else, including the static-id forms the codemod already handles. */
export function linguiMacroMessage(source: string, macroNames: ReadonlySet<string>, choices: LinguiChoiceNames = new Map()): LinguiExtraction | undefined {
  const node = expression(source);
  if (!node) return;
  if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && macroNames.has(node.tag.name)) {
    return spelled(spelling => {
      const builder = new MessageBuilder(source, spelling, choices);
      builder.template(node.quasi);
      return builder.result(spelling === 'exact' ? builder.message : normalizeJsWhitespace(builder.message));
    });
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && choiceMacros.has(choices.get(node.callee.name) ?? '')) {
    return spelled(spelling => {
      const builder = new MessageBuilder(source, spelling, choices);
      builder.expression(node);
      return builder.result(spelling === 'exact' ? builder.message : normalizeJsWhitespace(builder.message));
    });
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && macroNames.has(node.callee.name) && node.arguments.length === 1) return descriptorMessage(node.arguments[0], source, choices);
  return descriptorMessage(node, source, choices);
}

/** Whether an argument is a macro itself (`msg\`…\``, `defineMessage({ id })`): the translator
 * call reading it rewrites it, in whichever form. */
export function isLinguiMacro(source: string, macroNames: ReadonlySet<string>): boolean {
  const node = expression(source);
  const callee = node?.type === 'TaggedTemplateExpression' ? node.tag : node?.type === 'CallExpression' ? node.callee : undefined;
  return callee?.type === 'Identifier' && macroNames.has(callee.name);
}

function expression(source: string): Node | undefined {
  let node: Node;
  try { node = parseExpression(source, { plugins }) as unknown as Node; }
  catch { return; }
  while (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression') node = node.expression;
  return node;
}

/** Tagged-template macros in a file (`t\`…\``, `msg\`…\``), found by parsing, so a template
 * holding backticks or `${}` is read whole. Undefined when the file does not parse. */
export function linguiTaggedTemplates(text: string, tagNames: ReadonlySet<string>): Array<{ start: number; end: number; tag: string }> | undefined {
  let ast: Node;
  try { ast = parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins }) as unknown as Node; }
  catch { return; }
  const found: Array<{ start: number; end: number; tag: string }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const node = value as Node;
    if (typeof node.type !== 'string') return;
    if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && tagNames.has(node.tag.name)) found.push({ start: node.start!, end: node.end!, tag: node.tag.name });
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(ast.program);
  return found.sort((left, right) => left.start - right.start);
}

/** Choice macros used on their own (`plural(count, { … })` outside any other message), found by
 * parsing. One inside a template, a descriptor, another choice or a JSX element of Lingui's is
 * part of that message, so it is left to whatever reads it. Undefined when the file does not parse. */
export function linguiChoiceCalls(text: string, choices: LinguiChoiceNames, macroNames: ReadonlySet<string>): Array<{ start: number; end: number; name: string }> | undefined {
  if (![...choices.values()].some(name => choiceMacros.has(name))) return [];
  let ast: Node;
  try { ast = parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins }) as unknown as Node; }
  catch { return; }
  const found: Array<{ start: number; end: number; name: string }> = [];
  const lingui = (node: Node): boolean => {
    if (node.type === 'TaggedTemplateExpression') return node.tag.type === 'Identifier' && macroNames.has(node.tag.name);
    if (node.type === 'CallExpression') return node.callee.type === 'Identifier' && (macroNames.has(node.callee.name) || choices.has(node.callee.name));
    if (node.type === 'JSXElement') return node.openingElement.name.type === 'JSXIdentifier' && (node.openingElement.name.name === 'Trans' || choices.has(node.openingElement.name.name));
    return false;
  };
  const visit = (value: unknown, inside: boolean): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, inside); return; }
    const node = value as Node;
    if (typeof node.type !== 'string') return;
    if (!inside && node.type === 'CallExpression' && node.callee.type === 'Identifier' && choiceMacros.has(choices.get(node.callee.name) ?? '')) found.push({ start: node.start!, end: node.end!, name: node.callee.name });
    const within = inside || lingui(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      if (child && typeof child === 'object') visit(child, within);
    }
  };
  visit(ast.program, false);
  return found.sort((left, right) => left.start - right.start);
}

/** The message a `<Trans>` element's children make, or a `<Plural>`, `<Select>` or
 * `<SelectOrdinal>` on its own, with its explicit `id` when it has one. */
export function linguiTransMessage(source: string, transNames: ReadonlySet<string>, choices: LinguiChoiceNames = new Map()): LinguiExtraction | undefined {
  let node: Node;
  try { node = parseExpression(source, { plugins }) as unknown as Node; }
  catch { return; }
  if (node.type !== 'JSXElement') return;
  const elementName = node.openingElement.name.type === 'JSXIdentifier' ? node.openingElement.name.name as string : '';
  const choice = choiceComponents.has(choices.get(elementName) ?? '') ? choices.get(elementName)! : undefined;
  if (!choice && !node.children.length) return;
  let id: string | undefined, context: string | undefined, keyed = false;
  for (const attribute of node.openingElement.attributes as Node[]) {
    if (attribute.type !== 'JSXAttribute') return { unsupported: `<${choice ?? 'Trans'}> spreads its props, so its message cannot be read statically` };
    const name = attribute.name.type === 'JSXIdentifier' ? attribute.name.name as string : undefined;
    if (name === 'comment') continue;
    // React's key: a string in a list needs none, an element from rich() does.
    if (name === 'key') { keyed = true; continue; }
    if (name === 'context') {
      const value = attribute.value as Node | null;
      context = value?.type === 'StringLiteral' ? value.value : value?.type === 'JSXExpressionContainer' ? staticText(value.expression) : undefined;
      if (context === undefined) return;
      continue;
    }
    if (name === 'id') {
      const value = attribute.value as Node | null;
      id = value?.type === 'StringLiteral' ? value.value : value?.type === 'JSXExpressionContainer' ? staticText(value.expression) : undefined;
      if (id === undefined) return;
      continue;
    }
    // A choice's other props are its value, offset and cases, which the builder reads.
    if (choice && name !== 'render' && name !== 'i18n') continue;
    if (choice) return { unsupported: `<${choice}> with a ${name} prop needs a manual migration` };
    return;
  }
  return spelled(spelling => {
    const builder = new MessageBuilder(source, spelling, choices, transNames);
    if (choice) builder.choiceElement(node, choice);
    else builder.children(node.children);
    if (keyed && builder.slots.length) throw new Unsupported(`a keyed <${choice ?? 'Trans'}> holding elements becomes rich(), which needs a keyed wrapper; migrate it manually`);
    return builder.result(spelling === 'exact' ? builder.message : normalizeWhitespace(builder.message), id, context);
  });
}

/** The catalog ID a message resolves to, or why it does not. */
export function resolveLinguiMessage(message: LinguiMessage, lookup: LinguiLookup): { id: string } | { reason: string; code?: string } {
  let id = message.id !== undefined ? lookup.renamed(message.id) : undefined;
  if (id === undefined) {
    const { source, context } = message;
    // The catalog migration renames numbered tags (`<0>` is `<tag0>`), so a map built from
    // migrated catalogs holds the renamed text. A context entry is `context\u0004source`, as in gettext.
    // The exact spelling comes first, then the normalized one.
    const texts = [...new Set([source, ...(message.alternatives ?? [])].flatMap(text => [text, text.replace(/<(\d+)\/>/g, '<tag$1></tag$1>').replace(/<(\/?)(\d+)>/g, '<$1tag$2>')]))];
    for (const key of [...(context === undefined ? [] : texts.map(text => `${context}\u0004${text}`)), ...texts]) {
      id = lookup.sourceIds.get(key);
      if (id !== undefined) break;
    }
    // A migrated Lingui catalog names an entry by its text, and by `context.text` when it has a context.
    for (const text of [source, ...(message.alternatives ?? [])]) {
      if (id !== undefined) break;
      const catalogId = lookup.renamed(context === undefined ? text : `${context}.${text}`);
      if (lookup.allowedIds?.has(catalogId)) id = catalogId;
    }
  }
  if (id === undefined) return { reason: `Lingui source macro needs an unambiguous catalog source-to-id mapping for ${JSON.stringify(message.source)}${message.context === undefined ? '' : ` in context ${JSON.stringify(message.context)}`}` };
  if (lookup.allowedIds && !lookup.allowedIds.has(id)) return { reason: `message id ${JSON.stringify(id)} is absent from generated message types`, code: 'UNKNOWN_MESSAGE_ID' };
  return { id };
}

/** The values argument for a message call, `{ name, 0: expression }`, or empty. */
export function linguiValues(message: LinguiMessage): string {
  return message.values.length ? `{ ${message.values.join(', ')} }` : '';
}

/** What a message macro becomes. `msg` and `defineMessage` are lazy, translated where the
 * descriptor is read, so they become the message function rather than a string fixed in
 * whichever locale was active when the module loaded. */
export function linguiCall(access: string, values: string, lazy: boolean): string {
  if (!lazy) return `${access}(${values})`;
  return values ? `(() => ${access}(${values}))` : access;
}
