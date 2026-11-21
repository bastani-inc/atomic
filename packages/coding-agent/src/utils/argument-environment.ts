import { ENV_DEBUG, ENV_OFFLINE, ENV_SKIP_VERSION_CHECK, getEnvValue, setEnvValue } from "../config.js";

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
 * Sets now the environment `main()` derives from the command line (`--offline`, `ATOMIC_OFFLINE`, `--debug`), so an
 * engine child started before `main()` runs, as a prewarmed one is, starts with the environment a fresh engine would.
 * `--debug` is read by the argument parser itself, which loads only when the flag is there.
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
