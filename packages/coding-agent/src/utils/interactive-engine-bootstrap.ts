import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTrustDecisions } from "../core/project-trust-state.ts";

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
/**
 * The only argument of an engine child an interactive host starts before it knows the engine's arguments: the child
 * loads the application, then reads them from its first stdin line (see engine-prewarm.ts).
 */
export const INTERACTIVE_ENGINE_PREWARM_FLAG = "--internal-engine-prewarm";

export interface InteractiveEngineBootstrap {
	version: number;
	hostPid: number;
	guardFile: string;
	apiKey?: string;
	/** Trust decisions the host session already made; never saved to trust.json. */
	trustDecisions?: SessionTrustDecisions;
	/** The host accepts a pending withdrawal, distinct from a settled trust decision. */
	projectResourceWithdrawals?: true;
	/** The host draws the queued messages the main session is delivering, from changes on the engine's event lines. */
	queuedDeliveries?: true;
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

export async function writeInteractiveEngineBootstrapAsync(
	record: Omit<InteractiveEngineBootstrap, "version">,
): Promise<InteractiveEngineBootstrapHandle> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-engine-bootstrap-"));
	const path = join(directory, "bootstrap.json");
	const tempPath = `${path}.tmp`;
	const payload: InteractiveEngineBootstrap = { version: INTERACTIVE_ENGINE_BOOTSTRAP_VERSION, ...record };
	try {
		await writeFile(tempPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		await rm(directory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	return { path, directory };
}

export async function removeOwnedInteractiveEngineBootstrapAsync(
	handle: InteractiveEngineBootstrapHandle | undefined,
): Promise<void> {
	if (!handle) return;
	await rm(handle.directory, { recursive: true, force: true }).catch(() => {});
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
		const trustDecisions = readTrustDecisions(parsed.trustDecisions);
		return {
			version: parsed.version,
			hostPid: parsed.hostPid,
			guardFile: parsed.guardFile,
			...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
			...(trustDecisions ? { trustDecisions } : {}),
			...(parsed.projectResourceWithdrawals === true ? { projectResourceWithdrawals: true } : {}),
			...(parsed.queuedDeliveries === true ? { queuedDeliveries: true } : {}),
		};
	} catch {
		return undefined;
	}
}

/** The trust decisions of a bootstrap record: only true or false values by path; anything else is left out. */
function readTrustDecisions(value: unknown): SessionTrustDecisions | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const decisions = {
		projects: readDecisions(record.projects),
		extensionSources: readDecisions(record.extensionSources),
	};
	return Object.keys(decisions.projects).length + Object.keys(decisions.extensionSources).length > 0
		? decisions
		: undefined;
}

function readDecisions(value: unknown): Record<string, boolean> {
	const decisions: Record<string, boolean> = {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return decisions;
	for (const [path, trusted] of Object.entries(value)) {
		if (typeof trusted === "boolean") decisions[path] = trusted;
	}
	return decisions;
}
