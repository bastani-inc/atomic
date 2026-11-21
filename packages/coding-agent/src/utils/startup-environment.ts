import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_DEBUG, ENV_OFFLINE, ENV_SKIP_VERSION_CHECK, getAgentDir, getEnvValue, setEnvValue } from "../config.js";
import { inheritsDebugSetting, setDebugSetting } from "../core/debug-setting.ts";
import { parseJsonFileContent } from "./json.ts";

/** Whether an environment flag is on: `1`, `true` or `yes`, the last two in any case. */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * Turns on offline mode in this process's environment when `--offline` is among `args` or `ATOMIC_OFFLINE` is on, and
 * returns whether it is on. Child processes started afterwards, the interactive engine among them, inherit it.
 */
export function applyOfflineEnvironment(args: readonly string[]): boolean {
	const offline = args.includes("--offline") || isTruthyEnvFlag(getEnvValue(ENV_OFFLINE));
	if (offline) {
		setEnvValue(ENV_OFFLINE, "1");
		setEnvValue(ENV_SKIP_VERSION_CHECK, "1");
	}
	return offline;
}

/** Points `HTTP_PROXY` and `HTTPS_PROXY` at the `httpProxy` setting, each only where the environment sets none. */
export function applyHttpProxyEnvironment(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

/**
 * The global settings `main()` turns into environment for child processes, `debug` and `httpProxy`, read from
 * `settings.json` in `agentDir` as the settings manager reads them: a value of the wrong type counts as unset.
 * Undefined when the file is missing or does not parse, where the settings manager also has neither.
 */
function readGlobalEnvironmentSettings(
	agentDir: string,
): { debug: boolean; httpProxy: string | undefined } | undefined {
	try {
		const parsed = parseJsonFileContent(readFileSync(join(agentDir, "settings.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const { debug, httpProxy } = parsed as { debug?: unknown; httpProxy?: unknown };
		return { debug: debug === true, httpProxy: typeof httpProxy === "string" ? httpProxy : undefined };
	} catch {
		return undefined;
	}
}

/**
 * Sets now the environment `main()` derives from the command line (`--offline`, `ATOMIC_OFFLINE`, `--debug`) and from
 * the global settings (`debug`, `httpProxy`), so an engine child started before `main()` runs, as a prewarmed one is,
 * starts with the environment a fresh engine would get. `main()` sets the same values again. `--debug` is read by the
 * argument parser itself, which loads only when the flag is there.
 */
export async function applyStartupEnvironment(args: readonly string[]): Promise<void> {
	applyOfflineEnvironment(args);
	const settings = readGlobalEnvironmentSettings(getAgentDir());
	if (settings) {
		if (!inheritsDebugSetting()) setDebugSetting(settings.debug);
		applyHttpProxyEnvironment(settings.httpProxy);
	}
	if (!args.includes("--debug")) return;
	try {
		const { parseArgs } = await import("../cli/args.ts");
		if (parseArgs([...args]).debug) setEnvValue(ENV_DEBUG, "1");
	} catch {
		// Arguments the parser refuses end the run in main(), which reports them; no engine starts.
	}
}
