import assert from "node:assert/strict";
import { type Component, clickableHint, keyHintAction, type TuiMouseEvent } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import {
	awaitFirstContent,
	holdPromptSlot,
	PROMPT_SLOT_HOLD_MS,
	PromptSlot,
} from "../src/modes/interactive/components/prompt-slot.ts";

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
	const slot = new PromptSlot({ requestRender });
	let lines = ["❯ /model", "  model  Select model"];
	const editor: Component = { render: () => lines, invalidate: () => {} };
	slot.addChild(editor);
	assert.deepEqual(slot.render(width), ["❯ /model", "  model  Select model"]);
	lines = ["❯ "];
	return { slot, requestRender, editor };
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
	const { slot } = slotWithPrompt();
	holdPromptSlot(slot);
	slot.noteInput("\x1b[13;1:3u");
	slot.noteInput("\x1b[<0;5;5M");
	slot.noteInput("\x1b[I");
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
	slot.noteInput("j");
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

test("a late settle of an older command leaves a newer hold alone", () => {
	const { slot, requestRender } = slotWithPrompt();
	const older = holdPromptSlot(slot);
	holdPromptSlot(slot);
	older.settle();
	assert.equal(requestRender.mock.calls.length, 0);
	assert.deepEqual(slot.render(40), ["❯ /model", "  model  Select model"]);
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
