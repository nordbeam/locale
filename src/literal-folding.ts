import { TYPE } from '@formatjs/icu-messageformat-parser';
import type { SelectElement } from '@formatjs/icu-messageformat-parser';
import { quote } from './codegen.js';

export interface LiteralSelect {
  value: string;
  branches: [string, { texts: readonly { value: string }[] } | LiteralSelect][];
}

const noTexts: readonly { value: string }[] = [];
function joinedText(texts: readonly { value: string }[]): string {
  let value = '';
  for (const text of texts) value += text.value;
  return value;
}

/** Move fixed surrounding text into literal leaves without multiplying selects.
 * The budget counts duplicated escaped text, before any bundler compression.
 * The original AST stays intact for diagnostics, contracts and other emitters.
 */
export function foldLiteralSelect(node: SelectElement, prefix: { value: string } | undefined, suffix: { value: string } | undefined, budget: number): { select: LiteralSelect; growth: number } | undefined {
  let growth = 0, leaves = 0;
  function visit(node: SelectElement, prefix: readonly { value: string }[], suffix: readonly { value: string }[], depth: number): LiteralSelect | undefined {
    const entries = Object.entries(node.options);
    if (depth >= 8 || entries.length > 16) return;
    const copies = entries.length - 1;
    const beforeText = joinedText(prefix), afterText = joinedText(suffix);
    // Reject large affixes before creating their escaped copies.
    if (growth + copies * (beforeText.length + afterText.length) > budget) return;
    growth += copies * (quote(beforeText).length + quote(afterText).length - 4);
    if (growth > budget) return;
    const branches: LiteralSelect['branches'] = [];
    for (const [key, branch] of entries) {
      let nested: SelectElement | undefined;
      let nestedIndex = 0;
      for (let index = 0; index < branch.value.length; index++) {
        const child = branch.value[index]!;
        if (child.type === TYPE.literal) continue;
        if (child.type === TYPE.select && !nested) { nested = child; nestedIndex = index; }
        else return;
      }
      if (nested) {
        // Validation above guarantees that both slices contain only literals.
        const before = branch.value.slice(0, nestedIndex) as { value: string }[];
        const after = branch.value.slice(nestedIndex + 1) as { value: string }[];
        const select = visit(nested, prefix.concat(before), after.concat(suffix), depth + 1);
        if (!select) return;
        branches.push([key, select]);
      } else {
        if (++leaves > 16) return;
        // Reuse original AST nodes and allocate one compact leaf array, without
        // temporary before/after lists or spare capacity from spread/push.
        branches.push([key, { texts: prefix.concat(branch.value as { value: string }[], suffix) }]);
      }
    }
    return { value: node.value, branches };
  }
  const select = visit(node, prefix ? [prefix] : noTexts, suffix ? [suffix] : noTexts, 0);
  return select ? { select, growth } : undefined;
}
