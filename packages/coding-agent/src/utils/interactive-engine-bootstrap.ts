import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Private startup channel for the isolated interactive engine.
 *
 * The engine child needs four control values (engine role, host PID, guardian
 * path, and optionally an API key) before its runtime exists. They used to
 * travel as environment variables, which cannot be taken back: under Bun a
 * child spawned without an explicit `env` inherits the runtime's launch-time
 * environment map, so deleting the variables from `process.env` afterwards does
 * not stop arbitrary extension or hook code from leaking them — including the
 * API key — into its own subprocesses.
 *
 * The engine is therefore launched with an environment that never contained the
 * values, and the values travel in a 0600 file whose path is passed as a private
 * CLI argument. The child reads it once, freezes the snapshot, and unlinks it.
 * The filename carries no secret material.
 */
export const INTERACTIVE_ENGINE_BOOTSTRAP_FLAG = "--internal-engine-bootstrap";
export const INTERACTIVE_ENGINE_BOOTSTRAP_VERSION = 1;

export interface InteractiveEngineBootstrap {
	version: number;
	hostPid: number;
	guardFile: string;
	apiKey?: string;
}

/** Publish a bootstrap record atomically so a reader never sees a partial file. */
export function writeInteractiveEngineBootstrap(record: Omit<InteractiveEngineBootstrap, "version">): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-engine-bootstrap-"));
	const finalPath = join(directory, "bootstrap.json");
	const tempPath = `${finalPath}.tmp`;
	const payload: InteractiveEngineBootstrap = { version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION, ...record };
	writeFileSync(tempPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
	renameSync(tempPath, finalPath);
	return finalPath;
}

/** Remove a bootstrap file and its private directory; safe to call repeatedly. */
export function removeInteractiveEngineBootstrap(path: string | undefined): void {
	if (!path) return;
	rmSync(join(path, ".."), { recursive: true, force: true });
}

/**
 * Split the private bootstrap argument out of an argv slice.
 *
 * Returns the remaining arguments so normal CLI parsing never sees the flag.
 */
export function takeInteractiveEngineBootstrapArg(args: readonly string[]): {
	args: string[];
	path: string | undefined;
} {
	const remaining: string[] = [];
	let path: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index]!;
		if (value === INTERACTIVE_ENGINE_BOOTSTRAP_FLAG && index + 1 < args.length) {
			path = args[++index];
			continue;
		}
		if (value.startsWith(`${INTERACTIVE_ENGINE_BOOTSTRAP_FLAG}=`)) {
			path = value.slice(INTERACTIVE_ENGINE_BOOTSTRAP_FLAG.length + 1);
			continue;
		}
		remaining.push(value);
	}
	return { args: remaining, path };
}

/** True when this argv belongs to an isolated interactive engine child. */
export function hasInteractiveEngineBootstrapArg(args: readonly string[]): boolean {
	return takeInteractiveEngineBootstrapArg(args).path !== undefined;
}

/**
 * Read and consume a bootstrap record. The file is always unlinked, including
 * on malformed content, so a stale API key never outlives the handshake.
 */
export function readInteractiveEngineBootstrap(path: string): InteractiveEngineBootstrap | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	} finally {
		removeInteractiveEngineBootstrap(path);
	}
	try {
		const parsed = JSON.parse(raw) as Partial<InteractiveEngineBootstrap>;
		if (parsed.version !== INTERACTIVE_ENGINE_BOOTSTRAP_VERSION) return undefined;
		if (typeof parsed.hostPid !== "number" || typeof parsed.guardFile !== "string") return undefined;
		return {
			version: parsed.version,
			hostPid: parsed.hostPid,
			guardFile: parsed.guardFile,
			...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
		};
	} catch {
		return undefined;
	}
}
