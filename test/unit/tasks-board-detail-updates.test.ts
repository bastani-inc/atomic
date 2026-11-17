import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

for (const page of ["detail", "chat"] as const) {
	test(`/tasks keeps board projections out of ${page} updates and refreshes the list on return (#5224)`, async () => {
		initTheme("dark");
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const fixture = taskFixture();
		await fixture.start("Selected task");
		const source = ownerTaskViewSource(fixture.store);
		let itemReads = 0;
		let extensionUpdate = () => {};
		const inspector = new TaskInspector(
			source,
			() => {},
			() => {},
			undefined,
			() => taskTranscriptEnvironment(),
		);
		inspector.setBoardSource({
			items: () => {
				itemReads++;
				return [];
			},
			subscribe: (listener) => {
				extensionUpdate = listener;
				return () => {};
			},
		});
		const text = () => stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n"));
		try {
			if (page === "detail") {
				inspector.handleInput(" ");
				inspector.handleInput("\r");
			} else {
				inspector.handleInput("\r");
			}
			assert.equal(inspector.navigation.focus.kind, "detail");
			itemReads = 0;
			for (let index = 0; index < 20; index++) {
				taskValue(
					fixture.runners[0].context.reportActivity({
						reportId: `activity-${index}`,
						change: { kind: "action", tool: "bash", text: `output ${index}` },
					}),
				);
				fixture.store.drain();
			}
			extensionUpdate();
			assert.equal(itemReads, 0, "hidden task rows must not be rebuilt on streaming or extension updates");
			await fixture.start("Task launched while reading");
			inspector.handleInput(page === "detail" ? "\x1b" : "\x1b[D");
			assert.match(text(), /2 working/);
			assert.match(text(), /Task launched while reading/);
			assert.ok(itemReads > 0);
		} finally {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		}
	});
}

test("a task that finishes while its detail stop is armed is acknowledged, not dismissed (#5224)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	await fixture.start("Finishes while reading");
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		inspector.handleInput(" ");
		inspector.handleInput("\r");
		inspector.handleInput("x");
		await fixture.settle();
		inspector.handleInput("x");
		assert.equal(inspector.navigation.focus.kind, "detail");
		inspector.handleInput("\x1b");
		const text = stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n"));
		assert.match(text, /Finishes while reading/);
		assert.match(text, /1 done/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});
