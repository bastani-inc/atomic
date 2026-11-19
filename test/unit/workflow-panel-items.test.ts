/**
 * Workflow runs as agent-panel rows: ported from the retired BACKGROUND widget's rendering tests (#5224), which now
 * apply to the panel's run rows.
 */
import assert from "node:assert/strict";

import { test } from "vitest";
import { formatPanelElapsed } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";

test("elapsed time reads seconds, minutes, then hours and minutes, and never goes negative (#5224)", () => {
	assert.equal(formatPanelElapsed(-5_000), "0s");
	assert.equal(formatPanelElapsed(59_000), "59s");
	assert.equal(formatPanelElapsed(60_000), "1m");
	assert.equal(formatPanelElapsed(3_600_000), "1h 0m");
	assert.equal(formatPanelElapsed(3_660_000), "1h 1m");
});
