import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ENV_DEBUG, ENV_OFFLINE, ENV_SKIP_VERSION_CHECK, getEnvValue, setEnvValue } from "../config.js";
import { DEBUG_SETTING_ENV, inheritsDebugSetting } from "../core/debug-setting.ts";
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

/**
 * Sets now the environment `main()` derives from the command line alone (`--offline`, `ATOMIC_OFFLINE`, `--debug`), so
 * an engine child started before `main()` runs, as a prewarmed one is, starts with the environment a fresh engine would
 * get. `main()` sets the same values again. `--debug` is read by the argument parser itself, which loads only when the
 * flag is there.
 */
export async function applyArgumentEnvironment(args: readonly string[]): Promise<void> {
	applyOfflineEnvironment(args);
	if (!args.includes("--debug")) return;
	try {
		const { parseArgs } = await import("../cli/args.ts");
		if (parseArgs([...args]).debug) setEnvValue(ENV_DEBUG, "1");
	} catch {
		// Arguments the parser refuses end the run in main(), which reports them; no engine starts.
	}
}

/**
 * The environment the global settings will give an engine child once `main()` has loaded them: the `debug` setting and
 * `httpProxy`, read from `settings.json` in `agentDir` as the settings manager reads them (a value of the wrong type
 * counts as unset; a missing or unparsable file gives nothing). Only for a child started before that load, such as the
 * prewarmed engine: this process's environment is left to `main()`, so a file that changes meanwhile ends up only in a
 * launch that no longer matches, and the host starts a fresh engine as it did before.
 */
export async function settingsEnvironmentForEarlyChild(agentDir: string): Promise<Record<string, string>> {
	let settings: { debug?: unknown; httpProxy?: unknown };
	try {
		const parsed = parseJsonFileContent(await readFile(join(agentDir, "settings.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		settings = parsed as { debug?: unknown; httpProxy?: unknown };
	} catch {
		return {};
	}
	const env: Record<string, string> = {};
	if (!inheritsDebugSetting()) env[DEBUG_SETTING_ENV] = settings.debug === true ? "1" : "0";
	// As `applyHttpProxySettings` applies it: trimmed, and only where the environment names no proxy.
	const proxy = typeof settings.httpProxy === "string" ? settings.httpProxy.trim() : "";
	if (proxy) {
		if (process.env.HTTP_PROXY === undefined) env.HTTP_PROXY = proxy;
		if (process.env.HTTPS_PROXY === undefined) env.HTTPS_PROXY = proxy;
	}
	return env;
}
