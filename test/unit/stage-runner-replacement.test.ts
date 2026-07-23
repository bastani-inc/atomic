import { test } from "bun:test";
import assert from "node:assert/strict";
import { StageSessionReplacement } from "../../packages/workflows/src/runs/foreground/stage-runner-replacement.js";
import { makeMockSession } from "./stage-runner-helpers.js";

test("fallback replacement does not dispose an admitted turn before the old session becomes idle", async () => {
  const idle = Promise.withResolvers<void>();
  let disposed = false;
  const previous = makeMockSession({
    agent: { waitForIdle: () => idle.promise } as never,
    dispose() { disposed = true; },
  }).session;
  const target = makeMockSession().session;
  const replacement = new StageSessionReplacement();

  replacement.retire(previous);
  replacement.adopt(target);
  await Promise.resolve();
  assert.equal(disposed, false);

  idle.resolve();
  await replacement.dispose();
  assert.equal(disposed, true);
});
