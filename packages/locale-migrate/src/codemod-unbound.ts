import { parse } from '@babel/parser';

/** Where a translator that no recognized hook binds comes from. */
export type TranslatorSource = 'parameter' | 'props' | 'local';

export interface UnboundTranslatorCall {
  /** Offset of the callee, the same anchor the codemod's other diagnostics use. */
  readonly start: number;
  readonly callee: string;
  readonly source: TranslatorSource;
  /** What the translator is: the parameter's type, `this.props`, or the local's initializer. */
  readonly detail: string;
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };
type Format = 'i18next' | 'formatjs' | 'lingui' | 'next-intl';

// A file must reference the library before its `t(…)` calls count as translations.
const libraries: Record<Format, RegExp> = {
  i18next: /['"](?:i18next|react-i18next|next-i18next)(?:\/[^'"\n]*)?['"]|\bTFunction\b/,
  formatjs: /['"](?:react-intl|@formatjs\/[^'"\n]+)['"]|\bIntlShape\b/,
  lingui: /['"]@lingui\/[^'"\n]+['"]/,
  'next-intl': /['"]next-intl(?:\/[^'"\n]*)?['"]/,
};
// A parameter with one of these types is a translator whatever its name.
const translatorTypes: Record<Format, RegExp> = {
  i18next: /\bTFunction\b/,
  formatjs: /\bIntlShape\b|\bWrappedComponentProps\b|\buseIntl\b|\bformatMessage\b/,
  lingui: /\bI18n\b/,
  'next-intl': /\b(?:useTranslations|getTranslations|createTranslator)\b/,
};
// The hooks the codemod binds; what they return is its job, not this pass's.
const hooks = new Set(['useTranslation', 'useTranslations', 'getTranslations', 'useIntl', 'useLingui']);
// An initializer that mentions one of these makes the names it declares translators.
const factories = /\b(?:useTranslation|useTranslations|getTranslations|getFixedT|createTranslator|useIntl|createIntl|useLingui|getI18nInstance|setupI18n|getI18n)\b/;
const skippedKeys = new Set(['loc', 'start', 'end', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters', 'implements']);
const hocs = /^(?:React\.)?(?:memo|forwardRef)$|^(?:observer|withTranslation|translate|injectIntl|withI18n|withLingui|connect)\b/;

type Binding =
  | { kind: 'param'; type: string; component: boolean; destructured: boolean; name: string }
  | { kind: 'var'; init: Node | undefined; pattern: boolean; scopes: readonly Scope[] }
  | { kind: 'import' } | { kind: 'function' } | { kind: 'class' };
type Scope = Map<string, Binding>;
type Origin = { source: TranslatorSource; detail: string; type?: string; factory?: boolean } | 'hook' | 'import' | 'function' | undefined;

const unwrap = (node: Node | undefined): Node | undefined => {
  let current = node;
  while (current && /^(?:TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|ParenthesizedExpression|TypeCastExpression|AwaitExpression)$/.test(current.type)) current = (current.expression ?? current.argument) as Node | undefined;
  return current;
};
const rootOf = (node: Node | undefined): Node | undefined => {
  let current = unwrap(node);
  while (current && (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression')) current = unwrap(current.object as Node);
  return current;
};
const propertyName = (node: Node): string | undefined => {
  if (node.computed) return (node.property as Node).type === 'StringLiteral' ? (node.property as Node).value as string : undefined;
  return (node.property as Node).type === 'Identifier' ? (node.property as Node).name as string : undefined;
};
const patternNames = (pattern: Node | null | undefined, result: string[] = []): string[] => {
  if (!pattern) return result;
  if (pattern.type === 'Identifier') result.push(pattern.name as string);
  else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties as Node[]) patternNames(property.type === 'RestElement' ? property.argument as Node : property.value as Node, result);
  else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements as Array<Node | null>) patternNames(element, result);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left as Node, result);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument as Node, result);
  else if (pattern.type === 'TSParameterProperty') patternNames(pattern.parameter as Node, result);
  return result;
};
const isFunction = (node: Node): boolean => /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/.test(node.type);

/** Calls whose translator a parameter, component props or a local provides, in the formats
 * the file references. The caller drops the calls it already rewrote or reported. */
