import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

test("task detail keeps the live elapsed time already shown by its row (#5224)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	let now = 1_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	const task = taskRecord("live-detail", "command");
	task.metrics = { elapsedMs: 1_000 };
	const source = { ...ownerTaskViewSource(fixture.store), tasks: [task], backgroundTasks: [task] };
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	try {
		inspector.renderViewport(100, 24);
		now += 5_000;
		assert.match(stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n")), /6s/);
		inspector.handleInput(" ");
		inspector.renderViewport(100, 24);
		inspector.handleInput("\r");
		assert.match(stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n")), /Running · 6s/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		clock.mockRestore();
		setKeybindings(previous);
	}
});
