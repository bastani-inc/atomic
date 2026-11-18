import type { AgentSession } from "@bastani/atomic";
import { asAgentSession, disposeStageSession } from "./stage-runner-session.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

/**
 * How long the runner waits for a replaced session's turn to end before it creates the successor anyway. A tool or
 * extension that ignores its abort signal must not hang the stage; the stopped session already starts no new turn.
 */
export const REPLACED_SESSION_STOP_TIMEOUT_MS = 10_000;

export interface StageSessionStopOptions {
	readonly timeoutMs?: number;
	/** The stage's own cancellation ends the wait too. */
	readonly signal?: AbortSignal;
}

function holdsDeliveries(session: StageSessionRuntime): boolean {
	return session.queuedMessagesPaused === true;
}

/** Keeps detached completion ownership continuous while a fallback session is replaced. */
export class StageSessionReplacement {
	private previous: StageSessionRuntime | undefined;
	private readonly cleanups = new Set<Promise<void>>();
	/** Stopping the retiring session held its queued deliveries; the successor releases them once it owns them. */
	private releaseSuccessorQueue = false;
	/** The successor's release of those deliveries; its first prompt waits for it. */
	private successorRelease: Promise<void> | undefined;

	/** Generation-owned work remains live while the replacement is being created. */
	get retiringSession(): StageSessionRuntime | undefined {
		return this.previous;
	}

	retire(session: StageSessionRuntime | undefined): void {
		if (session) this.previous = session;
	}

	/**
	 * Ends the retiring session's turn before its successor is created: a turn it was still running (a continuation, a
	 * delivery's turn or a tool call) would otherwise keep working next to the successor until it went idle. Stopping a
	 * stage session holds its queued deliveries, which move to the successor; a hold the stage did not already have is
	 * released there.
	 */
	async stop(
		session: StageSessionRuntime | undefined,
		options: StageSessionStopOptions = {},
	): Promise<"stopped" | "timed-out" | "cancelled"> {
		if (!session) return "stopped";
		const alreadyHeld = holdsDeliveries(session);
		const stopping = Promise.resolve().then(() => session.abort());
		let outcome: "stopped" | "timed-out" | "cancelled";
		try {
			outcome = await boundedStop(stopping, options.timeoutMs ?? REPLACED_SESSION_STOP_TIMEOUT_MS, options.signal);
		} finally {
			// The hold is taken as the stop begins, so it is known even when the stop's wait for idle never ends.
			if (!alreadyHeld && holdsDeliveries(session)) this.releaseSuccessorQueue = true;
		}
		if (outcome !== "stopped") void stopping.catch(() => {});
		return outcome;
	}

	/**
	 * The adopted successor's release of the deliveries it took over, to await before prompting it; `undefined` when
	 * none is pending, so a prompt with nothing to wait for takes no extra tick.
	 */
	successorReady(): Promise<void> | undefined {
		const release = this.successorRelease;
		if (release === undefined) return undefined;
		return release.then(() => {
			if (this.successorRelease === release) this.successorRelease = undefined;
		});
	}

	adopt(session: StageSessionRuntime): void {
		const previous = this.previous;
		this.previous = undefined;
		if (!previous) return;
		const source = asAgentSession(previous) as
			| (AgentSession & {
					transferWorkflowStageDeliveriesTo?(target: AgentSession): void;
			  })
			| undefined;
		const target = asAgentSession(session);
		if (source && target) source.transferWorkflowStageDeliveriesTo?.(target);
		if (this.releaseSuccessorQueue) {
			this.releaseSuccessorQueue = false;
			// Releases the hold without starting a turn: the runner's prompt to the successor carries the deliveries.
			this.successorRelease = Promise.resolve()
				.then(() => session.resumeQueuedMessages?.())
				.then(
					() => undefined,
					(error: unknown) => {
						console.error("atomic-workflows: releasing a replacement stage session's deliveries failed", error);
					},
				);
		}
		const cleanup = this.disposeAfterIdle(previous);
		this.cleanups.add(cleanup);
		void cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
	}

	async dispose(): Promise<void> {
		const previous = this.previous;
		this.previous = undefined;
		await Promise.allSettled([...(previous ? [disposeStageSession(previous)] : []), ...this.cleanups]);
	}

	/** A walk that ends without a successor leaves the retired session unowned, so it closes now. */
	async disposeRetired(): Promise<void> {
		const previous = this.previous;
		this.previous = undefined;
		this.releaseSuccessorQueue = false;
		this.successorRelease = undefined;
		if (!previous) return;
		await disposeStageSession(previous).catch((error: unknown) => {
			console.error("atomic-workflows: retired stage session disposal failed", error);
		});
	}

	private async disposeAfterIdle(session: StageSessionRuntime): Promise<void> {
		const agent = session.agent as { waitForIdle?: () => Promise<void> } | undefined;
		if (typeof agent?.waitForIdle === "function") await agent.waitForIdle();
		await disposeStageSession(session);
	}
}

function boundedStop(
	stopping: Promise<unknown>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<"stopped" | "timed-out" | "cancelled"> {
	if (signal?.aborted) return Promise.resolve("cancelled");
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish("timed-out"), timeoutMs);
		const onAbort = (): void => finish("cancelled");
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		function finish(outcome: "stopped" | "timed-out" | "cancelled", error?: unknown): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error !== undefined) reject(error);
			else resolve(outcome);
		}
		stopping.then(
			() => finish("stopped"),
			(error: unknown) => finish("stopped", error),
		);
	});
}
