import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { INSTALLED_EXTENSION_ENTRIES } from "../builtin-install-layout.ts";
import { getBuiltinPackageLocations } from "../builtin-packages.ts";

let nativeBuiltinExtensionEntries: ReadonlySet<string> | undefined;

/** Exact installed entry paths belonging to identity-verified Atomic builtin packages. */
export function getNativeBuiltinExtensionEntries(): ReadonlySet<string> {
	if (nativeBuiltinExtensionEntries) return nativeBuiltinExtensionEntries;

	nativeBuiltinExtensionEntries = new Set(
		getBuiltinPackageLocations().flatMap(({ distDirName, packageDir }) => {
			const entryPath = resolve(packageDir, INSTALLED_EXTENSION_ENTRIES[distDirName]);
			return existsSync(entryPath) ? [entryPath] : [];
		}),
	);
	return nativeBuiltinExtensionEntries;
}

export function isNativeBuiltinExtensionPath(resolvedPath: string): boolean {
	return getNativeBuiltinExtensionEntries().has(resolvedPath);
}

/** Reset memoized discovery after a test changes the simulated install layout. */
export function resetNativeBuiltinExtensionEntriesForTest(): void {
	nativeBuiltinExtensionEntries = undefined;
}
