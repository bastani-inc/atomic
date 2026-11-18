/**
 * One left click opens a `/tasks` row as moving there and pressing Enter would, and runs a task page's action as Enter
 * does, driven through Atomic's fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { showTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { type ClickScreen, flushClicks, makeClickScreen } from "../helpers/fullscreen-clicks.js";
import { taskFixture } from "../helpers/task-projection.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

/** Shows `/tasks` the way the host does: the list in place of the prompt, a task's page as a full-screen overlay. */
function taskUi(ui: ClickScreen) {
	return {
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		custom: <T>(
			factory: Parameters<Parameters<typeof showTaskInspector>[0]["custom"]>[0],
			options?: { readonly overlay?: boolean },
		) =>
			new Promise<T>((resolve) => {
				void Promise.resolve(factory(ui.tui, theme, new KeybindingsManager(), resolve as never)).then(
					(component: Component) => {
						if (options?.overlay) ui.mount(component);
						else ui.dock(component);
					},
				);
			}),
	};
}

for (const width of [80, 160]) {
	test(`a click on a /tasks row opens that task, as moving there and pressing enter does, at ${width} columns`, async () => {
		const ui = makeClickScreen(width);
		const fixture = taskFixture();
		try {
			await fixture.start("Index the repository");
			await fixture.start("Summarize the changelog");
			void showTaskInspector(taskUi(ui) as never, fixture.store);
			await flushClicks();
			ui.tui.renderNow();
			assert.ok(
				ui.screen().some((line) => line.includes("Tasks")),
				ui.screen().join("\n"),
			);
			// The newest task is listed first and selected; the click moves to the other one and opens it.
			await ui.click(/Index the repository/, "Index");
			await flushClicks();
			ui.tui.renderNow();
			assert.ok(
				ui.screen().some((line) => line.includes("worker · Index the repository · running")),
				ui.screen().join("\n"),
			);
		} finally {
			ui.tui.stop();
			await fixture.dispose();
		}
	});
}

test("a double-click on a /tasks row opens it once", async () => {
	const ui = makeClickScreen();
	const fixture = taskFixture();
	try {
		await fixture.start("Index the repository");
		await fixture.start("Summarize the changelog");
		void showTaskInspector(taskUi(ui) as never, fixture.store);
		await flushClicks();
		await ui.doubleClick(/Index the repository/, "Index");
		await flushClicks();
		ui.tui.renderNow();
		assert.ok(
			ui.screen().some((line) => line.includes("worker · Index the repository · running")),
			ui.screen().join("\n"),
		);
	} finally {
		ui.tui.stop();
		await fixture.dispose();
	}
});

test("the mouse wheel over /tasks moves its selection", async () => {
	const ui = makeClickScreen();
	const fixture = taskFixture();
	try {
		await fixture.start("Index the repository");
		await fixture.start("Summarize the changelog");
		void showTaskInspector(taskUi(ui) as never, fixture.store);
		await flushClicks();
		const selected = () => ui.screen().find((line) => line.includes("❯"));
		assert.match(selected() ?? "", /Summarize the changelog/, ui.screen().join("\n"));
		const row = ui.rowOf(/Summarize the changelog/);
		await ui.wheel("down", 6, row);
		assert.match(selected() ?? "", /Index the repository/, ui.screen().join("\n"));
	} finally {
		ui.tui.stop();
		await fixture.dispose();
	}
});
