import assert from "node:assert/strict";
import { type Component, clickableHint, keyHintAction, stripHintMarkers } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { holdPromptSlot, markNavigationView, PromptSlot } from "../src/modes/interactive/components/prompt-slot.ts";
import { WidgetContainer } from "../src/modes/interactive/components/scroll-widget.ts";
import { dockScene, navigationShown } from "../src/modes/interactive/navigation-scene.ts";
import { ScreenHold } from "../src/modes/interactive/screen-hold.ts";

/**
 * The footer's hints and the widgets around the prompt change in the frame the prompt's slot does: while a navigation
 * view is on its way they keep showing what they showed, taking no clicks, and they hide once the slot draws the view.
 */

function rows(...lines: string[]): Component {
	return { render: () => lines, invalidate: () => {} };
}

function screen() {
	const slot = new PromptSlot({ requestRender: vi.fn() }, () => false, new ScreenHold());
	const editor = rows("❯ /tasks");
	slot.addChild(editor);
	slot.render(40);
	const mode = { editorContainer: slot, editor, navigationInlineCustomUiDepth: 0 };
	const panel = new WidgetContainer((width) => dockScene(mode, width));
	let clicked = 0;
	panel.addChild({
		render: () => [clickableHint("  ◯ main", keyHintAction("down"))],
		invalidate: () => {},
		handleMouse: () => {
			clicked++;
			return { handled: true };
		},
	});
	const click = () => panel.handleMouse({ type: "press", button: "left", x: 3, y: 0, width: 40, height: 1 } as never);
	return { slot, mode, panel, click, clicks: () => clicked };
}

test("the widgets keep their rows, taking no clicks, until the navigation view on its way is drawn, then hide", () => {
	const { slot, mode, panel, click, clicks } = screen();
	assert.equal(dockScene(mode, 40), "live");
	assert.deepEqual(panel.render(40).map(stripHintMarkers), ["  ◯ main"]);
	click();
	assert.equal(clicks(), 1);

	// Enter on /tasks: the slot keeps the typed command; the view is asked for and the navigation begins.
	holdPromptSlot(slot);
	mode.navigationInlineCustomUiDepth = 1;
	assert.equal(navigationShown(mode, 40), false);
	assert.equal(dockScene(mode, 40), "inert");
	assert.deepEqual(panel.render(40), ["  ◯ main"], "the same row, with no key hint left in it");
	click();
	assert.equal(clicks(), 1, "it takes no click");

	// The view mounts and draws: in that frame the widgets hide.
	const tasks = rows("Tasks  2 working");
	markNavigationView(tasks, true);
	slot.clear();
	slot.addChild(tasks);
	assert.equal(navigationShown(mode, 40), true);
	assert.deepEqual(panel.render(40), []);
	assert.deepEqual(slot.render(40), ["Tasks  2 working"]);
});

test("a prompt stacked over a navigation view keeps the widgets hidden, as before", () => {
	const { slot, mode, panel } = screen();
	const tasks = rows("Tasks");
	markNavigationView(tasks, true);
	mode.navigationInlineCustomUiDepth = 1;
	slot.clear();
	slot.addChild(tasks);
	slot.render(40);
	slot.clear();
	slot.addChild(rows("Allow write? (y/n)"));
	assert.equal(dockScene(mode, 40), "hidden");
	assert.deepEqual(panel.render(40), []);
});
