import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { INSTALLED_EXTENSION_ENTRIES } from "../builtin-install-layout.ts";
import { getBuiltinPackageLocations } from "../builtin-packages.ts";

let nativeBuiltinExtensionEntries: Promise<ReadonlySet<string>> | undefined;

async function findNativeBuiltinExtensionEntries(): Promise<ReadonlySet<string>> {
	const entries = await Promise.all(
		getBuiltinPackageLocations().map(async ({ distDirName, packageDir }) => {
			const entryPath = resolve(packageDir, INSTALLED_EXTENSION_ENTRIES[distDirName]);
			return access(entryPath).then(
				() => [entryPath],
				() => [],
			);
		}),
	);
	return new Set(entries.flat());
}

/** Exact installed entry paths belonging to identity-verified Atomic builtin packages. */
export function getNativeBuiltinExtensionEntries(): Promise<ReadonlySet<string>> {
	nativeBuiltinExtensionEntries ??= findNativeBuiltinExtensionEntries();
	return nativeBuiltinExtensionEntries;
}

export async function isNativeBuiltinExtensionPath(resolvedPath: string): Promise<boolean> {
	return (await getNativeBuiltinExtensionEntries()).has(resolvedPath);
}

/** Reset memoized discovery after a test changes the simulated install layout. */
export function resetNativeBuiltinExtensionEntriesForTest(): void {
	nativeBuiltinExtensionEntries = undefined;
}
