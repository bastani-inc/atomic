import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
	type AgentPanelRow,
	type AgentPanelStyle,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";

const plain: AgentPanelStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

function rowForTask(task: string): AgentPanelRow {
	return {
		id: "task:clamp-cache-bound",
		kind: "agent",
		state: "running",
		name: "worker",
		task,
		elapsedMs: 41 * 60_000,
		tokens: 96_100,
	};
}

test("single-cell line width cache retains 512 entries and evicts the oldest entry on the 513th line (#5239)", () => {
	const taskAt = (index: number): string => `clamp-bound-row-${String(index).padStart(4, "0")}`;
	const firstTask = taskAt(0);
	const secondTask = taskAt(1);
	for (let index = 0; index < 512; index++) {
		renderAgentPanelRows([rowForTask(taskAt(index))], 120, plain);
	}

	const replace = vi.spyOn(String.prototype, "replace");
	try {
		const replaceCallsFor = (needle: string): number =>
			replace.mock.contexts.filter((text) => typeof text === "string" && text.includes(needle)).length;

		renderAgentPanelRows([rowForTask(firstTask)], 120, plain);
		assert.equal(replaceCallsFor(firstTask), 0, "512th-newest single-cell line stays cached before overflow");

		replace.mockClear();
		const overflowTask = taskAt(512);
		renderAgentPanelRows([rowForTask(overflowTask)], 120, plain);
		assert.equal(replaceCallsFor(overflowTask), 1, "513th distinct line is measured on insertion");

		replace.mockClear();
		renderAgentPanelRows([rowForTask(secondTask)], 120, plain);
		assert.equal(replaceCallsFor(secondTask), 0, "newer entries remain cached when the oldest entry is evicted");

		replace.mockClear();
		renderAgentPanelRows([rowForTask(firstTask)], 120, plain);
		assert.equal(replaceCallsFor(firstTask), 1, "oldest entry beyond 512 is evicted and re-measured on next render");

		replace.mockClear();
		renderAgentPanelRows([rowForTask(firstTask)], 120, plain);
		assert.equal(replaceCallsFor(firstTask), 0, "re-inserted line is cached again");

		replace.mockClear();
		renderAgentPanelRows([rowForTask(secondTask)], 120, plain);
		assert.equal(
			replaceCallsFor(secondTask),
			1,
			"re-inserting the evicted line evicts the next oldest entry in FIFO order",
		);
	} finally {
		replace.mockRestore();
	}
});
