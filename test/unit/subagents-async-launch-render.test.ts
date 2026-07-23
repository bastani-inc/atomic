import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatAsyncStartedMessage } from "../../packages/subagents/src/runs/background/async-execution-common.js";
import { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { isRunningSubagentResult } from "../../packages/subagents/src/tui/render-stable-output.js";
import { type AgentToolResult, type Details, theme } from "./subagents-render-stability-helpers.js";

test("async launch acknowledgement explicitly separates launch completion from child completion", () => {
	const text = formatAsyncStartedMessage("Async: worker [run-1]");
	assert.match(text, /launched/i);
	assert.match(text, /completion pending/i);
});

test("compact and expanded launch rendering says launched and completion pending without running state", () => {
	const result: AgentToolResult<Details> = {
		content: [{ type: "text", text: formatAsyncStartedMessage("Async: worker [run-1]") }],
		details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: "/tmp/run-1", results: [] },
	};
	for (const expanded of [false, true]) {
		const rendered = renderSubagentResult(result, { expanded }, theme).render(120).join("\n");
		assert.match(rendered, /launched/i);
		assert.match(rendered, /completion pending/i);
		assert.doesNotMatch(rendered, /spinner|running/i);
	}
	assert.equal(isRunningSubagentResult(result), false);
});
