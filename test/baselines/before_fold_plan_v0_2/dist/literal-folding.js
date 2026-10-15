import { TYPE } from '@formatjs/icu-messageformat-parser';
import { quote } from './codegen.js';
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
        const beforeText = prefix.map(text => text.value).join(''), afterText = suffix.map(text => text.value).join('');
        // Reject large affixes before creating their escaped copies.
        if (growth + copies * (beforeText.length + afterText.length) > budget)
            return;
        growth += copies * (quote(beforeText).length + quote(afterText).length - 4);
        if (growth > budget)
            return;
        const branches = [];
        for (const [key, branch] of entries) {
            const before = [], after = [];
            let nested;
            for (const child of branch.value) {
                if (child.type === TYPE.literal) {
                    (nested ? after : before).push(child);
                }
                else if (child.type === TYPE.select && !nested)
                    nested = child;
                else
                    return;
            }
            if (nested) {
                const select = visit(nested, [...prefix, ...before], [...after, ...suffix], depth + 1);
                if (!select)
                    return;
                branches.push([key, select]);
            }
            else {
                if (++leaves > 16)
                    return;
                branches.push([key, { texts: [...prefix, ...before, ...suffix] }]);
            }
        }
        return { value: node.value, branches };
    }
    const select = visit(node, prefix ? [prefix] : [], suffix ? [suffix] : [], 0);
    return select ? { select, growth } : undefined;
}
