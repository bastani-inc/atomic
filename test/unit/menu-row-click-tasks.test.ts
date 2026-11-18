/**
 * One left click opens a `/tasks` row as moving there and pressing Enter would, and runs a task page's action as Enter
 * does, driven through Atomic's fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import {
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
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

test("a click on a task page's action runs it, as enter on the selected action does", async () => {
	const ui = makeClickScreen(100);
	const fixture = taskFixture();
	try {
		await fixture.start("Index the repository");
		void showTaskInspector(taskUi(ui) as never, fixture.store);
		await flushClicks();
		// Space peeks at the task under its row, and Enter on the card opens its page.
		ui.terminal.input(" ");
		await flushClicks();
		ui.terminal.input("\r");
		await flushClicks();
		ui.tui.renderNow();
		// The page's selected action is the framed row that starts with the pointer.
		const label = ui
			.screen()
			.map((line) => /^│ › (\S.*?)\s*│$/.exec(line)?.[1])
			.find((found) => found !== undefined);
		assert.ok(label !== undefined, ui.screen().join("\n"));
		await ui.click(`│ › ${label}`, label);
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

test("a click on a numbered choice of a peeked question fills it in, as its number does", async () => {
	const ui = makeClickScreen(100);
	const fixture = taskFixture();
	const answered: Array<[string, string]> = [];
	const question: AgentPanelItem = {
		id: "run:ralph",
		kind: "workflow",
		state: "input",
		name: "ralph",
		task: "stage plan",
		question: "Pick one",
		choices: ["Keep going", "Stop here", "Ask again"],
		elapsedMs: 1000,
	};
	const source: TaskBoardSource = {
		items: () => [question],
		subscribe: () => () => {},
		answer: async (id, text) => {
			answered.push([id, text]);
			return { ok: true };
		},
	};
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		ui.mount({
			render: (width) => inspector.renderViewport(width, 24),
			invalidate: () => inspector.invalidate(),
			handleInput: (data) => {
				inspector.handleInput(data);
			},
			handleMouse: (event) => inspector.handleMouse(event),
			paintedRowKey: (row) => inspector.paintedRowKey(row),
		});
		ui.terminal.input(" ");
		await flushClicks();
		await ui.click(/│ 2 Stop here/, "Stop here");
		assert.match(ui.screen().join("\n"), /│ ❯ Stop here\b/, ui.screen().join("\n"));
		ui.terminal.input("\r");
		await flushClicks();
		assert.deepEqual(answered, [["run:ralph", "Stop here"]]);
	} finally {
		inspector.dispose();
		ui.tui.stop();
		await fixture.dispose();
	}
});
