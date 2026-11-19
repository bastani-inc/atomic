import { getKeybindings, type Keybinding, keyInput } from "@bastani/atomic-tui";

/** A press for this row's action, trying the user's bindings in their configured order. */
export function rowKeyInput(action: Keybinding): string | undefined {
	for (const key of getKeybindings().getKeys(action)) {
		const input = keyInput(key);
		if (input !== undefined) return input;
	}
	return undefined;
}
