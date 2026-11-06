/**
 * Waits for an RPC bash request's streamed output on the shell's own schedule.
 *
 * A loaded runner can take seconds to start a shell, and a stalled test process
 * can sleep past any deadline with the shell's output already waiting in the
 * pipe. So startup has no budget of its own: the wait ends when the prefix
 * arrives, when the request settles without it, or, once the shell signals
 * readiness, when the output it writes next has not reached the RPC stream
 * within {@link RPC_OUTPUT_AFTER_READY_TIMEOUT_MS} after pending I/O is drained.
 * Anything slower is bounded by the per-test timeout.
 */
export const RPC_OUTPUT_AFTER_READY_TIMEOUT_MS = 10_000;
export const RPC_OUTPUT_POLL_INTERVAL_MS = 5;

export interface RpcBashOutputWaitClock {
	now(): number;
	sleep(ms: number): Promise<void>;
	/**
	 * Resolves after the event loop has processed I/O that was already pending.
	 * Two check phases always enclose a full poll phase, whichever phase the
	 * caller is running in; one would not when called from an I/O callback.
	 */
	drainPendingIo(): Promise<void>;
}

const nextCheckPhase = () => new Promise<void>((resolve) => setImmediate(resolve));

export const realClock: RpcBashOutputWaitClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	drainPendingIo: async () => {
		await nextCheckPhase();
		await nextCheckPhase();
	},
};

export type RpcBashResponse = object | undefined;

export interface RpcBashOutputWait<Response extends RpcBashResponse> {
	readonly id: string;
	readonly expectedPrefix: string;
	readonly observed: () => string;
	readonly execution: Promise<Response>;
	/** The shell's own readiness signal, written immediately before the expected output. */
	readonly isReady?: () => boolean;
	readonly afterReadyTimeoutMs?: number;
	readonly clock?: RpcBashOutputWaitClock;
}

export type RpcBashSettlement = { readonly response: RpcBashResponse } | { readonly error: Error };

export type RpcBashOutputWaitFailure = "settled-before-output" | "silent-after-ready";

export class RpcBashOutputWaitError extends Error {
	override readonly name = "RpcBashOutputWaitError" as const;
	readonly reason: RpcBashOutputWaitFailure;
	readonly id: string;
	readonly expectedPrefix: string;
	readonly observed: string;
	readonly settlement: RpcBashSettlement | undefined;

	constructor(
		reason: RpcBashOutputWaitFailure,
		id: string,
		expectedPrefix: string,
		observed: string,
		settlement: RpcBashSettlement | undefined,
	) {
		super(
			`RPC bash ${JSON.stringify(id)} did not stream output prefix ${JSON.stringify(expectedPrefix)} (${reason}); observed accumulated output: ${JSON.stringify(observed)}; settlement: ${JSON.stringify(settlement ?? "pending")}`,
		);
		this.reason = reason;
		this.id = id;
		this.expectedPrefix = expectedPrefix;
		this.observed = observed;
		this.settlement = settlement;
	}
}

export async function waitForRpcBashOutput<Response extends RpcBashResponse>(
	wait: RpcBashOutputWait<Response>,
): Promise<void> {
	const clock = wait.clock ?? realClock;
	const afterReadyTimeoutMs = wait.afterReadyTimeoutMs ?? RPC_OUTPUT_AFTER_READY_TIMEOUT_MS;
	const arrived = () => wait.observed().startsWith(wait.expectedPrefix);
	let settlement: RpcBashSettlement | undefined;
	wait.execution.then(
		(response) => {
			settlement = { response };
		},
		(error: Error) => {
			settlement = { error };
		},
	);
	let readyAt: number | undefined;
	while (!arrived()) {
		if (settlement) {
			throw new RpcBashOutputWaitError(
				"settled-before-output",
				wait.id,
				wait.expectedPrefix,
				wait.observed(),
				settlement,
			);
		}
		if (readyAt === undefined && wait.isReady?.()) readyAt = clock.now();
		if (readyAt !== undefined && clock.now() - readyAt >= afterReadyTimeoutMs) {
			await clock.drainPendingIo();
			if (arrived()) return;
			throw new RpcBashOutputWaitError(
				"silent-after-ready",
				wait.id,
				wait.expectedPrefix,
				wait.observed(),
				settlement,
			);
		}
		await clock.sleep(RPC_OUTPUT_POLL_INTERVAL_MS);
	}
}
