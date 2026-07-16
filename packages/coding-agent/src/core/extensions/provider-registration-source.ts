import { isBuiltinCursorExtensionPath } from "../builtin-packages.ts";
import type { Extension } from "./types.ts";

// Capability identities are granted only by the real module loader after it
// verifies an exact shipped Cursor extension entry. Configuration, paths, and
// routing metadata cannot reproduce WeakSet membership.
const trustedCursorProviderSources = new WeakSet<Extension>();

export function trustCursorProviderSource(extension: Extension): void {
	if (extension.loadedFromModule && isBuiltinCursorExtensionPath(extension.resolvedPath)) {
		trustedCursorProviderSources.add(extension);
	}
}

export function isTrustedCursorProviderSource(extension: Extension | undefined): boolean {
	return extension !== undefined && trustedCursorProviderSources.has(extension);
}
