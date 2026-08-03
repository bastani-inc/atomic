import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * Physical key identity, independent of configured actions.
 *
 * Engine safety routing must not be derived from `app.clear`. That binding is
 * user-configurable, so `{"app.clear":"escape"}` would otherwise make physical
 * Escape reach the stop/restart branch and leave physical Ctrl+C with no host
 * route at all — the opposite of the contract on both keys.
 *
 * Matching goes through pi-tui's parser rather than raw prefixes: by the time a
 * global listener runs, `StdinBuffer` has already assembled complete CSI, OSC,
 * DCS, APC, and bracketed-paste sequences, and a bare Escape is itself a
 * sequence introducer. `data.startsWith("\x1b")` would misread all of those.
 */
export function isPhysicalEscape(data: string): boolean {
	return !isKeyRelease(data) && matchesKey(data, Key.escape);
}

export function isPhysicalCtrlC(data: string): boolean {
	return !isKeyRelease(data) && matchesKey(data, Key.ctrl("c"));
}

/**
 * Kitty key-release events reach global listeners before the TUI filters them
 * for the focused component, so a safety action would otherwise fire twice per
 * press.
 */
export function isSafetyKeyRelease(data: string): boolean {
	return isKeyRelease(data) && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")));
}
