import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { getManifestFromPackageJson } from "../package-manager-manifest.ts";

/**
 * The storage adapters of the packages an Atomic process's host loaded, as the processes it starts receive them: a JSON
 * object from each adapter name, `<package>` or `<package>/<name>`, to the absolute adapter module it selects.
 */
export const HOST_STORAGE_ADAPTERS_ENV = "ATOMIC_HOST_STORAGE_ADAPTERS";

// Process-wide, and shared by every loaded copy of this module.
const HOST_ADAPTERS = Symbol.for("@bastani/atomic/storage/host-adapters");
const registry: typeof globalThis & { [HOST_ADAPTERS]?: Map<string, string> } = globalThis;

/** The adapters this process inherited from the process that started it. */
function inheritedAdapters(): Map<string, string> {
	const adapters = new Map<string, string>();
	const text = process.env[HOST_STORAGE_ADAPTERS_ENV];
	if (text === undefined || text.length === 0) return adapters;
	let value: string | number | boolean | object | null;
	try {
		value = JSON.parse(text);
	} catch {
		return adapters;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return adapters;
	for (const [name, module] of Object.entries(value)) {
		if (typeof module === "string" && isAbsolute(module)) adapters.set(name, module);
	}
	return adapters;
}

function hostAdapters(): Map<string, string> {
	registry[HOST_ADAPTERS] ??= inheritedAdapters();
	return registry[HOST_ADAPTERS];
}

function readPackageJson(root: string): { name?: string } | undefined {
	try {
		const value: object | null = JSON.parse(stripBom(readFileSync(join(root, "package.json"), "utf8")));
		return typeof value === "object" && value !== null ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Makes the storage adapters of the package directories among `sources`, the extension paths a host passes to load as
 * code, selectable by name in this process and the processes it starts. Other sources are ignored, and relative paths
 * resolve against `cwd`. `<package>` selects the package's first listed `storageAdapters` entry and `<package>/<name>`
 * the first entry whose file name without its extension is `<name>`; a name registered first keeps its module.
 */
export function registerHostStoragePackages(sources: readonly string[] | undefined, cwd: string): void {
	for (const source of sources ?? []) {
		if (!isLocalPath(source)) continue;
		let root: string;
		try {
			root = resolvePath(source, cwd);
		} catch {
			continue;
		}
		const pkg = readPackageJson(root);
		const adapters = getManifestFromPackageJson(pkg)?.storageAdapters ?? [];
		if (typeof pkg?.name !== "string" || adapters.length === 0) continue;
		const registered = hostAdapters();
		const add = (name: string, module: string) => {
			if (!registered.has(name)) registered.set(name, resolve(root, module));
		};
		add(pkg.name, adapters[0]!);
		for (const module of adapters) add(`${pkg.name}/${basename(module, extname(module))}`, module);
	}
}

/** The adapter module `name` selects from the packages this process's host loaded, or undefined. */
export function hostStorageAdapter(name: string): string | undefined {
	return hostAdapters().get(name);
}

/** The environment that passes this process's host-loaded adapters to a process it starts; empty without any. */
export function hostStorageAdaptersEnvironment(): NodeJS.ProcessEnv {
	const adapters = hostAdapters();
	return adapters.size === 0 ? {} : { [HOST_STORAGE_ADAPTERS_ENV]: JSON.stringify(Object.fromEntries(adapters)) };
}
