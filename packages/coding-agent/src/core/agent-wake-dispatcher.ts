import { AgentRehydrateError, AgentReleaseConfigError } from "./agent-rehydrate-errors.ts";
import type { DetachedToolResult } from "./agent-session-detached-tools.ts";
import { WakeDeadlines } from "./agent-wake-deadlines.ts";
import { MAX_TOOL_DETACHMENT_AFTER_MS } from "./tool-detachment-errors.ts";

/** What woke an agent. Every kind arrives the same way, as a wake on the agent's key. */
export type AgentWakeKind = "intercom" | "tool-result" | "task-completion" | "timer";

/** One message for a released (or idle) agent. `id` makes delivery exactly once while the wake is pending. */
export interface AgentWake {
	readonly id: string;
	readonly kind: AgentWakeKind;
	/** The result of a detached tool call, for `tool-result` wakes. */
	readonly toolResult?: DetachedToolResult;
}

/**
 * Handles the wakes of one namespace: rehydrates the agent `wakeKey` names from storage and gives it `wakes`, in the
 * order they arrived. Called for one key at a time, so an agent is never rehydrated twice at once.
 */
export type AgentWakeHandler = (wakeKey: string, wakes: readonly AgentWake[]) => Promise<void>;

/** The dispatcher's resident state, counted by tests and the idle-agents benchmark. */
export interface AgentWakeDispatcherStats {
	/** Keys with a queued or running wake. A released agent with nothing pending has none. */
	readonly keys: number;
	readonly queued: number;
	readonly running: number;
	/** Timed wakes waiting for their time. */
	readonly scheduled: number;
	/** 1 while the one shared timer is armed, otherwise 0. */
	readonly timers: number;
	readonly handlers: number;
	/** Namespaces with a handler, or with handling still running after theirs was removed. */
	readonly namespaces: number;
	/** Failed deliveries nobody was waiting on (timed wakes), counted so they are never lost silently. */
	readonly unobservedFailures: number;
}

/** Timer functions, injectable so tests drive time by counting instead of waiting. */
export interface AgentWakeClock {
	now(): number;
	setTimer(callback: () => void, delayMs: number): AgentWakeTimer;
	clearTimer(timer: AgentWakeTimer): void;
}

export interface AgentWakeTimer {
	unref?(): unknown;
}

/** How a namespace's handler runs. */
export interface AgentWakeHandlerOptions {
	/**
	 * How many keys of the namespace are handled at once; more wait their turn first in, first out, and their wakes
	 * keep batching meanwhile. Unlimited when unset.
	 */
	readonly maxConcurrent?: number;
	/**
	 * Take the namespace over from a handler already registered for it, as a newer generation of the same owner does
	 * (an extension reload starts the new generation before the old one shuts down). The older handler's remover then
	 * does nothing. Without it a second handler is refused with `wake-handler-conflict`.
	 */
	readonly replace?: boolean;
}

export type AgentWakeFailureListener = (error: AgentRehydrateError) => void;

/** Options for a dispatcher; the defaults use the system clock and report nothing beyond `lastFailure`. */
export interface AgentWakeDispatcherOptions {
	readonly clock?: AgentWakeClock;
	/** Called with each failed delivery that nobody was waiting on, such as a timed wake whose handler failed. */
	readonly onUnobservedFailure?: AgentWakeFailureListener;
}

interface Pending {
	readonly wake: AgentWake;
	readonly settled: Promise<void>;
	resolve(): void;
	reject(error: AgentRehydrateError): void;
}

interface KeyState {
	readonly queue: Pending[];
	running: Pending[];
}

const systemClock: AgentWakeClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** The namespace of a wake key: the text before its first `:`, or the whole key. */
export function wakeKeyNamespace(wakeKey: string): string {
	const separator = wakeKey.indexOf(":");
	return separator < 0 ? wakeKey : wakeKey.slice(0, separator);
}

/**
 * The one owner of waiting agents. Everything that wakes an agent (an Intercom message or ask, a tool or child
 * result, an answer, a resume, a timer) is delivered here as a wake on the agent's key. Wakes queue first in, first
 * out per key; a key is handled by one call at a time, which takes every wake queued so far; a key with nothing
 * queued or running has no entry. Timed wakes share one timer, armed for the earliest of them.
 */
interface NamespaceSlots {
	maxConcurrent: number;
	active: number;
	readonly waiting: Array<() => void>;
}

