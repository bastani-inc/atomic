import type { InlineExtension } from "../core/extensions/types.ts";
import herdrExtension from "./herdr/index.js";
import llamaExtension from "./llama/index.js";

/** Name of the builtin that reports pane state to a terminal multiplexer. */
export const HERDR_EXTENSION_NAME = "herdr";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, bundled: true },
	{ name: HERDR_EXTENSION_NAME, factory: herdrExtension, hidden: true, bundled: true },
];

/**
 * The builtins to load for a host that does, or does not, present a terminal pane.
 *
 * The Herdr reporter has nothing to describe in a headless host, and it must be
 * a complete no-op there — not merely inert. `ExtensionAPI` exposes no mode at
 * factory time and `pi.on()` cannot be undone, so an extension cannot decline
 * itself after the fact: the only place the row can be withheld is here, before
 * the factory is ever invoked.
 */
export function builtInExtensionsForHost(presentsTerminalPane: boolean): InlineExtension[] {
	if (presentsTerminalPane) return [...builtInExtensions];
	return builtInExtensions.filter(
		(extension) => typeof extension === "function" || extension.name !== HERDR_EXTENSION_NAME,
	);
}
