import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { memoizeAsync } from "../../utils/memoize-async.js";
import {
	BUILTIN_PACKAGE_DIR_NAMES,
	INSTALLED_EXTENSION_ENTRIES,
	SOURCE_EXTENSION_ENTRIES,
} from "../builtin-install-layout.ts";
import { getBuiltinPackageLocations } from "../builtin-packages.ts";

function candidateNativeBuiltinEntries(): string[] {
	return getBuiltinPackageLocations().map(({ distDirName, packageDir }) =>
		resolve(packageDir, INSTALLED_EXTENSION_ENTRIES[distDirName]),
	);
}

async function findNativeBuiltinExtensionEntries(): Promise<{
	readonly entries: ReadonlySet<string>;
	readonly complete: boolean;
}> {
	const candidates = candidateNativeBuiltinEntries();
	const found = await Promise.all(
		candidates.map((entryPath) =>
			access(entryPath).then(
				() => [entryPath],
				() => [],
			),
		),
	);
	const entries = new Set(found.flat());
	return {
		entries,
		complete: candidates.length === BUILTIN_PACKAGE_DIR_NAMES.length && entries.size === candidates.length,
	};
}

const loadNativeBuiltinExtensionEntries = memoizeAsync(findNativeBuiltinExtensionEntries, {
	// Never permanently cache a partial or empty set (for example, during an in-place update directory swap).
	shouldCache: (result) => result.complete,
});

/** Exact installed entry paths belonging to identity-verified Atomic builtin packages. */
export async function getNativeBuiltinExtensionEntries(): Promise<ReadonlySet<string>> {
	return (await loadNativeBuiltinExtensionEntries()).entries;
}

export async function isNativeBuiltinExtensionPath(resolvedPath: string): Promise<boolean> {
	if (!candidateNativeBuiltinEntries().includes(resolvedPath)) return false;
	return (await getNativeBuiltinExtensionEntries()).has(resolvedPath);
}

/**
 * Whether `resolvedPath` is the TypeScript source entry of an identity-verified Atomic builtin package, as a source
 * checkout loads it. Installed layouts load the bundled entries instead.
 */
export function isSourceBuiltinExtensionPath(resolvedPath: string): boolean {
	return getBuiltinPackageLocations().some(
		({ distDirName, packageDir }) => resolve(packageDir, SOURCE_EXTENSION_ENTRIES[distDirName]) === resolvedPath,
	);
}

/** Reset memoized discovery after a test changes the simulated install layout. */
export function resetNativeBuiltinExtensionEntriesForTest(): void {
	loadNativeBuiltinExtensionEntries.reset();
}