export class AgentWakeDispatcher {
	private readonly handlers = new Map<string, AgentWakeHandler>();
	private readonly slots = new Map<string, NamespaceSlots>();
	private readonly keys = new Map<string, KeyState>();
	private readonly deadlines = new WakeDeadlines();
	private timer: AgentWakeTimer | undefined;
	private timerAt = Number.POSITIVE_INFINITY;
	private readonly clock: AgentWakeClock;
	private readonly failureListeners = new Set<AgentWakeFailureListener>();
	private readonly keyIdleWaiters = new Map<string, Array<() => void>>();
	private readonly idleWaiters: Array<() => void> = [];
	private unobservedFailures = 0;
	private _lastFailure: AgentRehydrateError | undefined;

	constructor(options: AgentWakeDispatcherOptions = {}) {
		this.clock = options.clock ?? systemClock;
		if (options.onUnobservedFailure !== undefined) this.failureListeners.add(options.onUnobservedFailure);
	}

	onUnobservedFailure(listener: AgentWakeFailureListener): () => void {
		this.failureListeners.add(listener);
		return () => {
			this.failureListeners.delete(listener);
		};
	}

	whenIdle(wakeKey?: string): Promise<void> {
		if (wakeKey === undefined ? this.keys.size === 0 : !this.keys.has(wakeKey)) return Promise.resolve();
		return new Promise<void>((resolve) => {
			if (wakeKey === undefined) {
				this.idleWaiters.push(resolve);
				return;
			}
			const waiters = this.keyIdleWaiters.get(wakeKey);
			if (waiters === undefined) this.keyIdleWaiters.set(wakeKey, [resolve]);
			else waiters.push(resolve);
		});
	}

	/** The last failed delivery nobody was waiting on. */
	get lastFailure(): AgentRehydrateError | undefined {
		return this._lastFailure;
	}

	/** Handle every wake whose key is in `namespace`. Returns the function that removes the handler. */
	handle(namespace: string, handler: AgentWakeHandler, options: AgentWakeHandlerOptions = {}): () => void {
		const maxConcurrent = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
		if (!(maxConcurrent >= 1 && (Number.isInteger(maxConcurrent) || maxConcurrent === Number.POSITIVE_INFINITY)))
			throw new AgentReleaseConfigError({ source: "sdk", field: "maxConcurrent", value: String(maxConcurrent) });
		if (this.handlers.has(namespace) && options.replace !== true)
			throw new AgentRehydrateError("wake-handler-conflict", { namespace });
		this.handlers.set(namespace, handler);
		const slots = this.slots.get(namespace);
		if (slots === undefined) this.slots.set(namespace, { maxConcurrent, active: 0, waiting: [] });
		else {
			slots.maxConcurrent = maxConcurrent;
			this.grantWaiting(slots);
		}
		return () => {
			if (this.handlers.get(namespace) !== handler) return;
			this.handlers.delete(namespace);
			this.forgetIdleSlots(namespace);
		};
	}

	/** A namespace with no handler and nothing running keeps no slot record. */
	private forgetIdleSlots(namespace: string): void {
		const slots = this.slots.get(namespace);
		if (slots !== undefined && slots.active === 0 && !this.handlers.has(namespace)) this.slots.delete(namespace);
	}

	/**
	 * Queue `wake` for `wakeKey`. Settles once the handler took it and returned, or rejects with a `wake-failed`
	 * {@link AgentRehydrateError} whose cause is the handler's failure. A wake whose id is already queued or running
	 * for the key is the same delivery: it is not queued again and settles with the first.
	 */
	deliver(wakeKey: string, wake: AgentWake): Promise<void> {
		const state = this.keys.get(wakeKey);
		const duplicate = state && [...state.queue, ...state.running].find((pending) => pending.wake.id === wake.id);
		if (duplicate !== undefined) return duplicate.settled;
		const pending = createPending(wake);
		if (state !== undefined) state.queue.push(pending);
		else {
			const started: KeyState = { queue: [pending], running: [] };
			this.keys.set(wakeKey, started);
			void this.drain(wakeKey, started);
		}
		return pending.settled;
	}

	/**
	 * Deliver `wake` to `wakeKey` once `delayMs` has passed. A scheduled wake with the same key and id is replaced. Wakes
	 * due at the same time are delivered in the order they were scheduled. Costs O(log n) in the wakes waiting.
	 */
	schedule(wakeKey: string, wake: AgentWake, delayMs: number): void {
		this.deadlines.set(wakeKey, wake, this.clock.now() + (Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0));
		this.arm();
	}

	/** Drop a scheduled wake. Returns whether one was scheduled. */
	cancel(wakeKey: string, wakeId: string): boolean {
		if (!this.deadlines.delete(wakeKey, wakeId)) return false;
		this.arm();
		return true;
	}

	/** Comparisons between deadlines so far: counted by tests to show timed wakes cost O(log n) each. */
	get deadlineComparisons(): number {
		return this.deadlines.comparisons;
	}

