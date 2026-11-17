import type { ProviderEnv } from "../types.ts";

/**
 * Fallback for https://github.com/oven-sh/bun/issues/27802.
 * Bun compiled binaries can expose an empty process.env inside Linux sandboxes
 * even though /proc/self/environ contains the environment.
 *
 * This intentionally duplicates restoreSandboxEnv() in
 * packages/coding-agent/src/bun/restore-sandbox-env.ts. The ai package can be
 * used directly, without going through that entrypoint, so provider env lookup
 * must not depend on process.env having been patched.
 */
const procEnv: ReadonlyMap<string, string> | undefined = readBunSandboxEnv();

function readBunSandboxEnv(): ReadonlyMap<string, string> | undefined {
	if (!emptyBunEnv()) return undefined;
	const entries = new Map<string, string>();
	try {
		const { readFileSync } = require("node:fs") as {
			readFileSync(path: string, encoding: BufferEncoding): string;
		};
		const data = readFileSync("/proc/self/environ", "utf-8");
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				entries.set(entry.slice(0, idx), entry.slice(idx + 1));
			}
		}
	} catch {
		// /proc/self/environ may not exist or may not be readable.
	}
	return entries;
}

function emptyBunEnv(): boolean {
	return typeof process !== "undefined" && !!process.versions?.bun && Object.keys(process.env).length === 0;
}

function getBunSandboxEnvValue(name: string): string | undefined {
	return emptyBunEnv() ? procEnv?.get(name) : undefined;
}

/**
 * Resolve a provider env value from scoped overrides, normal process.env, then
 * the duplicated Bun sandbox fallback for direct pi-ai consumers.
 */
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return (
		env?.[name] ||
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		getBunSandboxEnvValue(name) ||
		undefined
	);
}

/**
 * Resolve a library setting from the environment: `ATOMIC_<name>` when set, else the legacy `PI_<name>`. Each name is
 * looked up as `getProviderEnvValue()` does.
 */
export function getAtomicEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return getProviderEnvValue(`ATOMIC_${name}`, env) ?? getProviderEnvValue(`PI_${name}`, env);
}
