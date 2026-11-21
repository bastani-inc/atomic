import assert from "node:assert/strict";
import { type Component, clickableHint, keyHintAction, type TuiMouseEvent } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import {
	awaitFirstContent,
	holdPromptSlot,
	PROMPT_SLOT_HOLD_MS,
	PromptSlot,
	promptSlotDrewLive,
} from "../src/modes/interactive/components/prompt-slot.ts";
import { extensionChangedScreen, holdForExtensionCommand } from "../src/modes/interactive/extension-command-hold.ts";
import { ScreenHold, screenHoldOf } from "../src/modes/interactive/screen-hold.ts";

/**
 * The prompt's slot, driven through the orders in which a command's view can arrive: mounted at once or after an await,
 * mounted with nothing to draw yet, closed again before it drew, or never; with the user's keys, a resize and the bound
 * in between.
 */

afterEach(() => {
	vi.useRealTimers();
});

function rows(...lines: string[]): Component {
	return { render: () => lines, invalidate: () => {} };
}

/** A registered view whose first content arrives when `ready()` is called. */
function pendingView(...lines: string[]): { view: Component; ready(): void } {
	let ready = false;
	const view: Component = { render: () => (ready ? lines : []), invalidate: () => {} };
	awaitFirstContent(view, () => !ready);
	return {
		view,
		ready: () => {
			ready = true;
		},
	};
}

/** The slot showing the typed command, whose Enter has just cleared the prompt: the editor is the same child. */
function slotWithPrompt(width = 40) {
	const requestRender = vi.fn();
	const screen = new ScreenHold();
	const slot = new PromptSlot({ requestRender }, () => false, screen);
	let lines = ["❯ /model", "  model  Select model"];
	const editor: Component = { render: () => lines, invalidate: () => {} };
	slot.addChild(editor);
	assert.deepEqual(slot.render(width), ["❯ /model", "  model  Select model"]);
	lines = ["❯ "];
	return { slot, requestRender, editor, screen };
}

function mountView(slot: PromptSlot, view: Component): void {
	slot.clear();
	slot.addChild(view);
}

test("a held slot draws what it drew before until the view mounts, then the view", () => {
	const { slot } = slotWithPrompt();
	holdPromptSlot(slot);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	mountView(slot, rows("Select model", "> faux-1"));
	assert.deepEqual(slot.render(40), ["Select model", "> faux-1"]);
});

test("a command that ends without a view shows the slot as it is and asks for a frame", () => {
	const { slot, requestRender } = slotWithPrompt();
	const hold = holdPromptSlot(slot);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	hold.settle();
	assert.equal(requestRender.mock.calls.length, 1);
	assert.deepEqual(slot.render(40), ["❯ "]);
});

test("a view with nothing to draw yet keeps the rows, after its command settled too, until its content is here", () => {
	const { slot, requestRender } = slotWithPrompt();
	const hold = holdPromptSlot(slot);
	const panel = pendingView("Tasks", "  No background work.");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	hold.settle();
	assert.equal(requestRender.mock.calls.length, 0, "the mounted view decides, not the command");
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	panel.ready();
	assert.deepEqual(slot.render(40), ["Tasks", "  No background work."]);
});

test("a view that closes before it drew gives back the live prompt, though the slot holds the same children again", () => {
	const { slot, editor } = slotWithPrompt();
	holdPromptSlot(slot);
	const panel = pendingView("Tasks");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	mountView(slot, editor);
	assert.deepEqual(slot.render(40), ["❯ "]);
});

test("the user's next key shows the live slot; lifting the Enter key, a mouse report or a focus report does not", () => {
	const { slot, screen } = slotWithPrompt();
	holdPromptSlot(slot);
	screen.noteInput("\x1b[13;1:3u");
	screen.noteInput("\x1b[<0;5;5M");
	screen.noteInput("\x1b[I");
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	screen.noteInput("j");
	assert.equal(screen.region, undefined);
	assert.deepEqual(slot.render(40), ["❯ "]);
});

test("at another width the slot draws live", () => {
	const { slot } = slotWithPrompt(40);
	holdPromptSlot(slot);
	assert.deepEqual(slot.render(30), ["❯ "]);
	assert.deepEqual(slot.render(40), ["❯ "], "the hold ended; it does not come back at the old width");
});

test("the hold ends after its bound and asks for a frame", () => {
	vi.useFakeTimers();
	const { slot, requestRender } = slotWithPrompt();
	holdPromptSlot(slot);
	const panel = pendingView("Tasks");
	mountView(slot, panel.view);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS - 1);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	vi.advanceTimersByTime(1);
	assert.equal(requestRender.mock.calls.length, 1);
	assert.deepEqual(slot.render(40), []);
});

