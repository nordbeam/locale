import { indexBindings } from './bindings.js';
function propertyName(node) {
    const key = node.type === 'Property' ? node.key : node.property;
    if (!node.computed && key.type === 'Identifier')
        return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string')
        return key.value;
}
/** Infer only locally consumed, immutable loader results. Every reference must
 * be a direct message call; reflection, mutation, escaping objects/functions and
 * dynamic keys keep the ordinary full-catalog loader.
 */
export function inferSelections(ast, loaders, index) {
    const result = new Map();
    if (!loaders.size)
        return result;
    index ??= indexBindings(ast);
    if (index.dynamic)
        return result;
    const { parents, declarations, bindings } = index;
    const imported = new Set([...ast.body].flatMap(node => node.type === 'ImportDeclaration'
        ? node.specifiers.filter(specifier => loaders.has(specifier.local.name)).map(specifier => bindings.get(specifier.local)) : []));
    function callsOnly(binding, object) {
        const resolved = bindings.get(binding);
        if (!resolved || resolved.declarations.size !== 1)
            return;
        const keys = new Set();
        for (const reference of resolved.references) {
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
        if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !loaders.has(call.callee.name) || !imported.has(bindings.get(call.callee)))
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
