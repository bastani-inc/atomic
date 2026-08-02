import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { makeHandle, stripAnsi } from "./stage-chat-view-helpers.js";

const SESSION_ID = "339e05a4-2289-408e-9076-d1a348f582ae";

function renderStageHeader(workflowName: string, stageName: string, width: number): string[] {
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: workflowName,
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now(),
	});
	store.recordStageStart("run-1", {
		id: "stage-a",
		name: stageName,
		status: "running",
		parentIds: [],
		toolEvents: [],
	});
	const { handle } = makeHandle();
	Object.defineProperty(handle, "sessionId", { value: SESSION_ID });
	const viewportRows = 12;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName,
		handle,
		getViewportRows: () => viewportRows,
		onDetach: () => {},
		onClose: () => {},
	});
	const rendered = view.render(width);
	view.dispose();
	assert.equal(rendered.length, viewportRows, `width ${width}: frame row count`);
	const separatorIndex = rendered.findIndex((line) => /^─+$/.test(stripAnsi(line)));
	assert.ok(separatorIndex > 0, `width ${width}: header separator missing`);
	return rendered.slice(0, separatorIndex);
}

test("stage chat header preserves full names and session id monotonically from 40 through 120 columns", () => {
	for (const [workflowName, stageName] of [
		["publish-release", "implement"],
		["wf", "s"],
	] as const) {
		let previousRowCount = Number.POSITIVE_INFINITY;
		for (let width = 40; width <= 120; width++) {
			const header = renderStageHeader(workflowName, stageName, width);
			const plain = header.map(stripAnsi);
			const joined = plain.join("\n");
			for (const [row, line] of plain.entries()) {
				assert.ok(line.length <= width, `${workflowName}/${stageName}, width ${width}, row ${row}: ${line}`);
			}
			assert.match(joined, new RegExp(workflowName), `${workflowName}/${stageName}, width ${width}: workflow`);
			assert.match(joined, new RegExp(stageName), `${workflowName}/${stageName}, width ${width}: stage`);
			assert.ok(joined.includes(SESSION_ID), `${workflowName}/${stageName}, width ${width}: session`);
			assert.doesNotMatch(joined, /…/, `${workflowName}/${stageName}, width ${width}: ellipsis`);
			assert.ok(
				header.length <= previousRowCount,
				`${workflowName}/${stageName}, width ${width}: row count ${previousRowCount} -> ${header.length}`,
			);
			previousRowCount = header.length;
		}
	}
});
