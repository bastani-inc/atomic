import { resolve } from "node:path";
import {
	type BuiltinPackageDirName,
	INSTALLED_EXTENSION_ENTRIES,
	SOURCE_EXTENSION_ENTRIES,
} from "../builtin-install-layout.ts";
import { getBuiltinPackageLocations } from "../builtin-packages.ts";

let builtinExtensionEntryLabels: ReadonlyMap<string, BuiltinPackageDirName> | undefined;

function normalizeEntryPath(entryPath: string): string {
	return resolve(entryPath).replace(/\\/g, "/");
}

/** Exact source and installed entry paths belonging to identity-verified Atomic builtin packages. */
export function getBuiltinExtensionEntryLabel(entryPath: string): BuiltinPackageDirName | undefined {
	if (!builtinExtensionEntryLabels) {
		builtinExtensionEntryLabels = new Map(
			getBuiltinPackageLocations().flatMap(({ distDirName, packageDir }) => [
				[normalizeEntryPath(resolve(packageDir, SOURCE_EXTENSION_ENTRIES[distDirName])), distDirName],
				[normalizeEntryPath(resolve(packageDir, INSTALLED_EXTENSION_ENTRIES[distDirName])), distDirName],
			]),
		);
	}
	return builtinExtensionEntryLabels.get(normalizeEntryPath(entryPath));
}

/** Reset memoized discovery after a test changes the simulated install layout. */
export function resetBuiltinExtensionEntryLabelsForTest(): void {
	builtinExtensionEntryLabels = undefined;
}
