import type { SessionTrustDecisions, StartupExtensionCheck } from "../core/project-trust-state.ts";
import type { InteractiveEngineBootstrap } from "./interactive-engine-bootstrap.ts";

/**
 * Legacy interactive-engine control variables.
 *
 * The host no longer sets these: engine startup metadata travels through a
 * protected bootstrap file (see interactive-engine-bootstrap.ts) precisely
 * because environment values cannot be taken back from a Bun process tree. They
 * are still recognized and scrubbed as defense in depth, so an inherited or
 * caller-supplied value can neither select engine mode nor reach a child.
 */
export const INTERACTIVE_ENGINE_ENV_VARS = [
	"ATOMIC_INTERACTIVE_ENGINE_CHILD",
	"ATOMIC_INTERACTIVE_ENGINE_HOST_PID",
	"ATOMIC_INTERACTIVE_ENGINE_GUARD_FILE",
	"ATOMIC_INTERACTIVE_ENGINE_API_KEY",
] as const;

/** Immutable startup values captured before they are removed from `process.env`. */
export interface InteractiveEngineStartupEnv {
	readonly child: string | undefined;
	readonly hostPid: string | undefined;
	readonly guardFile: string | undefined;
	readonly apiKey: string | undefined;
	/** Trust decisions of this host session, handed to an engine started to replace one that stopped. */
	readonly trustDecisions?: SessionTrustDecisions;
	readonly projectResourceWithdrawals?: true;
	/** What the host's startup found when it checked whether an extension could decide its folder's trust. */
	readonly startupExtensionCheck?: StartupExtensionCheck;
	/** The host draws the queued messages the main session is delivering (see `QueuedDeliveryRelay`). */
	readonly queuedDeliveries?: true;
	/** The session the host started for this engine to open, as a new session or a fork. */
	readonly startedSessionId?: string;
	/** This engine replaced one that stopped unexpectedly; suppress user-facing startup resume prompts. */
	readonly restarted?: true;
}

let snapshot: InteractiveEngineStartupEnv | undefined;

/**
 * Copy an environment without the interactive-engine control variables.
 *
 * Pure: the input object is never mutated. Call this AFTER merging every other
 * environment source so a caller-supplied value cannot reintroduce a key.
 */
export function scrubInteractiveEngineEnv<T extends NodeJS.ProcessEnv>(env: T): T {
	const copy = { ...env } as T;
	for (const name of INTERACTIVE_ENGINE_ENV_VARS) delete copy[name];
	return copy;
}

/**
 * Capture the engine startup values once and remove the legacy variables from
 * `process.env`.
 *
 * A bootstrap record is authoritative when present. The legacy environment is
 * only a fallback for a host that still launches the old way; it cannot be made
 * safe on its own, because Bun children spawned without an explicit `env`
 * inherit the runtime's launch-time environment no matter what this process
 * deletes afterwards. Idempotent: later calls return the same frozen snapshot.
 */
export function captureInteractiveEngineStartupEnv(
	bootstrap?: InteractiveEngineBootstrap,
): InteractiveEngineStartupEnv {
	if (snapshot) return snapshot;
	snapshot = Object.freeze(
		bootstrap
			? {
					child: "1",
					hostPid: String(bootstrap.hostPid),
					guardFile: bootstrap.guardFile,
					apiKey: bootstrap.apiKey,
					...(bootstrap.trustDecisions ? { trustDecisions: bootstrap.trustDecisions } : {}),
					...(bootstrap.projectResourceWithdrawals ? { projectResourceWithdrawals: true as const } : {}),
					...(bootstrap.startupExtensionCheck ? { startupExtensionCheck: bootstrap.startupExtensionCheck } : {}),
					...(bootstrap.queuedDeliveries ? { queuedDeliveries: true as const } : {}),
					...(bootstrap.startedSessionId !== undefined ? { startedSessionId: bootstrap.startedSessionId } : {}),
					...(bootstrap.restarted ? { restarted: true as const } : {}),
				}
			: {
					child: process.env.ATOMIC_INTERACTIVE_ENGINE_CHILD,
					hostPid: process.env.ATOMIC_INTERACTIVE_ENGINE_HOST_PID,
					guardFile: process.env.ATOMIC_INTERACTIVE_ENGINE_GUARD_FILE,
					apiKey: process.env.ATOMIC_INTERACTIVE_ENGINE_API_KEY,
				},
	);
	for (const name of INTERACTIVE_ENGINE_ENV_VARS) delete process.env[name];
	return snapshot;
}

/** Frozen startup snapshot; captures (and scrubs) on first read. */
export function interactiveEngineStartupEnv(): InteractiveEngineStartupEnv {
	return captureInteractiveEngineStartupEnv();
}

/** True when this process was started as the isolated interactive engine child. */
export function isInteractiveEngineChild(): boolean {
	return interactiveEngineStartupEnv().child === "1";
}
