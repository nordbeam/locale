import type { ESTree } from 'vite';
import { indexBindings } from './bindings.js';
import type { Binding, BindingIndex, Identifier } from './bindings.js';

type Property = Extract<ESTree.Node, { type: 'Property' }>;

/** Stable machine-readable reasons for an automatic selection falling back to
 * the full catalog. Keep these codes independent from the user-facing copy:
 * they are useful to tests, editor integrations and future diagnostics. */
export type SelectionFallbackReason =
  | 'mutable-binding'
  | 'loaded-result-retained'
  | 'message-object-escapes'
  | 'exported-binding'
  | 'dynamic-access'
  | 'unsupported-property-use'
  | 'ambiguous-loader-binding'
  | 'direct-eval';

export type InferenceResult =
  | { kind: 'selected'; keys: string[] }
  | { kind: 'full'; reason: SelectionFallbackReason };

export type NestedAccess = { start: number; baseEnd: number; end: number; key: string };

function propertyName(node: Property | ESTree.MemberExpression): string | undefined {
  const key = node.type === 'Property' ? node.key : node.property;
  if (!node.computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
}

function parentOf(index: BindingIndex, node: ESTree.Node): ESTree.Node | undefined {
  return index.parents.get(node);
}

function isAssignmentReference(parent: ESTree.Node | undefined, reference: Identifier): boolean {
  if (!parent) return false;
  if (parent.type === 'AssignmentExpression' && parent.left === reference) return true;
  if (parent.type === 'UpdateExpression' && parent.argument === reference) return true;
  return false;
}

function classifyReference(index: BindingIndex, reference: Identifier, object: boolean): SelectionFallbackReason | undefined {
  const parent = parentOf(index, reference);
  if (!parent) return 'message-object-escapes';
  if (isAssignmentReference(parent, reference)) return 'message-object-escapes';
  if (parent.type === 'ExportSpecifier' && parent.local === reference) return 'exported-binding';
  if (parent.type === 'ExportDefaultDeclaration') return 'exported-binding';

  if (object && parent.type === 'MemberExpression' && parent.object === reference) {
    const key = propertyName(parent);
    if (key === undefined) return 'dynamic-access';
    const use = parentOf(index, parent);
    if (use?.type === 'CallExpression' && use.callee === parent) return;
    if (use?.type === 'UnaryExpression' && use.operator === 'delete') return 'dynamic-access';
    // A message function that is retained or passed to another operation is
    // just as much an escape as retaining the messages object itself.
    if (use?.type === 'VariableDeclarator' && isExported(index, use)) return 'exported-binding';
    if (use?.type === 'VariableDeclarator' || use?.type === 'ReturnStatement'
      || use?.type === 'Property' || use?.type === 'CallExpression'
      || use?.type === 'ArrayExpression' || use?.type === 'AssignmentExpression') return 'message-object-escapes';
    // A literal property is still unsafe when it is retained, passed around,
    // accessed through a second property (m.greeting.call), assigned, etc.
    return 'unsupported-property-use';
  }
  if (!object && parent.type === 'CallExpression' && parent.callee === reference) return;

  // Reflection, spread and deletion make the set of reached messages
  // unknowable even when the AST contains a few literal accesses.
  if (parent.type === 'CallExpression') {
    const callee = parent.callee;
    if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
      && ['keys', 'values', 'entries', 'assign'].includes(propertyName(callee) ?? '')) return 'dynamic-access';
  }
  if (parent.type === 'SpreadElement' || parent.type === 'UnaryExpression' && parent.operator === 'delete') return 'dynamic-access';
  return object ? 'message-object-escapes' : 'message-object-escapes';
}

function callsOnly(index: BindingIndex, binding: Identifier, object: boolean): { keys?: string[]; accesses?: NestedAccess[]; reason?: SelectionFallbackReason } {
  const resolved = index.bindings.get(binding);
  if (!resolved || resolved.declarations.size !== 1) return { reason: 'ambiguous-loader-binding' };
  const keys = new Set<string>();
  const accesses: NestedAccess[] = [];
  for (const reference of resolved.references) {
    if (object) {
      let member = parentOf(index, reference);
      if (member?.type !== 'MemberExpression' || member.object !== reference) {
        return { reason: classifyReference(index, reference, true) ?? 'message-object-escapes' };
      }
      const parts: string[] = [];
      while (member.type === 'MemberExpression') {
        const key = propertyName(member);
        if (key === undefined) return { reason: 'dynamic-access' };
        parts.push(key);
        const parent = parentOf(index, member);
        if (parent?.type === 'MemberExpression' && parent.object === member) member = parent;
        else {
          if (parent?.type !== 'CallExpression' || parent.callee !== member) return { reason: 'unsupported-property-use' };
          break;
        }
      }
      if (parts.length > 1 && ['call', 'apply', 'bind'].includes(parts.at(-1)!)) {
        return { reason: 'unsupported-property-use' };
      }
      const key = parts.join('.');
      keys.add(key);
      if (parts.length > 1) accesses.push({ start: reference.start, baseEnd: reference.end, end: member.end, key });
      continue;
    }
    const parent = parentOf(index, reference);
    const reason = classifyReference(index, reference, object);
    if (reason) return { reason };
  }
  return { keys: [...keys], accesses };
}

function importedLoaderBindings(ast: ESTree.Program, loaders: ReadonlySet<string>, index: BindingIndex): Set<Binding> {
  const imported = new Set<Binding>();
  for (const node of ast.body) if (node.type === 'ImportDeclaration') {
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || !loaders.has(specifier.local.name)) continue;
      const binding = index.bindings.get(specifier.local);
      if (binding) imported.add(binding);
    }
  }
  return imported;
}

