import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ENV_DEBUG,
	ENV_OFFLINE,
	ENV_SKIP_VERSION_CHECK,
	getAgentConfigPaths,
	getAgentDir,
	getEnvValue,
	setEnvValue,
} from "../config.js";
import { inheritsDebugSetting } from "../core/debug-setting.ts";
import { parseJsonFileContent } from "./json.ts";

/**
 * `DEBUG_SETTING_ENV` of `core/debug-setting.ts`, written here rather than imported: a session that started before an
 * update replaced the installation still holds the earlier code its startup loaded, which did not offer that name to
 * the code loaded later, and a name it lacks would fail to link.
 */
const DEBUG_SETTING_ENV = "ATOMIC_DEBUG_SETTING";

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
 * `httpProxy`, read from the files the settings manager reads for `agentDir` and as it reads them: the agent
 * directory's `settings.json` over the legacy one's, a value of the wrong type unset in its file, and no global settings
 * at all when a file there cannot be read or parsed. Only for a child started before that load, such as the prewarmed
 * engine: this process's environment is left to `main()`, so a file that changes meanwhile ends up only in a launch that
 * no longer matches, and the host starts a fresh engine as it did before.
 */
export async function settingsEnvironmentForEarlyChild(agentDir: string): Promise<Record<string, string>> {
	const files = agentDir === getAgentDir() ? getAgentConfigPaths("settings.json") : [join(agentDir, "settings.json")];
	let debug: boolean | undefined;
	let httpProxy: string | undefined;
	for (const file of files) {
		let parsed: unknown;
		try {
			parsed = parseJsonFileContent(await readFile(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return {};
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const settings = parsed as { debug?: unknown; httpProxy?: unknown };
		if (debug === undefined && typeof settings.debug === "boolean") debug = settings.debug;
		if (httpProxy === undefined && typeof settings.httpProxy === "string") httpProxy = settings.httpProxy;
	}
	const env: Record<string, string> = {};
	if (!inheritsDebugSetting()) env[DEBUG_SETTING_ENV] = debug === true ? "1" : "0";
	// As `applyHttpProxySettings` applies it: trimmed, and only where the environment names no proxy.
	const proxy = httpProxy?.trim();
	if (proxy) {
		if (process.env.HTTP_PROXY === undefined) env.HTTP_PROXY = proxy;
		if (process.env.HTTPS_PROXY === undefined) env.HTTPS_PROXY = proxy;
	}
	return env;
}
