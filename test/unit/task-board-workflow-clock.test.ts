import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

test("cached workflow rows keep time in /tasks and freeze while paused without source polling (#5224)", async () => {
	initTheme("dark");
	let now = 1_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	const hub = new AgentPanelSourceHub();
	let reads = 0;
	let changed = () => {};
	let row: AgentPanelItem = {
		id: "run:release",
		kind: "workflow",
		state: "running",
		name: "release",
		task: "Build",
		elapsedMs: 5_000,
	};
	hub.register({
		items: () => {
			reads++;
			return [row];
		},
		subscribe(listener) {
			changed = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	inspector.setBoardSource(agentPanelBoardSource(session));
	const paint = () => stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n"));
	try {
		assert.match(paint(), /Build +5s/);
		const initialReads = reads;
		now += 5_000;
		assert.match(paint(), /Build +10s/);
		assert.equal(reads, initialReads);
		row = { ...row, state: "paused", elapsedMs: 10_000 };
		changed();
		assert.match(paint(), /paused · 10s/);
		now += 60_000;
		assert.match(paint(), /paused · 10s/);
		row = { ...row, state: "running", elapsedMs: 10_000 };
		changed();
		assert.match(paint(), /Build +10s/);
		now += 1_000;
		assert.match(paint(), /Build +11s/);
	} finally {
		inspector.dispose();
		hub.dispose();
		await fixture.dispose();
		clock.mockRestore();
	}
});
