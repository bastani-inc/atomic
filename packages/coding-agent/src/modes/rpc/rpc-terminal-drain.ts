import { parseInteractiveEngineMessage } from "../interactive-engine/protocol.ts";
import { EXIT_DRAIN_TIMEOUT_MS } from "./rpc-command-timeouts.ts";

/**
 * The bounded window between an engine generation dying and its requests being
 * classified.
 *
 * Death is published to the host immediately — the TUI must not wait on a pipe
 * — but the dead child's stdout is parsed asynchronously and may still hold the
 * frame that says "I took this request and started running it". Failing the
 * requests before that frame is read would report already-running work as never
 * sent, and the host would offer the user's text back for a second run.
 *
 * So the generation stays in this phase until its stdout drains: its reader
 * stays attached, its request state stays addressable, and the replacement is
 * not started yet. The first terminal cause owns the phase, so a recovery stop
 * cannot overwrite an exit error with `Agent process stopped`, and settlement
 * happens exactly once. The timeout is the escape hatch for a descendant that
 * inherited stdout and never closes it.
 */
export class RpcTerminalDrain {
	private generation: number | undefined;
	private settlement: Promise<void> | undefined;
	private claimed: { generation: number; error: Error } | undefined;

	/**
	 * Record the cause that owns this generation's terminal phase, without
	 * starting the wait. An explicit stop claims before it terminates the child,
	 * so the exit it provokes does not relabel the teardown it asked for.
	 */
	claim(generation: number, error: Error): Error {
		if (this.claimed?.generation !== generation) this.claimed = { generation, error };
		return this.claimed.error;
	}

	/**
	 * Enter the phase for `generation`, or join the one already running.
	 *
	 * `settle` receives the claimed error — whichever cause got here first — and
	 * runs exactly once for that generation.
	 */
	begin(generation: number, drained: Promise<void>, error: Error, settle: (error: Error) => void): Promise<void> {
		const cause = this.claim(generation, error);
		if (this.generation === generation && this.settlement) return this.settlement;
		this.generation = generation;
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			settle(cause);
		};
		const timer = setTimeout(finish, EXIT_DRAIN_TIMEOUT_MS);
		timer.unref?.();
		this.settlement = drained.then(finish, finish);
		return this.settlement;
	}

	/**
	 * Consume a frame from a generation that is in its terminal phase.
	 *
	 * Only ownership survives death: request ids never repeat, so a late
	 * admission can only ever address its own request. Every other engine frame
	 * from the dead generation is swallowed here rather than reaching host state,
	 * which would revive a PID, a heartbeat, an activity, or a mount.
	 */
	observe(generation: number, line: string, markAccepted: (requestId: string) => void): boolean {
		if (!this.isDraining(generation)) return false;
		const message = parseInteractiveEngineMessage(line);
		if (!message) return false;
		if (message.type === "engine_request_accepted") markAccepted(message.requestId);
		return true;
	}

	/** True while `generation` is dead but its ownership frames may still arrive. */
	isDraining(generation: number): boolean {
		return this.generation === generation && this.settlement !== undefined;
	}

	/**
	 * Wait for `generation` to finish settling. Resolves immediately for a
	 * generation that never entered the phase, so callers need no branch.
	 */
	settled(generation: number): Promise<void> {
		return this.generation === generation && this.settlement ? this.settlement : Promise.resolve();
	}
}
