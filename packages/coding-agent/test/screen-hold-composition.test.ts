import assert from "node:assert/strict";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import { FIRST_FRAME_TIMEOUT_MS } from "../src/modes/interactive/agent-view/remote-port.ts";
import { holdTranscriptDock } from "../src/modes/interactive/agent-view/transcript-slot.ts";
import {
	awaitFirstContent,
	holdPromptSlot,
	PROMPT_SLOT_HOLD_MS,
	PromptSlot,
} from "../src/modes/interactive/components/prompt-slot.ts";
import { screenHoldOf } from "../src/modes/interactive/screen-hold.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { liveSubagent, mainScreen, PAGE_UP } from "./helpers/agent-view-screen.ts";

/**
 * The prompt's slot held while `/tasks` opens, and the dock held while a subagent opened from `/tasks` is on its way,
 * are one hold of the screen: the dock never keeps rows the slot was holding, or a panel that had not drawn.
 */

const cleanups: Array<() => Promise<void> | void> = [];
let previousKeys: ReturnType<typeof getKeybindings>;
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	setKeybindings(previousKeys);
});

/** Past the prompt's bound, by a margin a loaded machine needs to run the bound's timer. */
const PAST_PROMPT_BOUND_MS = PROMPT_SLOT_HOLD_MS + 100;

async function tasksOpening() {
	const agent = await liveSubagent(2);
	const ui = mainScreen();
	// The subagent's port never opens: the dock would be held for as long as the request is pending.
	const switcher = new AgentViewSwitcher(
		() => new Promise(() => {}),
		() => {},
		() => holdTranscriptDock(ui.mode, FIRST_FRAME_TIMEOUT_MS),
	);
	const unbind = ui.bind(switcher);
	cleanups.push(async () => {
		switcher.dispose();
		unbind();
		ui.tui.stop();
		await agent.fixture.dispose?.();
	});
	const slot = new PromptSlot(ui.tui, () => false, screenHoldOf(ui.mode));
	Object.assign(ui.mode, { editorContainer: slot });
	Object.assign(ui.mode.editor, { render: (width: number) => slot.render(width) });
	let prompt = "❯ /tasks";
	const editor: Component = { render: () => [prompt], invalidate: () => {} };
	let framed = false;
	const panel: Component = { render: () => (framed ? ["Tasks · worker"] : [""]), invalidate: () => {} };
	awaitFirstContent(panel, () => !framed);
	slot.addChild(editor);
	return {
		ui,
		switcher,
		agent,
		slot,
		/** Enter on `/tasks`: the prompt clears, its slot is held, and the engine's panel mounts with no frame yet. */
		submit() {
			prompt = "❯ ";
			holdPromptSlot(slot);
			slot.clear();
			slot.addChild(panel);
		},
		/** The panel's first frame arrives. */
		frame() {
			framed = true;
		},
		/** The engine closes `/tasks` once it asked for the subagent: the prompt is back in the slot. */
		closeTasks() {
			slot.clear();
			slot.addChild(editor);
		},
	};
}

test("Enter on a /tasks panel that has not drawn yet shows the live prompt, never the held /tasks rows", async () => {
	const tasks = await tasksOpening();
	const { ui } = tasks;
	assert.equal(ui.screen().at(-2), "❯ /tasks");
	tasks.submit();
	assert.equal(ui.screen().at(-2), "❯ /tasks", "the prompt's slot holds while the panel has no frame");
	// The early Enter reaches the panel, which asks for the subagent and closes.
	ui.terminal.input("\r");
	tasks.switcher.requestView(tasks.agent.taskId, { keepScreen: true });
	tasks.closeTasks();
	const first = ui.screen();
	await new Promise((resolve) => setTimeout(resolve, PAST_PROMPT_BOUND_MS));
	const later = ui.screen();
	for (const screen of [first, later]) {
		assert.equal(screen.at(-2), "❯", screen.join("\n"));
		assert.ok(!screen.some((line) => line === "❯ /tasks"), screen.join("\n"));
	}
});

test("a panel that has drawn is held by the dock while its subagent is on its way, until a key", async () => {
	const tasks = await tasksOpening();
	const { ui } = tasks;
	tasks.submit();
	tasks.frame();
	ui.screen();
	const board = ui.screen();
	assert.equal(board.at(-2), "Tasks · worker");
	tasks.switcher.requestView(tasks.agent.taskId, { keepScreen: true });
	tasks.closeTasks();
	assert.deepEqual(ui.screen(), board, "the dock keeps the board it drew");
	assert.equal(screenHoldOf(ui.mode).region, "dock");
	ui.terminal.input("x");
	assert.equal(screenHoldOf(ui.mode).region, undefined);
	assert.equal(ui.screen().at(-2), "❯");
});

test("a key the transcript scrolls with shows a held dock live too", async () => {
	const tasks = await tasksOpening();
	const { ui } = tasks;
	tasks.submit();
	tasks.frame();
	ui.screen();
	tasks.switcher.requestView(tasks.agent.taskId, { keepScreen: true });
	tasks.closeTasks();
	assert.equal(screenHoldOf(ui.mode).region, "dock");
	const top = ui.scroll.scrollTop;
	ui.terminal.input(PAGE_UP);
	const after = ui.screen();
	assert.equal(screenHoldOf(ui.mode).region, undefined);
	assert.equal(after.at(-2), "❯", after.join("\n"));
	assert.ok(ui.scroll.scrollTop < top, `PageUp still scrolls the transcript: ${top} -> ${ui.scroll.scrollTop}`);
	ui.terminal.input("\x1b[1;5H");
	ui.screen();
	assert.equal(ui.scroll.scrollTop, 0, "Ctrl+Home goes to the top as before");
});
