import { TYPE } from '@formatjs/icu-messageformat-parser';
import { quote } from './codegen.js';
const noTexts = [];
function joinedText(texts) {
    let value = '';
    for (const text of texts)
        value += text.value;
    return value;
}
/** Move fixed surrounding text into literal leaves without multiplying selects.
 * The budget counts duplicated escaped text, before any bundler compression.
 * The original AST stays intact for diagnostics, contracts and other emitters.
 */
export function foldLiteralSelect(node, prefix, suffix, budget) {
    let growth = 0, leaves = 0;
    function visit(node, prefix, suffix, depth) {
        const entries = Object.entries(node.options);
        if (depth >= 8 || entries.length > 16)
            return;
        const copies = entries.length - 1;
        const beforeText = joinedText(prefix), afterText = joinedText(suffix);
        // Reject large affixes before creating their escaped copies.
        if (growth + copies * (beforeText.length + afterText.length) > budget)
            return;
        growth += copies * (quote(beforeText).length + quote(afterText).length - 4);
        if (growth > budget)
            return;
        const branches = [];
        for (const [key, branch] of entries) {
            let nested;
            let nestedIndex = 0;
            for (let index = 0; index < branch.value.length; index++) {
                const child = branch.value[index];
                if (child.type === TYPE.literal)
                    continue;
                if (child.type === TYPE.select && !nested) {
                    nested = child;
                    nestedIndex = index;
                }
                else
                    return;
            }
            if (nested) {
                // Validation above guarantees that both slices contain only literals.
                const before = branch.value.slice(0, nestedIndex);
                const after = branch.value.slice(nestedIndex + 1);
                const select = visit(nested, prefix.concat(before), after.concat(suffix), depth + 1);
                if (!select)
                    return;
                branches.push([key, select]);
            }
            else {
                if (++leaves > 16)
                    return;
                // Reuse original AST nodes and allocate one compact leaf array, without
                // temporary before/after lists or spare capacity from spread/push.
                branches.push([key, { texts: prefix.concat(branch.value, suffix) }]);
            }
        }
        return { value: node.value, branches };
    }
    const select = visit(node, prefix ? [prefix] : noTexts, suffix ? [suffix] : noTexts, 0);
    return select ? { select, growth } : undefined;
}
