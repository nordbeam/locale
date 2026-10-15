import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlanApplyError,
  applyPlan,
  createPlan,
  parsePlan,
  serializePlan,
  verifyPlan,
} from "../dist/plan-apply.js";

const roots = [];
test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nordbeam-plan-"));
  roots.push(root);
  await mkdir(join(root, "generated"));
  await writeFile(join(root, "existing.ts"), "before\n");
  return root;
}

test("plan captures normalized operation, affected paths, and before hashes", async () => {
  const root = await fixture();
  const input = {
    root,
    operation: { options: { locale: "en", include: ["generated"] }, command: "generate" },
    changes: [
      { path: "generated\\messages.ts", content: "generated\n" },
      { path: "existing.ts", content: "after\n" },
    ],
  };
  const plan = await createPlan(input);
  assert.deepEqual(plan, await createPlan(input));
  assert.deepEqual(plan.affectedPaths, ["existing.ts", "generated/messages.ts"]);
  assert.match(plan.changes[0].before.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.changes[1].before.kind, "missing");
  assert.deepEqual(parsePlan(serializePlan(plan)), plan);
});

test("apply rejects stale, missing, and unexpected targets before destination writes", async () => {
  const root = await fixture();
  const stale = await createPlan({ root, changes: [{ path: "existing.ts", content: "after\n" }] });
  await writeFile(join(root, "existing.ts"), "changed\n");
  await assert.rejects(applyPlan(stale), (error) => error instanceof PlanApplyError && error.code === "STALE_PLAN");
  assert.equal(await readFile(join(root, "existing.ts"), "utf8"), "changed\n");

  const missing = await createPlan({ root, changes: [{ path: "existing.ts", content: "after\n" }] });
  await rm(join(root, "existing.ts"));
  await assert.rejects(verifyPlan(missing), (error) => error instanceof PlanApplyError && error.code === "MISSING_TARGET");

  const unexpected = await createPlan({ root, changes: [{ path: "generated/new.ts", content: "new\n" }] });
  await writeFile(join(root, "generated/new.ts"), "unexpected\n");
  await assert.rejects(applyPlan(unexpected), (error) => error instanceof PlanApplyError && error.code === "UNEXPECTED_TARGET");
  assert.equal(await readFile(join(root, "generated/new.ts"), "utf8"), "unexpected\n");
});

test("apply replaces files transactionally through staged same-directory renames", async () => {
  const root = await fixture();
  const plan = await createPlan({
    root,
    metadata: { operation: "fixture" },
    changes: [
      { path: "generated/a.ts", content: "a\n" },
      { path: "existing.ts", content: "after\n" },
    ],
  });
  assert.deepEqual(await applyPlan(plan), {
    planHash: plan.planHash,
    status: "applied",
    changed: ["existing.ts", "generated/a.ts"],
    rolledBack: false,
  });
  assert.equal(await readFile(join(root, "existing.ts"), "utf8"), "after\n");
  assert.equal(await readFile(join(root, "generated/a.ts"), "utf8"), "a\n");
});

test("planning rejects a missing parent rather than creating an unplanned directory", async () => {
  const root = await fixture();
  await assert.rejects(
    createPlan({ root, changes: [{ path: "new/deep/messages.ts", content: "new\n" }] }),
    (error) => error instanceof PlanApplyError && error.code === "MISSING_TARGET",
  );
});

test("planning rejects a symlink anywhere in a target parent chain", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "nordbeam-plan-outside-"));
  roots.push(outside);
  await mkdir(join(outside, "nested"));
  await symlink(outside, join(root, "linked"));
  await assert.rejects(
    createPlan({ root, changes: [{ path: "linked/nested/messages.ts", content: "escape\n" }] }),
    (error) => error instanceof PlanApplyError && error.code === "UNEXPECTED_TARGET",
  );
});
