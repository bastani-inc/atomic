import { createHook, type HookCallbacks } from "node:async_hooks";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@bastani/pi-ai";
import { vi } from "vitest";
import { chatRouter } from "./model-routing.js";
import { decisionMessage } from "./structured-output.js";

export type RoutingProviderBehavior =
	| { kind: "answer"; latencyMs: number }
	/** Never answers. `honorsAbort: false` models a transport that ignores its abort signal. */
	| { kind: "hang"; honorsAbort: boolean }
	| { kind: "rate-limit"; retryAfterMs?: number }
	/** Answers after `latencyMs`, but rejects with a 429 any call arriving while `capacity` calls are in flight. */
	| { kind: "capacity"; capacity: number; latencyMs: number };

/**
 * Router/reader provider with controllable latency, hangs and 429s. Answers pick the
 * `other` model when offered, so a routed stage is distinguishable from one that
 * degraded to the current chat model.
 */
export class RoutingProvider {
	calls = 0;
	inflight = 0;
	peakInflight = 0;
	aborted = 0;
	rateLimited = 0;

	constructor(public behavior: RoutingProviderBehavior) {}

	readonly streamSimple = (model: Model<Api>, context: Context, options?: { signal?: AbortSignal }) => {
		const behavior = this.behavior;
		this.calls += 1;
		this.inflight += 1;
		this.peakInflight = Math.max(this.peakInflight, this.inflight);
		const stream = createAssistantMessageEventStream();
		let done = false;
		const finish = (message: AssistantMessage): void => {
			if (done) return;
			done = true;
			this.inflight -= 1;
			if (message.stopReason === "aborted") this.aborted += 1;
			stream.push(
				message.stopReason === "error" || message.stopReason === "aborted"
					? { type: "error", reason: message.stopReason, error: message }
					: { type: "done", reason: message.stopReason as "toolUse", message },
			);
		};
		const failure = (stopReason: "error" | "aborted", extra: Partial<AssistantMessage>): AssistantMessage => ({
			...decisionMessage(),
			content: [],
			stopReason,
			...extra,
		});
		if (behavior.kind === "hang" && !behavior.honorsAbort) return stream;
		options?.signal?.addEventListener("abort", () => finish(failure("aborted", {})), { once: true });
		const answer = (latencyMs: number): void => {
			setTimeout(() => {
				void chatRouter((offered) => offered.find((id) => id.endsWith("/other")) ?? offered[0]!)(model, context)
					.result()
					.then(finish);
			}, latencyMs);
		};
		const rateLimit = (retryAfterMs?: number): void => {
			this.rateLimited += 1;
			finish(
				failure("error", {
					errorMessage: "429 Too Many Requests: rate limit exceeded",
					...(retryAfterMs === undefined ? {} : { retryAfterMs }),
				}),
			);
		};
		if (behavior.kind === "answer") answer(behavior.latencyMs);
		else if (behavior.kind === "rate-limit") rateLimit(behavior.retryAfterMs);
		else if (behavior.kind === "capacity") {
			if (this.inflight > behavior.capacity) rateLimit();
			else answer(behavior.latencyMs);
		}
		return stream;
	};
}

const realSetImmediate = setImmediate;
const VIRTUAL_BUDGET_MS = 30 * 60_000;
/** Real time with no timer to advance to and no change in real work after which an unsettled operation counts as hung. */
const HUNG_IDLE_MS = 5_000;

/**
 * Async resource types that count as real work in flight: file-system requests (including the
 * request that closes a `fs/promises` file handle, which Node 22 and later issue after every
 * `readFile`) and the real macrotasks `setImmediate` schedules. Each ends in exactly one callback, which is how the ledger
 * knows it is done. Other native resources are left out on purpose: a crypto job run
 * synchronously (`randomUUID`, `randomBytes`) or a stream write that finishes at once opens a
 * resource that never gets a callback, so it would read as work in flight forever.
 */
