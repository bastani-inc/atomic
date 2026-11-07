import assert from "node:assert/strict";
import { test } from "vitest";
import { compactionReasonReader } from "../../packages/subagents/src/runs/inprocess/runner.ts";

test("a child's task transcript reports its compaction reason only while the session compacts (#4521)", () => {
	const session: { isCompacting: boolean; compactionReason?: string } = { isCompacting: false };
	const read = compactionReasonReader(session);
	assert.equal(read(), undefined);
	session.compactionReason = "threshold";
	assert.equal(read(), undefined, "a reason left from an earlier compaction is not reported");
	session.isCompacting = true;
	assert.equal(read(), "threshold");
	session.compactionReason = "overflow";
	assert.equal(read(), "overflow", "the reason is read each time");
	session.isCompacting = false;
	assert.equal(read(), undefined);
});
