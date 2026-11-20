import type { Container, TUI } from "@bastani/atomic-tui";
import { holdPromptSlot, type PromptSlotHold } from "./components/prompt-slot.ts";
import { screenHoldOf } from "./screen-hold.ts";

/**
 * An extension command clears the prompt at once, but whether it opens a view shows only once it runs. Its hold of the
 * prompt's slot lasts until an extension first changes the screen, or until the command ends, and otherwise ends as
 * any hold of the slot does. Which extension made a change cannot be told, so any extension's change ends it: that
 * shows the slot live, as it is when nothing is held.
 */

/** The interactive mode whose prompt's slot a command holds. */
export interface ExtensionCommandScreen {
	readonly editorContainer: Container;
	readonly ui: Pick<TUI, "requestImmediateRender">;
}

/** The hold of the extension command started last, per interactive mode, until a change on the screen ends it. */
const unchanged = new WeakMap<ExtensionCommandScreen, PromptSlotHold>();
/** A submission's hold, for the turn that runs its command. */
const submitted = new WeakMap<object, PromptSlotHold>();

/** Hold the prompt's slot of `mode` while the extension command submitted now starts. */
export function holdForExtensionCommand(mode: ExtensionCommandScreen): PromptSlotHold {
	const held = holdPromptSlot(mode.editorContainer);
	unchanged.set(mode, held);
	return {
		settle: () => {
			if (unchanged.get(mode) === held) unchanged.delete(mode);
			held.settle();
		},
	};
}

/** Hold the prompt's slot for the extension command `submission` carries, until the turn that runs it ends. */
export function holdSubmittedExtensionCommand(mode: ExtensionCommandScreen, submission: object): void {
	submitted.set(submission, holdForExtensionCommand(mode));
}

/** The hold of the extension command `submission` carries, which the turn running it settles when it ends. */
export function takeSubmittedExtensionCommandHold(submission: object): PromptSlotHold | undefined {
	const held = submitted.get(submission);
	submitted.delete(submission);
	return held;
}

/**
 * An extension changed the screen: a held slot shows live with the change. Call it after the change is made, so a view
 * mounted in the slot decides for itself when it can draw.
 */
export function extensionChangedScreen(mode: ExtensionCommandScreen): void {
	const held = unchanged.get(mode);
	if (held === undefined) return;
	unchanged.delete(mode);
	const screen = screenHoldOf(mode);
	const wasHeld = screen.region === "prompt";
	held.settle();
	// Draw the live slot before anything else arrives: a view mounted after it can then keep these rows until it draws.
	if (wasHeld && screen.region === undefined) mode.ui.requestImmediateRender();
}
