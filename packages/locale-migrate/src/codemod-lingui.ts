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

// Lingui's normalizeWhitespace for JSX messages: a line break and the indentation around it
// next to a tag or a placeholder disappear, any other becomes one space.
const stripAroundTags = /(?:([>}])(?:\r\n|\r|\n)+\s*|(?:\r\n|\r|\n)+\s*(?=[<{]))/g;
const keepSpace = /\s*(?:\r\n|\r|\n)+\s*/g;

function normalizeWhitespace(text: string): string {
  return text.replace(stripAroundTags, '$1').replace(keepSpace, ' ').replace(/\\n/g, '\n').replace(/\\s/g, ' ').replace(/(\s+})/gm, '}').trim();
}

class MessageBuilder {
  message = '';
  private readonly values = new Map<string, string>();
  readonly slots: string[] = [];
  private position = 0;
  private element = 0;
  private readonly nested: number[] = [];

  constructor(private readonly code: string, private readonly transNames: ReadonlySet<string> = new Set()) {}

  private slice(node: Node): string { return this.code.slice(node.start!, node.end!); }

  result(source: string, id?: string, context?: string): LinguiMessage {
    const values = [...this.values].map(([name, expression]) => name === expression ? name : `${/^(?:\d+|[A-Za-z_$][\w$]*)$/.test(name) ? name : JSON.stringify(name)}: ${expression}`);
    return { ...(id === undefined ? {} : { id }), source, ...(context === undefined ? {} : { context }), values, slots: this.slots, ...(this.nested.length ? { nested: this.nested } : {}) };
  }

  /** `${name}` is `{name}`; any other expression takes the next position, `{0}`, `{1}`… */
  expression(node: Node): void {
    if (node.type === 'Identifier') {
      this.values.set(node.name, node.name);
      this.message += `{${node.name}}`;
      return;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
      if (choiceMacros.has(node.callee.name)) throw new Unsupported(`Lingui ${node.callee.name}() inside a message needs a manual migration to an ICU plural or select`);
      // Lingui 5 labels a placeholder with ph({ label: value }).
      const [argument] = node.arguments ?? [];
      if (node.callee.name === 'ph' && node.arguments.length === 1 && argument.type === 'ObjectExpression' && argument.properties.length === 1) {
        const property = argument.properties[0];
        const label = property.type === 'ObjectProperty' && !property.computed ? property.key.type === 'Identifier' ? property.key.name : property.key.value : undefined;
        if (typeof label === 'string') {
          this.values.set(label, this.slice(property.value));
          this.message += `{${label}}`;
          return;
        }
      }
    }
    const name = String(this.position++);
    this.values.set(name, this.slice(node));
    this.message += `{${name}}`;
  }

