import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

export type ClipboardModule = {
	setText: (text: string) => Promise<void>;
	getText: () => Promise<string>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
	/** Pasteboard types on the clipboard, such as `public.file-url`. Absent from older module versions. */
	availableFormats?: () => string[];
};

type ClipboardRequire = (id: string) => unknown;

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire],
): ClipboardModule | null {
	for (const requireClipboard of requires) {
		try {
			return requireClipboard("@mariozechner/clipboard") as ClipboardModule;
		} catch {
			// Try the next resolution root.
		}
	}
	return null;
}

/**
 * A getter for the native clipboard module that loads it on its first call, once: loading the addon is a native library
 * load, which startup does not need. `wanted` is false where the native module is not used (Linux without a display,
 * Termux); the getter then returns null without loading anything.
 */
export function createNativeClipboardGetter(
	wanted: boolean,
	load: () => ClipboardModule | null = loadClipboardNative,
): () => ClipboardModule | null {
	let loaded: { readonly module: ClipboardModule | null } | undefined;
	return () => {
		loaded ??= { module: wanted ? load() : null };
		return loaded.module;
	};
}

/** The native clipboard module, loaded on first use; null when it is unavailable or not used here. */
export const getNativeClipboard = createNativeClipboardGetter(!process.env.TERMUX_VERSION && hasDisplay);
