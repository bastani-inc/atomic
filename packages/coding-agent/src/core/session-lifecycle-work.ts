import { AsyncLocalStorage } from "node:async_hooks";

const currentWork = new AsyncLocalStorage<ReadonlySet<Promise<void>>>();
const reloads = new WeakMap<object, Promise<void>>();
const reloadCleanupFailures = new WeakMap<object, unknown[]>();
const reloadRetirements = new WeakMap<object, Set<Promise<void>>>();
const work = new WeakMap<object, Set<Promise<void>>>();
const lifetimes = new WeakMap<object, AbortController>();
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
	const result = currentWork.run(ancestors, async () => operation());
	void result
		.finally(() => {
			pending.delete(settled);
			finish();
		})
		.catch(() => {});
	return result;
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

export function renewSessionWork(session: object): void {
	lifetimes.delete(session);
	quitSignals.delete(session);
}
