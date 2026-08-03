/**
 * Host-local engine generation lifecycle.
 *
 * A dead engine child cannot send a protocol frame, so generation death can
 * never be a wire message: SIGKILL, spawn errors, closed stdin, and malformed
 * JSONL all have to be observed by the host. `RpcClient` publishes this event
 * synchronously, before any restart work, so host controllers can tear down
 * exactly the dead generation without waiting for a later `engine_ready`.
 */

export type InteractiveEngineGenerationEndKind =
	| "exit"
	| "process-error"
	| "stdin-error"
	| "transport-error"
	| "explicit-stop";

export interface InteractiveEngineGenerationEnded {
	/**
	 * The generation that ended. Remote component IDs restart at
	 * `remote_component_1` for every child, so stale teardown must never close a
	 * mount owned by a newer generation.
	 */
	generation: number;
	/** Concrete cause, used for pending-request rejection and recovery notices. */
	error: Error;
	kind: InteractiveEngineGenerationEndKind;
	/**
	 * True for host-initiated termination (explicit stop, deliberate generation
	 * replacement, shutdown). Automatic recovery must only run for unexpected
	 * loss, never for ordinary shutdown.
	 */
	expected: boolean;
}

export type InteractiveEngineGenerationEndedListener = (event: InteractiveEngineGenerationEnded) => void;
