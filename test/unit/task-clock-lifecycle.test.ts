import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { taskPanelItems } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";

const text = (inspector: TaskInspector) => stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n"));

test("stopping a task keeps the elapsed clock monotone across the panel and task picker (#5224)", async () => {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	let now = 100_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture(undefined, { settleOnAbort: false });
	const source = ownerTaskViewSource(fixture.store);
	const model = new AgentPanelModel(() => now);
	let rows = model.rows(taskPanelItems(source, new Set()));
	const unsubscribe = fixture.store.subscribe(() => {
		rows = model.rows(taskPanelItems(source, new Set()));
	});
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	try {
		const task = await fixture.start("A long task");
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "metrics",
				change: { kind: "metrics", elapsedMs: 2000 },
			}),
		);
		fixture.store.drain();
		now += 60_000;
		assert.match(text(inspector), /1m 0s|1m 2s/);
		taskValue(await fixture.supervisor.cancelTask(task, "user"));
		fixture.store.drain();
		assert.equal(fixture.store.tasks[0].execution.kind, "cancelling");
		text(inspector);
		rows = model.rows(taskPanelItems(source, new Set()));
		fixture.runners[0].result.resolve({ kind: "cancelled", cause: "user" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		fixture.store.drain();
		assert.match(text(inspector), /stopped · 1m (0|2)s/);
		assert.ok((rows[0]?.elapsedMs ?? 0) >= 60_000, `panel elapsed ${rows[0]?.elapsedMs}`);
	} finally {
		inspector.dispose();
		unsubscribe();
		await fixture.dispose();
		clock.mockRestore();
		setKeybindings(keys);
	}
});

test("a task that settles while the picker is closed does not include the observation gap (#5224)", async () => {
	initTheme("dark");
	let now = 200_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	let inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Completes out of view");
		text(inspector);
		inspector.dispose();
		now += 6000;
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "final-metrics",
				change: { kind: "metrics", elapsedMs: 6000 },
			}),
		);
		fixture.store.drain();
		await fixture.settle();
		now += 600_000;
		inspector = new TaskInspector(
			fixture.store,
			() => {},
			() => {},
		);
		assert.match(text(inspector), /done · 6s/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		clock.mockRestore();
	}
});
