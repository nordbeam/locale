import type { ESTree } from 'vite';

export type Identifier = Extract<ESTree.Node, { type: 'Identifier' }>;
export interface Binding {
  declarations: Set<Identifier>;
  references: Set<Identifier>;
}
class Scope {
  readonly bindings = new Map<string, Binding>();
  readonly resolved = new Map<string, Binding | undefined>();
  readonly variables: Scope;
  constructor(readonly parent?: Scope, variables = false) { this.variables = variables ? this : parent?.variables ?? this; }
  find(name: string): Binding | undefined {
    if (!this.resolved.has(name)) this.resolved.set(name, this.bindings.get(name) ?? this.parent?.find(name));
    return this.resolved.get(name);
  }
}

export interface BindingIndex {
  parents: Map<ESTree.Node, ESTree.Node>;
  bindings: Map<Identifier, Binding>;
  names: Set<string>;
  declarations: ESTree.VariableDeclarator[];
  calls: ESTree.CallExpression[];
  dynamic: boolean;
}

/** Resolve strict ESM bindings after collecting declarations, including hoisted
 * var declarations. Parameter expressions are outside the function body's var
 * environment; switch discriminants are outside the case block's environment.
 * No AST or scope state survives the module transform.
 */
export function indexBindings(ast: ESTree.Program, inference = true): BindingIndex {
  const index: BindingIndex = {parents:new Map(),bindings:new Map(),names:new Set(),declarations:[],calls:[],dynamic:false};
  const references: Array<[Identifier, Scope]> = [];
  function declare(identifier: Identifier, scope: Scope): Binding {
    let binding = scope.bindings.get(identifier.name);
    if (!binding) scope.bindings.set(identifier.name, binding = {declarations:new Set(),references:new Set()});
    binding.declarations.add(identifier); index.bindings.set(identifier, binding);
    return binding;
  }
  function bind(pattern: ESTree.Node | null | undefined, scope: Scope): void {
    if (!pattern) return;
    if (pattern.type === 'Identifier') declare(pattern, scope);
    else if (pattern.type === 'RestElement') bind(pattern.argument, scope);
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, scope);
    else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements) bind(item, scope);
    else if (pattern.type === 'ObjectPattern') for (const item of pattern.properties) bind(item.type === 'RestElement' ? item.argument : item.value, scope);
  }
  function reference(identifier: Identifier, parent: ESTree.Node): boolean {
    if (index.bindings.has(identifier)) return false;
    if (parent.type === 'MemberExpression' && parent.property === identifier && !parent.computed) return false;
    if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
      && parent.key === identifier && !parent.computed && parent.value !== identifier) return false;
    if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier' || parent.type === 'MetaProperty') return false;
    if (parent.type === 'ExportSpecifier' && parent.local !== identifier) return false;
    if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && parent.label === identifier) return false;
    return true;
  }
  function children(node: ESTree.Node, scope: Scope): void {
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === 'object' && typeof item.type === 'string') walk(item as ESTree.Node, scope, node);
      } else if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string') walk(child as ESTree.Node, scope, node);
    }
  }
  function walk(node: ESTree.Node, scope: Scope, parent?: ESTree.Node, functionBody = false): void {
    if (inference && parent) index.parents.set(node, parent);
    // Vite normally lowers decorators before this pass. If another transform
    // leaves them intact, their evaluation environments need separate analysis.
    if ('decorators' in node && Array.isArray(node.decorators) && node.decorators.length) index.dynamic = true;
    if (node.type === 'Identifier') {
      index.names.add(node.name);
      if (parent && reference(node, parent)) references.push([node, scope]);
      return;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      index.calls.push(node);
      if (node.callee.name === 'eval') index.dynamic = true;
    }
    if (node.type === 'WithStatement') index.dynamic = true;
    if (node.type === 'VariableDeclaration') for (const declaration of node.declarations) bind(declaration.id, node.kind === 'var' ? scope.variables : scope);
    if (inference && node.type === 'VariableDeclarator') index.declarations.push(node);
    if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) bind(specifier.local, scope);
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      let outer = scope;
      if (node.type === 'FunctionDeclaration') bind(node.id, scope);
      else if (node.type === 'FunctionExpression' && node.id) { outer = new Scope(scope); bind(node.id, outer); }
      const parameters = new Scope(outer);
      for (const parameter of node.params) bind(parameter, parameters);
      if (node.type !== 'ArrowFunctionExpression' && node.id) walk(node.id, outer, node);
      for (const parameter of node.params) walk(parameter, parameters, node);
      if (node.body) walk(node.body, new Scope(parameters, true), node, true);
      return;
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const inner = new Scope(scope);
      if (node.id) {
        const binding = declare(node.id, node.type === 'ClassDeclaration' ? scope : inner);
        inner.bindings.set(node.id.name, binding);
        walk(node.id, inner, node);
      }
      if (node.superClass) walk(node.superClass, inner, node);
      walk(node.body, inner, node);
      return;
    }
    if (node.type === 'SwitchStatement') {
      walk(node.discriminant, scope, node);
      const cases = new Scope(scope);
      for (const item of node.cases) walk(item, cases, node);
      return;
    }
    if (node.type === 'CatchClause') {
      scope = new Scope(scope); bind(node.param, scope);
    } else if (node.type === 'StaticBlock') scope = new Scope(scope, true);
    else if ((node.type === 'BlockStatement' && !functionBody) || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') scope = new Scope(scope);
    children(node, scope);
  }
  walk(ast, new Scope(undefined, true));
  for (const [identifier, scope] of references) {
    const binding = scope.find(identifier.name);
    if (binding) { index.bindings.set(identifier, binding); binding.references.add(identifier); }
  }
  return index;
}