	stats(): AgentWakeDispatcherStats {
		let queued = 0;
		let running = 0;
		for (const state of this.keys.values()) {
			queued += state.queue.length;
			running += state.running.length;
		}
		return {
			keys: this.keys.size,
			queued,
			running,
			scheduled: this.deadlines.size,
			timers: this.timer === undefined ? 0 : 1,
			handlers: this.handlers.size,
			namespaces: this.slots.size,
			unobservedFailures: this.unobservedFailures,
		};
	}

	/**
	 * Take one of the namespace's handler slots: at once when one is free, otherwise a promise that settles when the
	 * slot is handed over, first in, first out. Either way the result is the function that frees the slot.
	 */
	private acquire(namespace: string): (() => void) | Promise<() => void> {
		const slots = this.slots.get(namespace);
		if (slots === undefined) return () => {};
		const free = () => {
			slots.active -= 1;
			this.grantWaiting(slots);
			this.forgetIdleSlots(namespace);
		};
		if (slots.active < slots.maxConcurrent) {
			slots.active += 1;
			return free;
		}
		return new Promise<() => void>((resolve) => slots.waiting.push(() => resolve(free)));
	}

	/** Hand free slots to waiting keys, first in, first out, while the namespace's current limit allows. */
	private grantWaiting(slots: NamespaceSlots): void {
		while (slots.active < slots.maxConcurrent) {
			const next = slots.waiting.shift();
			if (next === undefined) return;
			slots.active += 1;
			next();
		}
	}

	private async drain(wakeKey: string, state: KeyState): Promise<void> {
		const namespace = wakeKeyNamespace(wakeKey);
		while (state.queue.length > 0) {
			const slot = this.acquire(namespace);
			const free = typeof slot === "function" ? slot : await slot;
			const batch = state.queue.splice(0);
			state.running = batch;
			const handler = this.handlers.get(namespace);
			try {
				if (handler === undefined) throw new AgentRehydrateError("no-wake-handler", { wakeKey, namespace });
				await handler(
					wakeKey,
					batch.map((pending) => pending.wake),
				);
				for (const pending of batch) pending.resolve();
			} catch (cause) {
				const failure =
					cause instanceof AgentRehydrateError && cause.code === "no-wake-handler"
						? cause
						: new AgentRehydrateError("wake-failed", { wakeKey, wakes: batch.length }, { cause });
				for (const pending of batch) pending.reject(failure);
			} finally {
				state.running = [];
				free();
			}
		}
		this.keys.delete(wakeKey);
		this.settleIdleWaiters(wakeKey);
	}

	private settleIdleWaiters(wakeKey: string): void {
		const waiters = this.keyIdleWaiters.get(wakeKey) ?? [];
		this.keyIdleWaiters.delete(wakeKey);
		for (const resolve of waiters) resolve();
		if (this.keys.size === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
	}

	private arm(): void {
		const next = this.deadlines.earliest();
		if (next === this.timerAt) return;
		if (this.timer !== undefined) this.clock.clearTimer(this.timer);
		this.timer = undefined;
		this.timerAt = next;
		if (next === Number.POSITIVE_INFINITY) return;
		this.timer = this.clock.setTimer(
			() => this.fire(),
			Math.min(MAX_TOOL_DETACHMENT_AFTER_MS, Math.max(0, next - this.clock.now())),
		);
		this.timer.unref?.();
	}

	private fire(): void {
		this.timer = undefined;
		this.timerAt = Number.POSITIVE_INFINITY;
		const due = this.deadlines.takeDue(this.clock.now());
		this.arm();
		for (const entry of due)
			void this.deliver(entry.wakeKey, entry.wake).catch((error: AgentRehydrateError) =>
				this.reportUnobservedFailure(error),
			);
	}

	/** Count and report a failed delivery nobody was waiting on, such as one a tool's own completion made. */
	reportUnobservedFailure(error: AgentRehydrateError): void {
		this.unobservedFailures += 1;
		this._lastFailure = error;
		for (const listener of [...this.failureListeners]) listener(error);
	}
}

function createPending(wake: AgentWake): Pending {
	let resolve!: () => void;
	let reject!: (error: AgentRehydrateError) => void;
	const settled = new Promise<void>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { wake, settled, resolve, reject };
}

let processDispatcher: AgentWakeDispatcher | undefined;

/** The process's one wake dispatcher, shared by SDK sessions released when idle and by released subagents. */
export function agentWakeDispatcher(): AgentWakeDispatcher {
	processDispatcher ??= new AgentWakeDispatcher();
	return processDispatcher;
}
