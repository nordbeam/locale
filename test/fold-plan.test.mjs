import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPE, parse } from '@formatjs/icu-messageformat-parser';
import { foldLiteralSelect } from '../dist/literal-folding.js';
import { foldLiteralSelect as beforeFold } from './baselines/before_fold_plan_v0_2/dist/literal-folding.js';

const literal = value => ({ type: TYPE.literal, value });
const select = (value, entries) => ({ type: TYPE.select, value, options: Object.fromEntries(entries.map(([key, value]) => [key, { value }])) });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}
function sameReferences(actual, expected) {
  assert.equal(actual.value, expected.value);
  assert.equal(actual.branches.length, expected.branches.length);
  for (let i = 0; i < actual.branches.length; i++) {
    const [key, branch] = actual.branches[i], [oldKey, old] = expected.branches[i];
    assert.equal(key, oldKey);
    if ('branches' in old) sameReferences(branch, old);
    else {
      assert.equal(branch.texts.length, old.texts.length);
      for (let j = 0; j < old.texts.length; j++) assert.equal(branch.texts[j], old.texts[j]);
    }
  }
}

test('compact folding plans preserve acceptance budgets, branch order and original text identities', t => {
  const cases = [];
  for (const width of [1, 2, 3, 15, 16, 17]) {
    cases.push(select('choice', Array.from({ length: width }, (_, i) => [i === width - 1 ? 'other' : 'c' + i, [literal('same'), literal(''), literal('same')]])));
  }
  cases.push(select('key', [['other', []], ['__proto__', [literal('P')]], ['2', [literal('2')]], ['1', [literal('1')]]]));
  let nested = select('base', [['a', [literal('A')]], ['other', [literal('B')]]]);
  for (let depth = 0; depth <= 9; depth++) {
    cases.push(nested);
    nested = select('level' + depth, [['a', [literal('before'), literal(''), nested, literal('after')]], ['other', [literal('fallback')]]]);
  }
  let full = select('end', [['a', []], ['other', [literal('')]]]);
  for (let depth = 0; depth < 5; depth++) { cases.push(full); full = select('wide' + depth, [['a', [full]], ['other', [full]]]); }
  for (const child of [
    { type: TYPE.argument, value: 'name' }, { type: TYPE.pound },
    { type: TYPE.tag, value: 'b', children: [literal('B')] },
    parse('{n, plural, one {One} other {Many}}', { captureLocation: true })[0],
    ...[select('one', [['other', []]])].map(node => [node, node]),
  ]) cases.push(select('late', [['a', [literal('valid')]], ['other', Array.isArray(child) ? child : [literal('before'), child, literal('after')]]]));
  const affixes = [undefined, literal(''), literal('a'), literal('"\\<\n\u2028\ud800'), literal('界'.repeat(64)), literal('x'.repeat(129))];
  let compared = 0, accepted = 0;
  for (const node of cases.map(freeze)) for (const prefix of affixes) for (const suffix of affixes) for (const budget of [0, 1, 2, 16, 127, 128, 129, 1024]) {
    freeze(prefix); freeze(suffix);
    const actual = foldLiteralSelect(node, prefix, suffix, budget), expected = beforeFold(node, prefix, suffix, budget);
    assert.deepEqual(actual, expected);
    if (expected) { sameReferences(actual.select, expected.select); accepted++; }
    compared++;
  }
  assert.ok(accepted > 0 && accepted < compared);
  t.diagnostic(`${compared} plan comparisons, including ${accepted} accepted plans with exact AST text identities`);
});
