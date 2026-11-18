import { getKeybindings } from "@bastani/atomic-tui";
import type { AppKeybinding } from "../../../core/keybindings.ts";

/** What a terminal sends for the keys a list binds to opening or choosing a row, in the order they are tried. */
const ROW_KEY_INPUTS = ["\r", "\x1b[C", " ", "\t"] as const;

/**
 * What the terminal would send for a key bound to `action`, so a click can press that key and take exactly the path
 * the keyboard takes. Undefined when none of the keys a row click can press is bound to it.
 */
export function rowKeyInput(action: AppKeybinding): string | undefined {
	const keybindings = getKeybindings();
	return ROW_KEY_INPUTS.find((input) => keybindings.matches(input, action));
}
