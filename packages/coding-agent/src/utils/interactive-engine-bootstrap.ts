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
 *
 * Cleanup is ownership-scoped. The path is untrusted child input — anyone can
 * pass the private flag — so a reader may unlink only that exact file. Only the
 * writer, which holds an {@link InteractiveEngineBootstrapHandle} for the
 * directory it created, may remove that directory recursively.
 */
export const INTERACTIVE_ENGINE_BOOTSTRAP_FLAG = "--internal-engine-bootstrap";
export const INTERACTIVE_ENGINE_BOOTSTRAP_VERSION = 1;

export interface InteractiveEngineBootstrap {
	version: number;
	hostPid: number;
	guardFile: string;
	apiKey?: string;
}

/**
 * Proof that this process created a bootstrap record. A bare path — in
 * particular one taken from argv — is never sufficient for recursive removal.
 */
export interface InteractiveEngineBootstrapHandle {
	readonly path: string;
	readonly directory: string;
}

/**
 * Publish a bootstrap record atomically so a reader never sees a partial file.
 *
 * On any failure the exact temporary file and the directory this call created
 * are removed before the original error propagates, so a `0600` file holding a
 * credential is never left behind.
 */
export function writeInteractiveEngineBootstrap(
	record: Omit<InteractiveEngineBootstrap, "version">,
): InteractiveEngineBootstrapHandle {
	const directory = mkdtempSync(join(tmpdir(), "atomic-engine-bootstrap-"));
	const path = join(directory, "bootstrap.json");
	const tempPath = `${path}.tmp`;
	const payload: InteractiveEngineBootstrap = { version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION, ...record };
	try {
		writeFileSync(tempPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	return { path, directory };
}

/** Remove a bootstrap record and the directory whose creation this handle proves. */
export function removeOwnedInteractiveEngineBootstrap(handle: InteractiveEngineBootstrapHandle | undefined): void {
	if (!handle) return;
	rmSync(handle.directory, { recursive: true, force: true });
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
 * Read and consume a bootstrap record.
 *
 * The named file is always unlinked, including on malformed content, so a stale
 * API key never outlives the handshake. The path came from argv, so nothing
 * around it is touched: no parent directory, no sibling.
 */
export function readInteractiveEngineBootstrap(path: string): InteractiveEngineBootstrap | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	} finally {
		rmSync(path, { force: true });
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
