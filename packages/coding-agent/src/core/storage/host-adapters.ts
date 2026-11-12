import { isAbsolute } from "node:path";

/**
 * The storage adapters of the packages an Atomic process's host loaded, as the processes it starts receive them: a JSON
 * object from each adapter name, `<package>` or `<package>/<name>`, to the absolute adapter module it selects.
 */
export const HOST_STORAGE_ADAPTERS_ENV = "ATOMIC_HOST_STORAGE_ADAPTERS";

// Process-wide, and shared by every loaded copy of this module. This module imports nothing of Atomic's, because every
// child process environment reads it, including in processes that load Atomic's sources on their own.
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

/** Makes `name` select the absolute adapter `module` in this process and the processes it starts; a registered name keeps its module. */
export function addHostStorageAdapter(name: string, module: string): void {
	const adapters = hostAdapters();
	if (!adapters.has(name)) adapters.set(name, module);
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