  /** A template literal's text is its raw source, as the macro reads it. */
  template(node: Node, jsx = false): void {
    node.quasis.forEach((quasi: Node, index: number) => {
      const raw = quasi.value.raw as string;
      let text = (/\\u[a-fA-F0-9]{4}|\\x[a-fA-F0-9]{2}/.test(raw) ? quasi.value.cooked as string : raw).replace(/\\`/g, '`');
      if (jsx) text = text.replace(/\n/g, '\\n');
      this.message += text;
      const expression = node.expressions[index];
      if (expression) this.expression(expression);
    });
  }

  children(nodes: readonly Node[]): void {
    for (const child of nodes) {
      if (child.type === 'JSXText') this.message += child.value;
      else if (child.type === 'JSXExpressionContainer') {
        const expression = child.expression as Node;
        if (expression.type === 'JSXEmptyExpression') continue;
        if (expression.type === 'StringLiteral') this.message += (expression.value as string).replace(/\n/g, '\\n');
        else if (expression.type === 'TemplateLiteral') this.template(expression, true);
        else if (expression.type === 'JSXElement') this.jsxElement(expression);
        else if (expression.type === 'JSXFragment') throw new Unsupported('a fragment inside <Trans> needs a manual rich-message migration');
        else this.expression(expression);
      } else if (child.type === 'JSXElement') this.jsxElement(child);
      else if (child.type === 'JSXFragment') throw new Unsupported('a fragment inside <Trans> needs a manual rich-message migration');
    }
  }

  /** Elements are numbered in the order they open, outer before inner, as `<0>…</0>` or `<0/>`.
   * The catalog migration renames them `tag0`, so each becomes a rich() slot. */
  private jsxElement(node: Node): void {
    const opening = node.openingElement as Node;
    const name = this.slice(opening.name);
    if (choiceComponents.has(name)) throw new Unsupported(`<${name}> inside <Trans> needs a manual migration to an ICU plural or select`);
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
}

function attempt(build: () => LinguiMessage): LinguiExtraction {
  try { return build(); }
  catch (error) {
    if (error instanceof Unsupported) return { unsupported: error.message };
    throw error;
  }
}

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
function descriptorMessage(node: Node, code: string): LinguiExtraction | undefined {
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
  const placeholders = message.type === 'TemplateLiteral' && message.expressions.length > 0;
  // A static id with a plain message and no values object is the codemod's id form.
  if (id !== undefined && !placeholders && values?.type !== 'ObjectExpression') return;
  if (message.type === 'CallExpression' && message.callee?.type === 'Identifier' && choiceMacros.has(message.callee.name)) return { unsupported: `Lingui ${message.callee.name}() inside a message needs a manual migration to an ICU plural or select` };
  if (message.type !== 'StringLiteral' && message.type !== 'TemplateLiteral') return;
  return attempt(() => {
    const builder = new MessageBuilder(code);
    if (message!.type === 'StringLiteral') builder.message = message!.value;
    else builder.template(message!);
    const result = builder.result(builder.message, id, context);
    if (!values) return result;
    if (values.type !== 'ObjectExpression') throw new Unsupported('descriptor values are not an object literal');
    const extra = (values.properties as Node[]).map(property => code.slice(property.start!, property.end!));
    return { ...result, values: [...result.values, ...extra] };
  });
}

/** A Lingui macro that names a message: `t\`…\``, `msg\`…\``, `msg({ message })`,
 * `defineMessage({ … })` or a bare descriptor. Undefined for anything else, including the
 * static-id forms the codemod already handles. */
export function linguiMacroMessage(source: string, macroNames: ReadonlySet<string>): LinguiExtraction | undefined {
  const node = expression(source);
  if (!node) return;
  if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && macroNames.has(node.tag.name)) {
    return attempt(() => {
      const builder = new MessageBuilder(source);
      builder.template(node.quasi);
      return builder.result(builder.message);
    });
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && macroNames.has(node.callee.name) && node.arguments.length === 1) return descriptorMessage(node.arguments[0], source);
  return descriptorMessage(node, source);
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

/** The message a `<Trans>` element's children make, with its explicit `id` when it has one. */
export function linguiTransMessage(source: string, transNames: ReadonlySet<string>): LinguiExtraction | undefined {
  let node: Node;
  try { node = parseExpression(source, { plugins }) as unknown as Node; }
  catch { return; }
  if (node.type !== 'JSXElement' || !node.children.length) return;
  let id: string | undefined, context: string | undefined, keyed = false;
  for (const attribute of node.openingElement.attributes as Node[]) {
    if (attribute.type !== 'JSXAttribute') return { unsupported: '<Trans> spreads its props, so its message cannot be read statically' };
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
    return;
  }
  return attempt(() => {
    const builder = new MessageBuilder(source, transNames);
    builder.children(node.children);
    if (keyed && builder.slots.length) throw new Unsupported('a keyed <Trans> holding elements becomes rich(), which needs a keyed wrapper; migrate it manually');
    return builder.result(normalizeWhitespace(builder.message), id, context);
  });
}

/** The catalog ID a message resolves to, or why it does not. */
export function resolveLinguiMessage(message: LinguiMessage, lookup: LinguiLookup): { id: string } | { reason: string; code?: string } {
  let id = message.id !== undefined ? lookup.renamed(message.id) : undefined;
  if (id === undefined) {
    const { source, context } = message;
    // The catalog migration renames numbered tags (`<0>` is `<tag0>`), so a map built from
    // migrated catalogs holds the renamed text. A context entry is `context\u0004source`, as in gettext.
    const texts = [...new Set([source, source.replace(/<(\d+)\/>/g, '<tag$1></tag$1>').replace(/<(\/?)(\d+)>/g, '<$1tag$2>')])];
    for (const key of [...(context === undefined ? [] : texts.map(text => `${context}\u0004${text}`)), ...texts]) {
      id = lookup.sourceIds.get(key);
      if (id !== undefined) break;
    }
    // A migrated Lingui catalog names an entry by its text, and by `context.text` when it has a context.
    const catalogId = lookup.renamed(context === undefined ? source : `${context}.${source}`);
    if (id === undefined && lookup.allowedIds?.has(catalogId)) id = catalogId;
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
