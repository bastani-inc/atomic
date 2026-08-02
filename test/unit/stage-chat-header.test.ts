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

test("stage chat header fits realistic and minimal names without shortening the session id", () => {
	for (const [workflowName, stageName] of [
		["publish-release", "implement"],
		["wf", "s"],
	] as const) {
		for (const width of [40, 60, 80]) {
			const header = renderStageHeader(workflowName, stageName, width);
			const plain = header.map(stripAnsi);
			for (const [row, line] of plain.entries()) {
				assert.ok(line.length <= width, `${workflowName}/${stageName}, width ${width}, row ${row}: ${line}`);
			}
			assert.ok(plain.join("\n").includes(SESSION_ID), `${workflowName}/${stageName}, width ${width}`);
		}
	}
});
