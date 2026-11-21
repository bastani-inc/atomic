import type { Component, Container } from "@bastani/atomic-tui";
import { PromptSlot } from "./components/prompt-slot.ts";

/**
 * What the footer's hints and the widgets around the prompt show in a frame: `live`; `inert` while a navigation view is
 * on its way and the prompt's slot still shows the prompt, so they still show what they showed and take no clicks; or
 * `hidden` while the slot shows a navigation view (`/tasks`, the focused agent panel), or its picture while what it hid
 * draws again.
 */
export type DockScene = "live" | "inert" | "hidden";

export interface NavigationSceneMode {
	readonly editorContainer: Container;
	readonly editor: unknown;
	readonly navigationInlineCustomUiDepth: number;
}

/**
 * Whether a navigation view is what the prompt's slot draws at `width`: they all change in the frame the slot does,
 * never before it, so the screen goes from the prompt to the view, and back, in one frame.
 */
export function navigationShown(mode: NavigationSceneMode, width: number): boolean {
	const slot = mode.editorContainer;
	const picture = slot instanceof PromptSlot ? slot.heldPicture(width) : undefined;
	if (picture !== undefined) return picture.navigation;
	if (mode.navigationInlineCustomUiDepth === 0) return false;
	// A navigation view began: shown from the frame the slot no longer draws the prompt.
	return slot.children.at(-1) !== (mode.editor as Component);
}

export function dockScene(mode: NavigationSceneMode, width: number): DockScene {
	if (navigationShown(mode, width)) return "hidden";
	return mode.navigationInlineCustomUiDepth > 0 ? "inert" : "live";
}