test("held rows run nothing: their key hints and links are plain text and a click on them reaches no child", () => {
	const requestRender = vi.fn();
	const slot = new PromptSlot({ requestRender });
	const hinted = `  ${clickableHint("esc close", keyHintAction("escape"))} \x1b]8;;https://example.invalid/task\x07view\x1b]8;;\x07`;
	const clicks: TuiMouseEvent[] = [];
	const editor: Component = {
		render: () => ["❯ /tasks", hinted],
		invalidate: () => {},
		handleMouse: (event) => {
			clicks.push(event);
			return { handled: true };
		},
	};
	slot.addChild(editor);
	slot.render(40);
	holdPromptSlot(slot);
	assert.deepEqual(slot.render(40), ["❯ /tasks", "  esc close view"]);
	const click: TuiMouseEvent = { type: "press", button: "left", x: 3, y: 1, width: 40, height: 2 } as TuiMouseEvent;
	assert.equal(slot.handleMouse(click), undefined);
	assert.equal(clicks.length, 0);
});

test("a command run while another's hold is held joins it: the first one's settle shows the slot live", () => {
	vi.useFakeTimers();
	const { slot, requestRender, screen } = slotWithPrompt();
	const first = holdPromptSlot(slot);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS - 50);
	const second = holdPromptSlot(slot);
	second.settle();
	assert.equal(screen.region, "prompt", "the joined request ends nothing");
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	vi.advanceTimersByTime(50);
	assert.equal(screen.region, undefined, "the bound is the first hold's, not moved by the second");
	assert.equal(requestRender.mock.calls.length, 1);
	first.settle();
	assert.deepEqual(slot.render(40), ["❯ "]);
});

test("an extension's component is drawn at once: the slot reads nothing it did not register", () => {
	const { slot } = slotWithPrompt();
	holdPromptSlot(slot);
	const throwing: Component & { readonly awaitingFirstContent: () => boolean } = {
		render: () => ["in-process extension dialog"],
		invalidate: () => {},
		get awaitingFirstContent(): () => boolean {
			throw new Error("an extension owns this field");
		},
	};
	mountView(slot, throwing);
	assert.deepEqual(slot.render(40), ["in-process extension dialog"]);
	holdPromptSlot(slot);
	const claiming = { render: () => ["another dialog"], invalidate: () => {}, awaitingFirstContent: () => true };
	mountView(slot, claiming);
	assert.deepEqual(slot.render(40), ["another dialog"]);
});

test("without a command, a view mounted with nothing to draw yet keeps the rows there until its content is here", () => {
	const requestRender = vi.fn();
	const slot = new PromptSlot({ requestRender });
	slot.addChild(rows("❯ draft"));
	slot.render(40);
	const panel = pendingView("Tasks");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ draft"]);
	panel.ready();
	assert.deepEqual(slot.render(40), ["Tasks"]);
});

test("a prompt drawing a run's working status is not held, and a status that appears during a hold ends it", () => {
	let runStatus = true;
	const requestRender = vi.fn();
	const slot = new PromptSlot({ requestRender }, () => runStatus);
	let lines = ["── ∀ Working", "❯ /model"];
	slot.addChild({ render: () => lines, invalidate: () => {} });
	slot.render(40);
	lines = ["── ∀ Working", "❯ "];
	holdPromptSlot(slot);
	runStatus = false;
	lines = ["────────────", "❯ "];
	assert.deepEqual(slot.render(40), ["────────────", "❯ "], "the run ended: its status is gone at once");

	lines = ["────────────", "❯ /model"];
	slot.render(40);
	lines = ["────────────", "❯ "];
	holdPromptSlot(slot);
	assert.deepEqual(slot.render(40), ["────────────", "❯ /model"]);
	runStatus = true;
	lines = ["── ∀ Working", "❯ "];
	assert.deepEqual(slot.render(40), ["── ∀ Working", "❯ "], "a run started: its status shows as it moves");
});

test("while another part of the screen is held, a command's hold joins it: the slot keeps nothing", () => {
	const { slot, screen } = slotWithPrompt();
	let dockEnded = 0;
	const releaseDock = screen.begin("dock", () => () => dockEnded++);
	const hold = holdPromptSlot(slot);
	assert.deepEqual(slot.render(40), ["❯ "], "the slot draws live: it holds nothing of its own");
	assert.equal(screen.region, "dock");
	hold.settle();
	assert.equal(dockEnded, 0, "the joined request ends nothing");
	releaseDock();
	assert.equal(dockEnded, 1);
});

