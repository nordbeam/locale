import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanApplyError, applyPlan, createPlan, verifyPlan } from '../dist/plan-apply.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nordbeam-plan-'));
  await writeFile(join(root, 'a.ts'), 'a0\n');
  await writeFile(join(root, 'b.ts'), 'b0\n');
  return root;
}

async function plan(root) {
  return createPlan({
    rootDir: root,
    operation: { command: 'generate' },
    changes: [
      { path: 'a.ts', content: 'a1\n' },
      { path: 'b.ts', content: 'b1\n' },
      { path: 'created.ts', content: 'new\n' },
    ],
  });
}

test('re-applying a fully applied plan succeeds as already-applied and writes nothing', async () => {
  const root = await fixture();
  const reviewed = await plan(root);
  assert.equal((await applyPlan(reviewed)).status, 'applied');
  const before = await Promise.all(['a.ts', 'b.ts', 'created.ts'].map(name => stat(join(root, name))));
  const entriesBefore = (await readdir(root)).sort();

  const result = await applyPlan(reviewed);

  assert.deepEqual(result, { planHash: reviewed.planHash, status: 'already-applied', changed: [], rolledBack: false });
  const after = await Promise.all(['a.ts', 'b.ts', 'created.ts'].map(name => stat(join(root, name))));
  assert.deepEqual(after.map(info => info.mtimeMs), before.map(info => info.mtimeMs));
  assert.deepEqual((await readdir(root)).sort(), entriesBefore);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'a1\n');
});

test('already-applied is recognized for a created file even though its mode was never planned', async () => {
  const root = await fixture();
  const reviewed = await createPlan({ rootDir: root, changes: [{ path: 'new.ts', content: 'x\n' }] });
  await applyPlan(reviewed);
  assert.equal((await applyPlan(reviewed)).status, 'already-applied');
});

test('a plan with a no-op change is already-applied once its other changes are applied', async () => {
  const root = await fixture();
  const reviewed = await createPlan({ rootDir: root, changes: [{ path: 'a.ts', content: 'a0\n' }, { path: 'b.ts', content: 'b1\n' }] });
  await writeFile(join(root, 'b.ts'), 'b1\n');
  assert.equal((await applyPlan(reviewed)).status, 'already-applied');
});

test('verifyPlan still rejects an already-applied plan as stale and names the files', async () => {
  const root = await fixture();
  const reviewed = await plan(root);
  await applyPlan(reviewed);
  await assert.rejects(verifyPlan(reviewed), error => {
    assert.ok(error instanceof PlanApplyError);
    assert.equal(error.code, 'STALE_PLAN');
    assert.match(error.message, /Plan is already applied/);
    assert.deepEqual(error.paths, ['a.ts', 'b.ts', 'created.ts']);
    return true;
  });
});

test('a partially applied plan is STALE_PLAN, names the differing files, and writes nothing', async () => {
  const root = await fixture();
  const reviewed = await plan(root);
  await writeFile(join(root, 'a.ts'), 'a1\n');
  await assert.rejects(applyPlan(reviewed), error => {
    assert.ok(error instanceof PlanApplyError);
    assert.equal(error.code, 'STALE_PLAN');
    assert.match(error.message, /partially applied; already at planned content: a\.ts\./);
    assert.match(error.message, /a\.ts/);
    assert.deepEqual(error.paths, ['a.ts']);
    return true;
  });
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'b0\n');
});

test('a partial plan with an externally edited file names that file as stale', async () => {
  const root = await fixture();
  const reviewed = await plan(root);
  await writeFile(join(root, 'a.ts'), 'a1\n');
  await writeFile(join(root, 'b.ts'), 'edited\n');
  await assert.rejects(applyPlan(reviewed), error => {
    assert.equal(error.code, 'STALE_PLAN');
    assert.match(error.message, /Target changed after planning: b\.ts\./);
    assert.match(error.message, /Target already has planned content: a\.ts\./);
    assert.deepEqual(error.paths, ['a.ts', 'b.ts']);
    return true;
  });
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'edited\n');
});

test('a file that appeared with other content is still UNEXPECTED_TARGET', async () => {
  const root = await fixture();
  const reviewed = await plan(root);
  await writeFile(join(root, 'created.ts'), 'someone else\n');
  await assert.rejects(applyPlan(reviewed), error => error.code === 'UNEXPECTED_TARGET');
});

test('a fresh plan over already-applied content is a new no-op plan', async () => {
  const root = await fixture();
  const first = await plan(root);
  await applyPlan(first);
  const second = await createPlan({ rootDir: root, changes: [{ path: 'a.ts', content: 'a1\n' }] });
  assert.equal((await applyPlan(second)).status, 'already-applied');
});
