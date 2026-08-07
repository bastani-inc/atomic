/**
 * Watch a value settle without changing what the caller receives.
 *
 * `Promise.resolve(result).finally(cleanup)` looked equivalent and was not: it
 * returns a *derived* promise, so a wrapped `ctx.ui.select()` no longer handed
 * back the host's own promise object. Anything comparing promise identity —
 * a host that caches or cancels by the object it returned, a test double, a
 * bridge keyed on it — silently stopped matching, which is exactly the kind of
 * change wrapping must not make.
 */

/** Cleanup to run once, whichever way the value settles. */
export type SettlementCleanup = () => void;

/**
 * Call the intrinsic `then` on an arbitrary object.
 *
 * Routed through `Reflect.apply` so the intrinsic can be applied to a bare
 * object — a cross-realm promise is not assignable to this realm's `Promise<T>`
 * — without naming a wide type here.
 */
function callThen(value: object, onFulfilled?: () => void, onRejected?: () => void): Promise<void> {
	return Reflect.apply(Promise.prototype.then, value, [onFulfilled, onRejected]);
}

/**
 * Whether `value` is a real promise, in this realm or another.
 *
 * `Promise.prototype.then.call` recognizes a promise from a `vm` context and
 * throws on a plain object without touching its `then` — so this answers the
 * question without triggering a getter, and without `instanceof`, which fails
 * across realms.
 */
function isRealPromise(value: object): boolean {
	try {
		// The probe itself produces a derived promise. It must be consumed: for a
		// value that is already rejected, leaving it alone turns a perfectly
		// handled caller rejection into an unhandled one.
		const probe = callThen(value);
		void probe.catch(() => {});
		return true;
	} catch {
		return false;
	}
}

function observe(promise: object, cleanup: SettlementCleanup): void {
	const observer = callThen(
		promise,
		() => cleanup(),
		() => cleanup(),
	);
	// Swallowed so an observer rejection cannot surface as a second unhandled
	// rejection. The caller's promise and its reason are untouched.
	void observer.catch(() => {});
}

/**
 * Run `cleanup` when `result` settles, and return what the caller should get.
 *
 * A real promise is returned **unchanged**, with settlement watched on a
 * separate branch. A plain thenable is adopted exactly once and the adopted
 * promise is returned: observing the raw thenable while also returning it would
 * call a non-idempotent `then` twice, and returning it unobserved would strand
 * the cleanup. A synchronous value releases immediately.
 */
export function observeSettlement<T>(result: T, cleanup: SettlementCleanup): T {
	if (result === null || (typeof result !== "object" && typeof result !== "function")) {
		cleanup();
		return result;
	}

	const candidate: object = result;
	if (isRealPromise(candidate)) {
		observe(candidate, cleanup);
		return result;
	}

	if (typeof Reflect.get(candidate, "then") !== "function") {
		cleanup();
		return result;
	}

	const adopted = Promise.resolve(candidate);
	observe(adopted, cleanup);
	return adopted as T;
}
