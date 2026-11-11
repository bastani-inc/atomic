import assert from "node:assert/strict";
import { test } from "vitest";
import { isToolDeactivationEntryData, TOOL_DEACTIVATION_ENTRY_TYPE } from "../src/core/tool-deactivation.ts";

test("only a list of tool names is a recorded deactivation (#4660)", () => {
	assert.equal(TOOL_DEACTIVATION_ENTRY_TYPE, "atomic.tool-deactivation");
	assert.equal(isToolDeactivationEntryData({ tools: ["subagent", "todo"] }), true);
	assert.equal(isToolDeactivationEntryData({ tools: [] }), true);
	for (const data of [
		undefined,
		null,
		"subagent",
		["subagent"],
		{},
		{ names: ["subagent"] },
		{ tools: "subagent" },
		{ tools: ["subagent", 7] },
		{ tools: [7, "subagent"] },
	])
		assert.equal(isToolDeactivationEntryData(data), false, JSON.stringify(data));
});
