import type { KeyId } from "@earendil-works/pi-tui";

/** Comparison identity only; keep the caller's spelling for registration and display. */
export function keybindingIdentity(key: KeyId): string {
	// pi-tui's key-id parser is private (parseKey accepts terminal bytes, not ids).
	// Like that parser, modifier order is immaterial and key names ignore case.
	const parts = key.toLowerCase().split("+");
	const base = parts.pop()!;
	const canonicalBase = base === "return" ? "enter" : base === "esc" ? "escape" : base;
	return [...["ctrl", "shift", "alt", "super"].filter((modifier) => parts.includes(modifier)), canonicalBase].join(
		"+",
	);
}