const REAL_WORK_TYPE = /^(?:FSREQ|FILEHANDLECLOSEREQ$|Immediate$)/;

/**
 * Real asynchronous work in flight: file-system requests (the evals read, credential-file probes) and
 * real macrotasks the code under test scheduled. Virtual time may advance only while none is,
 * because only then is every continuation of the operation waiting on a fake timer rather than
 * on this machine. A turn of the real event loop cannot show that: a read that outlives the turn
 * on a loaded machine would otherwise let a deadline timer fire under a healthy operation.
 * Work of another kind, such as a network request, must not be part of the operation; the routing
 * tests keep the provider and credential store in memory.
 */
class RealWork {
	private readonly pending = new Map<number, string>();
	private ownTurn = false;
	/** Counts every start and completion, so a waiter can tell real work that moves from real work that is stuck. */
	changes = 0;
	private readonly hook = createHook({
		init: (id: number, type: string) => {
			if (this.ownTurn || !REAL_WORK_TYPE.test(type)) return;
			this.pending.set(id, type);
			this.changes += 1;
		},
		before: (id: number) => this.finish(id),
		destroy: (id: number) => this.finish(id),
		// Promises are neither real work nor tracked here; Node versions that predate the option still ignore them.
		trackPromises: false,
	} as HookCallbacks);

	get inFlight(): readonly string[] {
		return [...this.pending.values()];
	}

	enable(): void {
		this.hook.enable();
	}

	disable(): void {
		this.hook.disable();
		this.pending.clear();
	}

	/** One real macrotask turn. The turn's own immediate is not work to wait for. */
	turn(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.ownTurn = true;
			realSetImmediate(resolve);
			this.ownTurn = false;
		});
	}

	private finish(id: number): void {
		if (this.pending.delete(id)) this.changes += 1;
	}
}

const realWork = new RealWork();

/**
 * Switches the test to virtual time and starts tracking real work. Register it with
 * `beforeEach`: the returned cleanup restores real timers after each test.
 */
export function useVirtualTime(): () => void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	realWork.enable();
	return () => {
		realWork.disable();
		vi.useRealTimers();
	};
}

/**
 * Drive virtual time to the next pending timer, but only when no tracked real work is in flight,
 * until `operation` settles. Elapsed virtual time therefore depends on the timers the code under
 * test arms and never on how long this machine takes to do real I/O: a deadline cannot fire under
 * an operation that is still reading a file.
 */
export async function settleVirtually<T>(operation: Promise<T>): Promise<void> {
	const started = Date.now();
	let settled = false;
	void operation.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	let seenChanges = realWork.changes;
	let quietSince = performance.now();
	while (!settled) {
		await realWork.turn();
		if (settled) break;
		if (Date.now() - started > VIRTUAL_BUDGET_MS)
			throw new Error("operation did not settle within the virtual-time budget");
		const now = performance.now();
		if (realWork.changes !== seenChanges) {
			seenChanges = realWork.changes;
			quietSince = now;
		}
		const inFlight = realWork.inFlight;
		if (inFlight.length > 0) {
			if (now - quietSince > HUNG_IDLE_MS)
				throw new Error(`operation is stuck on real work that never completes: ${inFlight.join(", ")}`);
			continue;
		}
		if (vi.getTimerCount() === 0) {
			if (now - quietSince > HUNG_IDLE_MS) throw new Error("operation is hung: no timer is pending to end it");
			continue;
		}
		quietSince = now;
		await vi.advanceTimersToNextTimerAsync();
	}
}

/** Outcome of an operation together with the virtual time at which it settled. */
export type Settlement<T> = { ok: true; value: T; at: number } | { ok: false; error: Error; at: number };

export function recordSettlement<T>(operation: Promise<T>): Promise<Settlement<T>> {
	return operation.then(
		(value) => ({ ok: true as const, value, at: Date.now() }),
		(error: Error) => ({ ok: false as const, error, at: Date.now() }),
	);
}
