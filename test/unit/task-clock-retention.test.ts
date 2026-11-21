import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import * as clocks from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import type { TaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { taskRecord } from "../helpers/task-record.js";

test("shared task clocks keep live owners and pooled sources across GC but release after eviction (#5224)", async () => {
	initTheme("dark");
	clocks.liveElapsedMs("released", 0, true, 0);
	await collectGarbage();
	assert.equal(clocks.liveElapsedMs("released", undefined, false, 1000), undefined);
	const owner = new clocks.TaskElapsedClocks();
	owner.elapsedMs("retained", 0, true, 0);
	await collectGarbage();
	assert.equal(owner.elapsedMs("retained", 0, true, 1000), 1000);
	owner.clear();
	await collectGarbage();
	assert.equal(owner.elapsedMs("retained", undefined, false, 2000), undefined);

	let now = 100_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	try {
		const listeners = new Set<() => void>();
		let currentTasks = [
			{ ...taskRecord("pooled-agent"), title: "Pooled agent", metrics: { elapsedMs: 1000 } },
			{ ...taskRecord("pooled-shell", "command"), title: "Pooled shell", metrics: undefined },
		];
		const failed = { ok: false, error: { message: "no" } } as const;
		const pooledSource: TaskViewSource = {
			get tasks() {
				return currentTasks;
			},
			get backgroundTasks() {
				return currentTasks;
			},
			settlementOrder: new Map(),
			recentActivity: () => [],
			activityOmitted: () => false,
			subscribe(listener: () => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			cancelTask: async () => failed,
			stdinAvailable: () => false,
			writeTaskInput: async () => failed,
			readTaskOutput: async () => failed,
			taskDetailText: () => ({}),
			readTaskTranscript: () => failed,
			followTaskTranscript: () => undefined,
			extensionStatuses: () => new Map(),
			watchExtensionStatuses: () => () => {},
		};
		let inspector: TaskInspector | undefined = new TaskInspector(
			pooledSource,
			() => {},
			() => {},
		);
		stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n"));
		now += 60_000;
		const beforeClose = stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n"));
		assert.match(beforeClose, /Pooled agent.* 1m/);
		assert.match(beforeClose, /Pooled shell.* 1m/);
		inspector.dispose();
		inspector = undefined;
		await collectGarbage();
		let reopened: TaskInspector | undefined = new TaskInspector(
			pooledSource,
			() => {},
			() => {},
		);
		const afterGc = stripVTControlCharacters(reopened.renderViewport(100, 24).join("\n"));
		assert.match(afterGc, /Pooled agent.* 1m/);
		assert.match(afterGc, /Pooled shell.* 1m/);
		reopened.dispose();
		reopened = undefined;
		currentTasks = [];
		for (const listener of [...listeners]) listener();
		await collectGarbage();
		assert.equal(clocks.taskClocksFor(pooledSource).elapsedMs("pooled-agent", undefined, false, now), undefined);
		assert.equal(clocks.taskClocksFor(pooledSource).elapsedMs("pooled-shell", undefined, false, now), undefined);
	} finally {
		vi.restoreAllMocks();
	}
});
