function propertyName(node) {
    const key = node.type === 'Property' ? node.key : node.property;
    if (!node.computed && key.type === 'Identifier')
        return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string')
        return key.value;
}
/** Infer only locally consumed, immutable loader results. A name with more than
 * one binding is deliberately left alone, even in disjoint lexical scopes.
 * Every reference must be a direct message call; reflection, mutation, escaping
 * objects/functions and dynamic keys keep the ordinary full-catalog loader.
 */
export function inferSelections(ast, loaders) {
    const result = new Map();
    if (!loaders.size)
        return result;
    const parents = new Map();
    const identifiers = new Set();
    const bound = new Set();
    const counts = new Map();
    const declarations = [];
    let directEval = false;
    function bind(pattern) {
        if (!pattern)
            return;
        if (pattern.type === 'Identifier') {
            if (bound.has(pattern))
                return;
            bound.add(pattern);
            counts.set(pattern.name, (counts.get(pattern.name) ?? 0) + 1);
        }
        else if (pattern.type === 'RestElement')
            bind(pattern.argument);
        else if (pattern.type === 'AssignmentPattern')
            bind(pattern.left);
        else if (pattern.type === 'ArrayPattern')
            for (const item of pattern.elements)
                bind(item);
        else if (pattern.type === 'ObjectPattern')
            for (const item of pattern.properties)
                bind(item.type === 'RestElement' ? item.argument : item.value);
    }
    function walk(node, parent) {
        if (parent)
            parents.set(node, parent);
        if (node.type === 'Identifier')
            identifiers.add(node);
        if (node.type === 'VariableDeclarator') {
            bind(node.id);
            declarations.push(node);
        }
        if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
            bind(node.id);
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
            if (node.type !== 'ArrowFunctionExpression')
                bind(node.id);
            for (const parameter of node.params)
                bind(parameter);
        }
        if (node.type === 'CatchClause')
            bind(node.param);
        if (node.type === 'ImportDeclaration')
            for (const specifier of node.specifiers)
                bind(specifier.local);
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval')
            directEval = true;
        for (const child of Object.values(node)) {
            if (Array.isArray(child)) {
                for (const item of child)
                    if (item && typeof item === 'object' && typeof item.type === 'string')
                        walk(item, node);
            }
            else if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string')
                walk(child, node);
        }
    }
    walk(ast);
    if (directEval)
        return result;
    const references = new Map();
    for (const identifier of identifiers) {
        if (bound.has(identifier))
            continue;
        const parent = parents.get(identifier);
        if (parent.type === 'MemberExpression' && parent.property === identifier && !parent.computed)
            continue;
        if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
            && parent.key === identifier && !parent.computed && parent.value !== identifier)
            continue;
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier')
            continue;
        if (parent.type === 'ExportSpecifier' && parent.local !== identifier)
            continue;
        const uses = references.get(identifier.name) ?? new Set();
        uses.add(identifier);
        references.set(identifier.name, uses);
    }
    function callsOnly(binding, object) {
        if (counts.get(binding.name) !== 1)
            return;
        const keys = new Set();
        for (const reference of references.get(binding.name) ?? []) {
            const parent = parents.get(reference);
            if (!object) {
                if (parent.type !== 'CallExpression' || parent.callee !== reference)
                    return;
            }
            else {
                if (parent.type !== 'MemberExpression' || parent.object !== reference)
                    return;
                const key = propertyName(parent);
                const call = parents.get(parent);
                if (key === undefined || call?.type !== 'CallExpression' || call.callee !== parent)
                    return;
                keys.add(key);
            }
        }
        return [...keys];
    }
    for (const declaration of declarations) {
        const statement = parents.get(declaration);
        if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const' || parents.get(statement)?.type === 'ExportNamedDeclaration')
            continue;
        if (declaration.id.type !== 'ObjectPattern' || declaration.init?.type !== 'AwaitExpression')
            continue;
        const call = declaration.init.argument;
        if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !loaders.has(call.callee.name) || counts.get(call.callee.name) !== 1)
            continue;
        let messages, valid = true;
        for (const property of declaration.id.properties) {
            if (property.type !== 'Property') {
                valid = false;
                break;
            }
            const name = propertyName(property);
            if (name === 'messages' && messages === undefined)
                messages = property.value;
            else if (name !== 'locale' || property.value.type !== 'Identifier') {
                valid = false;
                break;
            }
        }
        if (!valid || !messages)
            continue;
        let keys;
        if (messages.type === 'Identifier')
            keys = callsOnly(messages, true);
        else if (messages.type === 'ObjectPattern') {
            keys = [];
            for (const property of messages.properties) {
                if (property.type !== 'Property' || property.value.type !== 'Identifier') {
                    keys = undefined;
                    break;
                }
                const key = propertyName(property);
                if (key === undefined || callsOnly(property.value, false) === undefined) {
                    keys = undefined;
                    break;
                }
                keys.push(key);
            }
        }
        if (keys?.length)
            result.set(call, [...new Set(keys)].sort());
    }
    return result;
}
