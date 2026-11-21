import { createModuleRequire } from "./module-require.js";

/**
 * Atomic cannot run a session without its native module (`@bastani/atomic-natives`): its subagents, for one, are built
 * on it. The message says why the module did not load, as its loader words it: for a platform package an install left
 * out, which package and how to reinstall Atomic with it.
 */
export class NativeModuleUnavailableError extends Error {
	readonly code = "NativeModuleUnavailable";

	constructor(message: string, options: { cause: unknown }) {
		super(message, options);
		this.name = "NativeModuleUnavailableError";
	}
}

let loaded = false;

/**
 * Load Atomic's native module, or throw a {@link NativeModuleUnavailableError} that says why it cannot load. Only a load
 * that succeeded is kept: a later call tries again, so a process that outlives a reinstall can use the module then.
 */
export function assertNativeModuleAvailable(): void {
	if (loaded) return;
	try {
		createModuleRequire(import.meta.url)("@bastani/atomic-natives");
		loaded = true;
	} catch (error) {
		// The loader's own message is its first line: the rest is a resolution's require stack.
		const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
		throw new NativeModuleUnavailableError(message, { cause: error });
	}
}