test("a hold keeps only rows drawn from live content, never held rows or a view yet to draw", () => {
	vi.useFakeTimers();
	const { slot, screen } = slotWithPrompt();
	holdPromptSlot(slot);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	assert.equal(promptSlotDrewLive(slot), false, "it drew held rows");
	screen.end();
	holdPromptSlot(slot);
	assert.equal(screen.region, undefined, "rows another hold kept are not held again");
	assert.deepEqual(slot.render(40), ["❯ "]);
	assert.equal(promptSlotDrewLive(slot), true);

	const panel = pendingView("Tasks");
	mountView(slot, panel.view);
	slot.render(40);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	assert.deepEqual(slot.render(40), [], "past the bound the panel is drawn as it is");
	assert.equal(promptSlotDrewLive(slot), false, "a panel yet to draw is not live content");
	holdPromptSlot(slot);
	assert.equal(screen.region, undefined);
	panel.ready();
	assert.deepEqual(slot.render(40), ["Tasks"]);
	assert.equal(promptSlotDrewLive(slot), true);
});

test("a run's working status drawn elsewhere changing leaves a held prompt held, and a later hold still takes", () => {
	const { slot, screen } = slotWithPrompt();
	holdPromptSlot(slot);
	screen.statusChanged();
	assert.equal(screen.region, "prompt");
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	screen.end();
	slot.render(40);
	screen.statusChanged();
	holdPromptSlot(slot);
	assert.equal(screen.region, "prompt", "the status changed since the slot drew, but not in its rows");
});

test("a run's working status changing shows a held dock live", () => {
	const screen = new ScreenHold();
	let ended = 0;
	screen.begin("dock", () => () => ended++);
	screen.statusChanged();
	assert.equal(ended, 1);
});

test("a hold that reached its bound before any frame is not begun again from the same rows (#6077)", () => {
	vi.useFakeTimers();
	const { slot, screen } = slotWithPrompt();
	holdPromptSlot(slot);
	// The view mounts with nothing to draw yet, and no frame is drawn before the bound.
	const panel = pendingView("Tasks", "  No background work.");
	mountView(slot, panel.view);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS + 1);
	assert.equal(screen.region, undefined);
	assert.deepEqual(slot.render(40), [], "the view shows as it is, with nothing to draw yet");
	assert.equal(screen.region, undefined);
	panel.ready();
	assert.deepEqual(slot.render(40), ["Tasks", "  No background work."]);
});

/** The hold of a command that can mount its view after the hold ends, as an extension command does. */
const LATE_VIEW = { lateView: true } as const;

/** The slot of an interactive mode whose extension command runs, with its prompt showing the typed command. */
function commandScreen() {
	const requestRender = vi.fn();
	const requestImmediateRender = vi.fn();
	const mode = { ui: { requestImmediateRender } } as {
		editorContainer: PromptSlot;
		ui: { requestImmediateRender(): void };
	};
	const slot = new PromptSlot({ requestRender }, () => false, screenHoldOf(mode));
	let lines = ["❯ /agents"];
	slot.addChild({ render: () => lines, invalidate: () => {} });
	slot.render(40);
	lines = ["❯ "];
	mode.editorContainer = slot;
	return { mode, slot, requestRender, requestImmediateRender, screen: screenHoldOf(mode) };
}

test("a view mounted after the hold reached its bound, before the next frame, keeps the typed command until it draws (#6105)", () => {
	vi.useFakeTimers();
	const { slot, requestRender, screen } = slotWithPrompt();
	holdPromptSlot(slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	assert.equal(requestRender.mock.calls.length, 1, "the bound asks for a frame");
	assert.equal(screen.region, undefined, "past the bound the screen is not held: another part of it can be");
	const panel = pendingView("Agents", "  scout");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"], "no frame shows the empty view");
	assert.equal(screen.region, "prompt");
	panel.ready();
	assert.deepEqual(slot.render(40), ["Agents", "  scout"]);
});

test("the typed command kept for a view mounted after the bound stays one more bound at most, and never again (#6105)", () => {
	vi.useFakeTimers();
	const { slot, requestRender, screen } = slotWithPrompt();
	holdPromptSlot(slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	const panel = pendingView("Agents");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS - 1);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	vi.advanceTimersByTime(1);
	assert.equal(requestRender.mock.calls.length, 2);
	assert.equal(screen.region, undefined);
	assert.deepEqual(slot.render(40), [], "past its own bound the view is drawn as it is");
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS * 2);
	assert.deepEqual(slot.render(40), []);
	assert.equal(screen.region, undefined, "the rows are not kept a third time");
});

