import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INTERCOM_GROUP,
  normalizeGroup,
  resolveStageGroup,
  stageHasIntercomAccess,
} from "../../packages/workflows/src/shared/intercom-group.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";

test("normalizeGroup collapses empties to the default group", () => {
  assert.equal(normalizeGroup(), DEFAULT_INTERCOM_GROUP);
  assert.equal(normalizeGroup(""), DEFAULT_INTERCOM_GROUP);
  assert.equal(normalizeGroup("  x "), "x");
});

test("resolveStageGroup: string passes through trimmed, absent → undefined, true → fresh uuid", () => {
  assert.equal(resolveStageGroup(undefined), undefined);
  assert.equal(resolveStageGroup({}), undefined);
  assert.equal(resolveStageGroup({ group: "  reviewers " }), "reviewers");
  assert.equal(resolveStageGroup({ group: "" }), undefined);

  const a = resolveStageGroup({ group: true });
  const b = resolveStageGroup({ group: true });
  assert.match(a ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b, "each single-stage true mints its own uuid");
});

test("stageHasIntercomAccess gates on noTools / tools allowlist / excludedTools", () => {
  assert.equal(stageHasIntercomAccess(undefined), true);
  assert.equal(stageHasIntercomAccess({} as StageOptions), true);
  assert.equal(stageHasIntercomAccess({ noTools: "all" } as StageOptions), false);
  assert.equal(stageHasIntercomAccess({ noTools: "builtin" } as StageOptions), false);
  assert.equal(stageHasIntercomAccess({ tools: ["bash", "read"] } as StageOptions), false);
  assert.equal(stageHasIntercomAccess({ tools: ["bash", "intercom"] } as StageOptions), true);
  assert.equal(stageHasIntercomAccess({ excludedTools: ["intercom"] } as StageOptions), false);
});