export function unboundTranslatorCalls(text: string, formats: readonly string[]): UnboundTranslatorCall[] {
  const active = (['i18next', 'formatjs', 'lingui', 'next-intl'] as const).filter(format => formats.includes(format) && libraries[format].test(text));
  if (!active.length) return [];
  let program: Node;
  try { program = (parse(text, { sourceType: 'unambiguous', errorRecovery: false, plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] }) as unknown as { program: Node }).program; }
  catch { return []; }
  const source = (node: Node): string => text.slice(node.start, node.end);
  const compact = (node: Node): string => source(node).replace(/\s+/g, ' ').slice(0, 80);
  // The part of a parameter's type that can name a translator: `TFunction`, `IntlShape`,
  // `IntlShape['formatMessage']`, `ReturnType<typeof useIntl>['formatMessage']`, optionally
  // `| undefined`. A function or object type that merely mentions one (a callback taking
  // `t: TFunction`) is no translator, and neither is `Wrapper<TFunction>`.
  const translatorType = (annotation: Node): string => {
    let node: Node | undefined = annotation;
    if (node.type === 'TSUnionType') {
      const members = (node.types as Node[]).filter(member => !/^TS(?:Undefined|Null)Keyword$/.test(member.type));
      node = members.length === 1 ? members[0] : undefined;
    }
    if (node?.type === 'NullableTypeAnnotation') node = node.typeAnnotation as Node;
    if (!node) return '';
    if (/^(?:TSIndexedAccessType|TSTypeQuery|IndexedAccessType)$/.test(node.type)) return source(node);
    if (node.type !== 'TSTypeReference' && node.type !== 'GenericTypeAnnotation') return '';
    const name = source((node.typeName ?? node.id) as Node);
    return /^(?:ReturnType|Awaited)$/.test(name) ? source(node) : name;
  };
  const stack: Scope[] = [new Map()];
  const lookup = (name: string, scopes: readonly Scope[] = stack): Binding | undefined => {
    for (let index = scopes.length - 1; index >= 0; index--) { const found = scopes[index]!.get(name); if (found) return found; }
  };
  const declare = (scope: Scope, statement: Node): void => {
    if (statement.type === 'VariableDeclaration') for (const declarator of statement.declarations as Node[]) {
      const id = declarator.id as Node, pattern = id.type !== 'Identifier';
      for (const name of patternNames(id)) scope.set(name, { kind: 'var', init: declarator.init as Node | undefined, pattern, scopes: stack.slice() });
    } else if (statement.type === 'FunctionDeclaration' && statement.id) scope.set((statement.id as Node).name as string, { kind: 'function' });
    else if (statement.type === 'ClassDeclaration' && statement.id) scope.set((statement.id as Node).name as string, { kind: 'class' });
    else if (statement.type === 'ImportDeclaration') for (const specifier of statement.specifiers as Node[]) scope.set((specifier.local as Node).name as string, { kind: 'import' });
    else if (/^Export(?:Named|Default)Declaration$/.test(statement.type) && statement.declaration) declare(scope, statement.declaration as Node);
  };
  // What a name is bound to, followed through aliases (`const tr = t`, `const { t } = this.props`).
  const origin = (name: string, scopes: readonly Scope[] = stack, depth = 0): Origin => {
    const binding = lookup(name, scopes);
    if (!binding || depth > 8) return;
    if (binding.kind === 'import' || binding.kind === 'function' || binding.kind === 'class') return binding.kind === 'class' ? undefined : binding.kind;
    if (binding.kind === 'param') return binding.component && binding.destructured || binding.name === 'props'
      ? { source: 'props', detail: 'component props', type: binding.type }
      : { source: 'parameter', detail: binding.type ? `a parameter typed ${binding.type}` : 'a function parameter', type: binding.type };
    const init = unwrap(binding.init);
    if (!init) return { source: 'local', detail: 'a local variable' };
    if (init.type === 'CallExpression') {
      const callee = unwrap(init.callee as Node)!;
      const called = callee.type === 'Identifier' ? callee.name as string : callee.type === 'MemberExpression' ? propertyName(callee) : undefined;
      if (called && hooks.has(called)) return 'hook';
    }
    if (/^(?:ArrowFunctionExpression|FunctionExpression)$/.test(init.type)) return 'function';
    if (init.type === 'Identifier' || init.type === 'MemberExpression' || init.type === 'ThisExpression') {
      const root = rootOf(init);
      if (root?.type === 'ThisExpression') return /\.props\b/.test(source(init)) || (init.type === 'MemberExpression' && propertyName(init) === 'props') ? { source: 'props', detail: 'this.props' } : undefined;
      if (root?.type === 'Identifier') {
        const inherited = origin(root.name as string, binding.scopes, depth + 1);
        if (inherited && typeof inherited === 'object' && (root.name === 'props' || source(init).includes('props'))) return { ...inherited, source: inherited.source === 'local' ? 'local' : 'props' };
        return inherited;
      }
    }
    return { source: 'local', detail: compact(binding.init!), factory: factories.test(source(init)) };
  };

  // Whether a call's callee is a translator of `format`, given the origin of its root.
  const translator = (format: Format, callee: Node, found: Exclude<Origin, 'hook' | 'import' | 'function' | undefined>): boolean => {
    const typed = !!found.type && translatorTypes[format].test(found.type);
    if (callee.type === 'Identifier') {
      const name = callee.name as string;
      if (typed) return format !== 'formatjs' || /formatMessage/.test(found.type!);
      if (format === 'i18next') return name === 't';
      if (format === 'formatjs') return name === 'formatMessage';
      if (format === 'lingui') return name === '_';
      return name === 't' || (found.source === 'local' && !!found.factory && /^[a-z][\w$]*T$/.test(name));
    }
    const member = propertyName(callee), object = unwrap(callee.object as Node)!;
    const objectName = object.type === 'Identifier' ? object.name as string : object.type === 'MemberExpression' ? propertyName(object) : undefined;
    const viaProps = /(?:^|\.)props$/.test(source(object).replace(/\s+/g, '')) || found.source === 'props';
    if (format === 'i18next') return member === 't' && (typed || objectName === 'i18n' || objectName === 'i18next' || (viaProps && objectName === 'props'));
    if (format === 'formatjs') return member === 'formatMessage' && (typed || objectName === 'intl');
    if (format === 'lingui') return (member === '_' || member === 't') && (typed || objectName === 'i18n');
    return !!member && /^(?:rich|markup|raw|has)$/.test(member) && object.type === 'Identifier'
      && (typed || objectName === 't' || (found.source === 'local' && !!found.factory && /^[a-z][\w$]*T$/.test(objectName ?? '')));
  };

  const result: UnboundTranslatorCall[] = [], seen = new Set<number>();
  const report = (call: Node): void => {
    const callee = unwrap(call.callee as Node);
    if (!callee || (callee.type !== 'Identifier' && callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')) return;
    if (callee.type !== 'Identifier' && callee.computed) return;
    const root = rootOf(callee);
    let found: Origin;
    if (root?.type === 'ThisExpression') found = /^this\.props\./.test(source(callee).replace(/\s+/g, '')) ? { source: 'props', detail: 'this.props' } : undefined;
    else if (root?.type === 'Identifier') found = origin(root.name as string);
    if (!found || typeof found !== 'object') return;
    if (!active.some(format => translator(format, callee, found))) return;
    if (seen.has(callee.start)) return;
    seen.add(callee.start);
    result.push({ start: callee.start, callee: source(callee).replace(/\s+/g, ''), source: found.source, detail: found.detail });
  };

  const visitChildren = (node: Node, parent: Node | undefined, hint?: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (skippedKeys.has(key) || !child || typeof child !== 'object') continue;
      const childHint = node.type === 'VariableDeclarator' && key === 'init' ? ((node.id as Node).type === 'Identifier' ? (node.id as Node).name as string : undefined)
        : node.type === 'CallExpression' && key === 'arguments' && hocs.test(source(node.callee as Node)) ? hint ?? 'Component'
        : /^(?:TSAsExpression|TSSatisfiesExpression|ParenthesizedExpression)$/.test(node.type) ? hint : undefined;
      if (Array.isArray(child)) { for (const item of child) if (item && typeof item === 'object' && typeof (item as Node).type === 'string') visit(item as Node, node, childHint); }
      else if (typeof (child as Node).type === 'string') visit(child as Node, node, childHint);
    }
    void parent;
  };
  const visitBlock = (node: Node, statements: Node[], parent: Node | undefined): void => {
    const scope: Scope = new Map();
    stack.push(scope);
    for (const statement of statements) declare(scope, statement);
    visitChildren(node, parent);
    stack.pop();
  };
  const visit = (node: Node, parent?: Node, hint?: string): void => {
    if (node.type === 'Program') { for (const statement of node.body as Node[]) declare(stack[0]!, statement); visitChildren(node, parent); return; }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') report(node);
    if (isFunction(node)) {
      const id = node.id as Node | undefined, key = node.key as Node | undefined;
      const name = (id?.name as string | undefined) ?? (/Method$/.test(node.type) ? undefined : hint);
      const component = !!name && /^[A-Z]/.test(name);
      const scope: Scope = new Map();
      (node.params as Node[]).forEach(param => {
        const annotation = ((param.typeAnnotation ?? (param.left as Node | undefined)?.typeAnnotation) as Node | undefined)?.typeAnnotation as Node | undefined;
        const destructured = param.type === 'ObjectPattern' || (param.left as Node | undefined)?.type === 'ObjectPattern';
        for (const paramName of patternNames(param)) scope.set(paramName, { kind: 'param', type: annotation && !destructured ? translatorType(annotation) : '', component, destructured, name: paramName });
      });
      stack.push(scope);
      const body = node.body as Node;
      if (body?.type === 'BlockStatement') for (const statement of body.body as Node[]) declare(scope, statement);
      for (const param of node.params as Node[]) visit(param, node);
      // A block body shares the parameters' scope; an expression body is visited as a node.
      if (body?.type === 'BlockStatement') visitChildren(body, node);
      else if (body) visit(body, node);
      stack.pop();
      void key;
      return;
    }
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock') { visitBlock(node, node.body as Node[], parent); return; }
    if (node.type === 'CatchClause') {
      const scope: Scope = new Map();
      for (const name of patternNames(node.param as Node | null)) scope.set(name, { kind: 'var', init: undefined, pattern: false, scopes: stack.slice() });
      stack.push(scope); visitChildren(node, parent); stack.pop();
      return;
    }
    if (/^For(?:In|Of)?Statement$/.test(node.type)) {
      const scope: Scope = new Map();
      const init = (node.init ?? node.left) as Node | undefined;
      if (init?.type === 'VariableDeclaration') for (const declarator of init.declarations as Node[]) for (const name of patternNames(declarator.id as Node)) scope.set(name, { kind: 'var', init: undefined, pattern: false, scopes: stack.slice() });
      stack.push(scope); visitChildren(node, parent); stack.pop();
      return;
    }
    visitChildren(node, parent, hint);
  };
  visit(program);
  return result.sort((left, right) => left.start - right.start);
}