test("with nothing mounted by the frame after the bound, the slot draws live, and a view mounted later keeps that frame (#6105)", () => {
	vi.useFakeTimers();
	const { slot } = slotWithPrompt();
	holdPromptSlot(slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	assert.deepEqual(slot.render(40), ["❯ "]);
	const panel = pendingView("Agents");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ "], "the frame on screen stays, not the typed command");
	panel.ready();
	assert.deepEqual(slot.render(40), ["Agents"]);
});

test("a key or another width between the bound and the next frame shows a view mounted meanwhile as it is (#6105)", () => {
	vi.useFakeTimers();
	const keyed = slotWithPrompt();
	holdPromptSlot(keyed.slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	keyed.screen.noteInput("j");
	mountView(keyed.slot, pendingView("Agents").view);
	assert.deepEqual(keyed.slot.render(40), []);
	assert.equal(keyed.screen.region, undefined);

	const resized = slotWithPrompt();
	holdPromptSlot(resized.slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	mountView(resized.slot, pendingView("Agents").view);
	assert.deepEqual(resized.slot.render(30), []);
	assert.deepEqual(resized.slot.render(40), [], "it does not come back at the old width");
});

test("a view mounted while the command held keeps the command's bound: the bound does not start again (#6105)", () => {
	vi.useFakeTimers();
	const { slot, screen } = slotWithPrompt();
	holdPromptSlot(slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS - 10);
	mountView(slot, pendingView("Agents").view);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	vi.advanceTimersByTime(10);
	assert.equal(screen.region, undefined);
	assert.deepEqual(slot.render(40), []);
});

test("another extension's change that ends the hold keeps the typed command for the command's view mounted before the next frame (#6105)", () => {
	const { mode, slot, requestImmediateRender, screen } = commandScreen();
	holdForExtensionCommand(mode);
	assert.deepEqual(slot.render(40), ["❯ /agents"]);
	extensionChangedScreen(mode);
	assert.equal(requestImmediateRender.mock.calls.length, 1, "the change is drawn at once");
	assert.equal(screen.region, undefined);
	const panel = pendingView("Agents");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ /agents"], "no frame shows the empty view");
	panel.ready();
	assert.deepEqual(slot.render(40), ["Agents"]);
});

test("a command that ended with nothing mounted leaves its rows to no view (#6105)", () => {
	vi.useFakeTimers();
	const { mode, slot } = commandScreen();
	const hold = holdForExtensionCommand(mode);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	hold.settle();
	mountView(slot, pendingView("Another view").view);
	assert.deepEqual(slot.render(40), []);
});

test("a second command's hold drops the first command's rows left for its view (#6105)", () => {
	vi.useFakeTimers();
	const { slot, screen } = slotWithPrompt();
	holdPromptSlot(slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	const second = holdPromptSlot(slot, LATE_VIEW);
	assert.equal(screen.region, undefined, "rows a hold kept are not held again");
	mountView(slot, pendingView("Second view").view);
	assert.deepEqual(slot.render(40), []);
	second.settle();
});

test("a command's late settle ends no later hold (#6105)", () => {
	vi.useFakeTimers();
	const { slot, screen } = slotWithPrompt();
	const first = holdPromptSlot(slot, LATE_VIEW);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	assert.deepEqual(slot.render(40), ["❯ "]);
	holdPromptSlot(slot, LATE_VIEW);
	assert.equal(screen.region, "prompt");
	first.settle();
	assert.equal(screen.region, "prompt", "the first command's settle leaves the second command's hold");
});

test("a built-in command's hold shows a view mounted after its bound as it is, as before (#6105)", () => {
	vi.useFakeTimers();
	const { slot, screen } = slotWithPrompt();
	holdPromptSlot(slot);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	mountView(slot, pendingView("Sessions").view);
	assert.deepEqual(slot.render(40), []);
	assert.equal(screen.region, undefined);
});

test("an extension command's hold keeps the typed command for its view mounted after the bound (#6105)", () => {
	vi.useFakeTimers();
	const { mode, slot } = commandScreen();
	holdForExtensionCommand(mode);
	vi.advanceTimersByTime(PROMPT_SLOT_HOLD_MS);
	const panel = pendingView("Agents");
	mountView(slot, panel.view);
	assert.deepEqual(slot.render(40), ["❯ /agents"]);
	panel.ready();
	assert.deepEqual(slot.render(40), ["Agents"]);
});