function isExported(index: BindingIndex, node: ESTree.Node): boolean {
  // Being declared inside an exported function does not export the local
  // loader result. Only an export declaration directly wrapping this
  // variable declaration makes the binding public.
  const parent = parentOf(index, node);
  return parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration';
}

function inferCall(index: BindingIndex, call: ESTree.CallExpression, nested?: Map<ESTree.CallExpression, NestedAccess[]>): InferenceResult {
  if (index.dynamic) return { kind: 'full', reason: 'direct-eval' };
  const loader = index.bindings.get(call.callee as Identifier);
  if (!loader || loader.declarations.size !== 1) return { kind: 'full', reason: 'ambiguous-loader-binding' };
  if ([...loader.references].some(reference => isAssignmentReference(parentOf(index, reference), reference))) {
    return { kind: 'full', reason: 'ambiguous-loader-binding' };
  }

  const awaited = parentOf(index, call);
  if (awaited?.type !== 'AwaitExpression' || awaited.argument !== call) return { kind: 'full', reason: 'loaded-result-retained' };
  const declaration = parentOf(index, awaited);
  if (declaration?.type !== 'VariableDeclarator') return { kind: 'full', reason: 'loaded-result-retained' };
  const statement = parentOf(index, declaration);
  if (isExported(index, statement ?? declaration)) return { kind: 'full', reason: 'exported-binding' };
  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const') return { kind: 'full', reason: 'mutable-binding' };
  if (declaration.id.type !== 'ObjectPattern') return { kind: 'full', reason: 'loaded-result-retained' };

  let messages: ESTree.Node | undefined;
  for (const property of declaration.id.properties) {
    if (property.type === 'RestElement') return { kind: 'full', reason: 'loaded-result-retained' };
    if (property.type !== 'Property') return { kind: 'full', reason: 'unsupported-property-use' };
    const name = propertyName(property);
    if (name === 'messages' && messages === undefined) messages = property.value;
    else if (name !== 'locale' || property.value.type !== 'Identifier') return { kind: 'full', reason: 'unsupported-property-use' };
  }
  if (!messages) return { kind: 'full', reason: 'unsupported-property-use' };

  if (messages.type === 'Identifier') {
    const outcome = callsOnly(index, messages, true);
    if (outcome.reason || !outcome.keys?.length) return { kind: 'full', reason: outcome.reason ?? 'unsupported-property-use' };
    if (outcome.accesses?.length) nested?.set(call, outcome.accesses);
    return { kind: 'selected', keys: [...new Set(outcome.keys)].sort() };
  }
  if (messages.type !== 'ObjectPattern') return { kind: 'full', reason: 'unsupported-property-use' };
  const keys: string[] = [];
  for (const property of messages.properties) {
    if (property.type === 'RestElement' || property.type !== 'Property' || property.value.type !== 'Identifier') {
      return { kind: 'full', reason: 'unsupported-property-use' };
    }
    const key = propertyName(property);
    if (key === undefined) return { kind: 'full', reason: 'dynamic-access' };
    const outcome = callsOnly(index, property.value, false);
    if (outcome.reason || outcome.keys === undefined) return { kind: 'full', reason: outcome.reason ?? 'unsupported-property-use' };
    keys.push(key);
  }
  return keys.length ? { kind: 'selected', keys: [...new Set(keys)].sort() } : { kind: 'full', reason: 'unsupported-property-use' };
}

/** Analyze every recognized imported loadLocale call, including calls that
 * must retain the full catalog. This is intentionally separate from the
 * legacy success-only inferSelections helper below. */
export function inferSelectionResults(ast: ESTree.Program, loaders: ReadonlySet<string>, index?: BindingIndex,
  nested?: Map<ESTree.CallExpression, NestedAccess[]>): Map<ESTree.CallExpression, InferenceResult> {
  index ??= indexBindings(ast, true);
  const result = new Map<ESTree.CallExpression, InferenceResult>();
  if (!loaders.size) return result;
  const imported = importedLoaderBindings(ast, loaders, index);
  const aliases = new Set<Binding>();
  // An alias cannot be proven safe: the call no longer identifies the imported
  // loader lexically, so report it at the alias call rather than silently
  // retaining a full catalog.
  const pending = [...imported];
  const seen = new Set<Binding>(imported);
  while (pending.length) {
    const binding = pending.pop()!;
    for (const reference of binding.references) {
      const parent = parentOf(index, reference);
      if (parent?.type !== 'VariableDeclarator' || parent.init !== reference || parent.id.type !== 'Identifier') continue;
      const alias = index.bindings.get(parent.id);
      if (alias && !seen.has(alias)) { seen.add(alias); aliases.add(alias); pending.push(alias); }
    }
  }
  for (const call of index.calls) {
    if (call.callee.type !== 'Identifier') continue;
    const binding = index.bindings.get(call.callee);
    if (!binding) continue;
    if (loaders.has(call.callee.name) && imported.has(binding)) result.set(call, inferCall(index, call, nested));
    else if (aliases.has(binding)) result.set(call, { kind: 'full', reason: 'ambiguous-loader-binding' });
  }
  return result;
}

/** Infer only locally consumed, immutable loader results. Every reference must
 * be a direct message call; reflection, mutation, escaping objects/functions and
 * dynamic keys keep the ordinary full-catalog loader.
 */
export function inferSelections(ast: ESTree.Program, loaders: ReadonlySet<string>, index?: BindingIndex): Map<ESTree.CallExpression, string[]> {
  const result = new Map<ESTree.CallExpression, string[]>();
  for (const [call, outcome] of inferSelectionResults(ast, loaders, index)) {
    if (outcome.kind === 'selected') result.set(call, outcome.keys);
  }
  return result;
}
