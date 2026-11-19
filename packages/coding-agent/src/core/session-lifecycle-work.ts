import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionStore } from "./storage/session/types.js";
import { withWindowsDirectorySecurityOwner } from "./tools/windows-directory-security.ts";

export const ownedSessionStores = new WeakMap<object, SessionStore>();
export const ownedSessionPermits = new WeakMap<object, () => Promise<void>>();
export const ownedSessionManagerStores = new WeakMap<object, SessionStore>();

const currentWork = new AsyncLocalStorage<ReadonlySet<Promise<void>>>();
const reloads = new WeakMap<object, Promise<void>>();
const reloadCleanupFailures = new WeakMap<object, unknown[]>();
const reloadRetirements = new WeakMap<object, Set<Promise<void>>>();
const work = new WeakMap<object, Set<Promise<void>>>();
const lifetimes = new WeakMap<object, AbortController>();
const sessionWorkOwners = new WeakSet<object>();

export function registerSessionWorkOwner(owner: object): void {
	sessionWorkOwners.add(owner);
}
const quitSignals = new WeakMap<object, AbortController>();
export const sessionGenerationClosing = new WeakSet<object>();
const retiringWork = new WeakMap<object, Set<Promise<void>>>();
const retirementChanges = new WeakMap<object, { promise: Promise<void>; resolve: () => void }>();

// Register before runtime publication can wait. Retain membership until the
// invoking work settles, not merely until its replacement promise returns.
export function registerSessionRetirement(session: object): void {
	const ancestors = currentWork.getStore();
	const retiring = retiringWork.get(session) ?? new Set<Promise<void>>();
	retiringWork.set(session, retiring);
	for (const item of work.get(session) ?? []) {
		if (!ancestors?.has(item) || retiring.has(item)) continue;
		retiring.add(item);
		void item.then(() => retiring.delete(item));
	}
	retirementChanges.get(session)?.resolve();
	retirementChanges.delete(session);
}

function retirementChanged(session: object): Promise<void> {
	let change = retirementChanges.get(session);
	if (!change) {
		let resolve!: () => void;
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		change = { promise, resolve };
		retirementChanges.set(session, change);
	}
	return change.promise;
}

export function assertSessionOpen(session: { _disposed: boolean }): void {
	if (session._disposed || sessionGenerationClosing.has(session))
		throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
}

export function hasSessionReload(session: object): boolean {
	return reloads.has(session);
}

export function trackSessionReload(session: object, operation: () => Promise<void>): Promise<void> {
	const result = operation();
	reloads.set(session, result);
	const forget = () => {
		if (reloads.get(session) === result) reloads.delete(session);
	};
	void result.then(forget, (error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ShutdownFailed") {
			const failures = reloadCleanupFailures.get(session) ?? [];
			failures.push(error);
			reloadCleanupFailures.set(session, failures);
		}
		forget();
	});
	return result;
}

/** Self-reload may return to its caller, but never relinquishes that generation's cleanup. */
export function retireSessionReloadGeneration(session: object, cleanup: () => Promise<void>): Promise<void> {
	const ancestors = currentWork.getStore();
	const callers = [...(work.get(session) ?? [])].filter((item) => ancestors?.has(item));
	if (!callers.length) return cleanup();
	const pending = reloadRetirements.get(session) ?? new Set<Promise<void>>();
	reloadRetirements.set(session, pending);
	const receipt = Promise.all(callers)
		.then(cleanup)
		.catch((error: unknown) => {
			const failures = reloadCleanupFailures.get(session) ?? [];
			failures.push(error);
			reloadCleanupFailures.set(session, failures);
		});
	pending.add(receipt);
	void receipt.then(() => pending.delete(receipt));
	return Promise.resolve();
}

export async function drainSessionReload(session: object): Promise<void> {
	// Preparation errors belong to the reload caller; failed rollback also belongs to final cleanup.
	await reloads.get(session)?.catch(() => {});
	const pending = reloadRetirements.get(session);
	while (pending?.size) await Promise.all(pending);
	const failures = reloadCleanupFailures.get(session);
	if (failures?.length)
		throw Object.assign(new AggregateError(failures, "Reload cleanup failed"), { code: "ShutdownFailed" });
}

export function sessionLifetime(session: object): AbortSignal {
	let controller = lifetimes.get(session);
	if (!controller) {
		controller = new AbortController();
		lifetimes.set(session, controller);
	}
	return controller.signal;
}

export function trackSessionWork<T>(session: object, operation: () => Promise<T>): Promise<T> {
	const pending = work.get(session) ?? new Set<Promise<void>>();
	work.set(session, pending);
	let finish!: () => void;
	const settled = new Promise<void>((resolve) => {
		finish = resolve;
	});
	pending.add(settled);
	const ancestors = new Set(currentWork.getStore());
	ancestors.add(settled);
	const result = currentWork.run(ancestors, () =>
		withWindowsDirectorySecurityOwner(sessionLifetime(session), async () => operation(), {
			inherit: !sessionWorkOwners.has(session),
		}),
	);
	void result
		.finally(() => {
			pending.delete(settled);
			finish();
		})
		.catch(() => {});
	return result;
}

