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
/** Real time with no pending timer after which an unsettled operation counts as hung. */
const HUNG_IDLE_MS = 5_000;

export function useVirtualTime(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

/**
 * Drive virtual time to the next pending timer whenever real work is idle until `operation`
 * settles, so elapsed virtual time depends on the timers the code under test arms and
 * never on how long this machine takes to do real I/O.
 */
export async function settleVirtually<T>(operation: Promise<T>): Promise<void> {
	const started = Date.now();
	let settled = false;
	let idleSince: number | undefined;
	void operation.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	while (!settled) {
		await new Promise<void>((resolve) => realSetImmediate(resolve));
		if (settled) break;
		if (Date.now() - started > VIRTUAL_BUDGET_MS)
			throw new Error("operation did not settle within the virtual-time budget");
		if (vi.getTimerCount() === 0) {
			idleSince ??= performance.now();
			if (performance.now() - idleSince > HUNG_IDLE_MS)
				throw new Error("operation is hung: no timer is pending to end it");
			continue;
		}
		idleSince = undefined;
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
