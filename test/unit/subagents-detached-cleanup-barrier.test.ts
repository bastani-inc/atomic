import { test } from "bun:test";
import assert from "node:assert/strict";
import { createDetachedCleanupBarrier } from "../../packages/subagents/src/runs/foreground/detached-cleanup-barrier.js";

test("detached resource cleanup waits for every retained child and runs once", () => {
  let cleanups = 0;
  const barrier = createDetachedCleanupBarrier(() => { cleanups += 1; });

  barrier.recover(0);
  assert.equal(barrier.defer([0, 1]), true);
  assert.equal(cleanups, 0, "one still-live child keeps worktree artifacts owned");

  barrier.recover(1);
  barrier.recover(1);
  assert.equal(cleanups, 1);
});

test("a run without detached children keeps immediate cleanup ownership", () => {
  let cleanups = 0;
  const barrier = createDetachedCleanupBarrier(() => { cleanups += 1; });

  assert.equal(barrier.defer([]), false);
  assert.equal(cleanups, 0);
});