const reasons: Record<TranslatorSource, (call: UnboundTranslatorCall) => string> = {
  parameter: call => `translator ${call.callee} comes from ${call.detail}, not a hook the codemod binds, so the call was not rewritten`,
  props: call => `translator ${call.callee} comes from ${call.detail === 'this.props' ? 'this.props' : 'component props'} (an HOC such as withTranslation or injectIntl, or a parent component), not a hook the codemod binds, so the call was not rewritten`,
  local: call => `translator ${call.callee} comes from a local value (${call.detail}), not a hook the codemod binds, so the call was not rewritten`,
};

/** UNBOUND_TRANSLATOR diagnostics for the calls of `unboundTranslatorCalls` that no
 * replacement covers and no other diagnostic already names. */
export function unboundTranslatorSkips(text: string, formats: readonly string[], replacements: readonly { start: number; end: number }[], skipped: readonly { offset?: number }[]): Array<{ callee: string; reason: string; offset: number; code: string; action: string }> {
  const reported = new Set(skipped.map(item => item.offset));
  return unboundTranslatorCalls(text, formats)
    .filter(call => !reported.has(call.start) && !replacements.some(replacement => call.start >= replacement.start && call.start < replacement.end))
    .map(call => ({
      callee: call.callee, reason: reasons[call.source](call), offset: call.start, code: 'UNBOUND_TRANSLATOR',
      action: 'Pass the messages object or the message functions to this code instead of the translator (see "Pass message functions, not IDs" in the migration skill), or bind the translation hook in this component, then re-run the codemod. Name a wrapper hook with --custom-call.',
    }));
}
