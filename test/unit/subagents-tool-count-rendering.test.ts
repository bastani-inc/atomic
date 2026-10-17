import assert from "node:assert/strict";
import { test } from "vitest";
import type { TaskId, WaitId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import type { SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { theme } from "./subagents-render-stability-helpers.js";

test("parallel result labels preserve count expansion beyond 50 children", () => {
	const context = { toolCallId: "expanded-count", state: {}, invalidate() {} };
	renderSubagentToolCall(
		{
			tasks: [
				{ agent: "alpha", task: "Repeated", count: 51 },
				{ agent: "beta", task: "Last" },
			],
		},
		theme,
		context,
	);
	const result: SubagentToolResult = {
		content: [],
		details: {
			mode: "parallel",
			results: [],
			taskResponse: {
				kind: "parallel",
				slots: Array.from({ length: 52 }, (_, ordinal) => ({
					ordinal,
					outcome: {
						kind: "admitted",
						observation: {
							kind: "yielded",
							taskId: `task-${ordinal}` as TaskId,
							waitId: `wait-${ordinal}` as WaitId,
							reason: "default-background",
						},
					},
				})),
			},
		},
	};
	const text = renderSubagentToolResult(result, { expanded: false, isPartial: false }, theme, context)
		.render(120)
		.join("\n");
	assert.match(text, /51\. alpha · Launched in background/);
	assert.match(text, /52\. beta · Launched in background/);
});