export function isSessionQuitting(session: object): boolean {
	return quitSignals.get(session)?.signal.aborted === true;
}

export function sessionQuitSignal(session: object): AbortSignal {
	let controller = quitSignals.get(session);
	if (!controller) {
		controller = new AbortController();
		quitSignals.set(session, controller);
	}
	return controller.signal;
}

export function abortSessionWork(session: object, quitting = false): void {
	sessionLifetime(session);
	lifetimes.get(session)!.abort();
	if (quitting) {
		sessionQuitSignal(session);
		quitSignals.get(session)!.abort();
	}
}

export function hasCallingSessionWork(session: object): boolean {
	const ancestors = currentWork.getStore();
	return [...(work.get(session) ?? [])].some((item) => ancestors?.has(item));
}

// A /reload command may be admitted inside a prompt. It drains peers, not its own caller.
// Terminal disposal never excludes callers: callback settlement remains part of cleanup.
export async function drainSessionWork(
	session: object,
	excludeCallingWork = false,
	excludeRetiringWork = false,
): Promise<void> {
	const ancestors = excludeCallingWork ? currentWork.getStore() : undefined;
	while (true) {
		const changed = excludeRetiringWork ? retirementChanged(session) : undefined;
		const pending = [...(work.get(session) ?? [])].filter(
			(item) => !ancestors?.has(item) && !(excludeRetiringWork && retiringWork.get(session)?.has(item)),
		);
		if (!pending.length) return;
		if (changed) await Promise.race([Promise.all(pending), changed]);
		else await Promise.all(pending);
	}
}

/**
 * How long closing a session may take. Work that observes its cancellation settles at once, and a storage append that
 * waits for a busy database's write lock settles within that lock wait (30 s by default); a shutdown still waiting after
 * this is stuck, such as on a storage append that never settles, and stops waiting rather than hang.
 */
export const SESSION_WORK_DRAIN_MS = 60_000;

/** Thrown, as a cause of `ShutdownFailed`, when shutdown stopped waiting at a step that did not finish. */
export class SessionWorkUnsettledError extends Error {
	readonly code = "SessionWorkUnsettled";
	/** The shutdown step that was still running, such as "abort" or "active work". */
	readonly step: string;
	/** Session operations still running when shutdown stopped waiting. */
	readonly pending: number;
	readonly waitedMs: number;

	constructor(step: string, pending: number, waitedMs: number) {
		const running =
			pending === 0 ? "" : `, with ${pending} session ${pending === 1 ? "operation" : "operations"} still running`;
		super(
			`Session shutdown stopped waiting after ${waitedMs / 1000} s at "${step}"${running}; the rest of the cleanup continues without waiting for it`,
		);
		this.name = "SessionWorkUnsettledError";
		this.step = step;
		this.pending = pending;
		this.waitedMs = waitedMs;
	}
}

/** How many of a session's operations are still running. */
export function pendingSessionWork(session: object): number {
	return work.get(session)?.size ?? 0;
}

/**
 * A bound on a whole shutdown, started before its first step: `run` waits for each step only until the bound, and once
 * it is reached returns `SessionWorkUnsettledError` for the step that was still running, once; every later step still
 * starts, in order, and runs without being waited for.
 */
export function shutdownDeadline(
	session: object,
	limitMs = SESSION_WORK_DRAIN_MS,
): {
	run(step: string, operation: () => void | Promise<void>): Promise<SessionWorkUnsettledError | undefined>;
	clear(): void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(() => resolve("expired"), limitMs);
	});
	let reported = false;
	return {
		async run(step, operation) {
			const running = (async () => operation())();
			if ((await Promise.race([running.then(() => "done" as const), expired])) === "done") return undefined;
			void running.catch(() => {});
			if (reported) return undefined;
			reported = true;
			return new SessionWorkUnsettledError(step, pendingSessionWork(session), limitMs);
		},
		clear: () => clearTimeout(timer),
	};
}

/** `drainSessionWork` for disposal: waits at most `limitMs`, then throws `SessionWorkUnsettledError`. */
export async function drainSessionWorkWithin(session: object, limitMs = SESSION_WORK_DRAIN_MS): Promise<void> {
	const deadline = shutdownDeadline(session, limitMs);
	try {
		const unsettled = await deadline.run("active work", () => drainSessionWork(session));
		if (unsettled) throw unsettled;
	} finally {
		deadline.clear();
	}
}

export function renewSessionWork(session: object): void {
	lifetimes.delete(session);
	quitSignals.delete(session);
}
