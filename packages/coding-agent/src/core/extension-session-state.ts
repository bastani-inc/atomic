import { canonicalEventBusFor } from "./event-bus.ts";

/**
 * Process-global store for session state, shared by duplicate host-module
 * instances. The `@1` suffix versions the stored WeakMap shape.
 */
export const EXTENSION_SESSION_STATE_KEY = Symbol.for("atomic-coding-agent/extension-session-state@1");

type SessionStateByScope = WeakMap<object, Map<string, object>>;

function sessionStateBag(): Record<symbol, SessionStateByScope | undefined> {
	return globalThis as typeof globalThis & Record<symbol, SessionStateByScope | undefined>;
}

function getSessionStateByScope(): SessionStateByScope {
	const bag = sessionStateBag();
	const existing = bag[EXTENSION_SESSION_STATE_KEY];
	if (existing !== undefined) return existing;
	const created = new WeakMap<object, Map<string, object>>();
	bag[EXTENSION_SESSION_STATE_KEY] = created;
	return created;
}

/**
 * Return the session-scoped state registered for `(scope, key)`, creating it
 * with `create` on first use.
 *
 * `scope` must be the extension's `pi.events` facade or the session EventBus
 * itself. It is resolved to its canonical EventBus first (see
 * {@link canonicalEventBusFor}), so every load generation of one session — each
 * holding a distinct `events` facade over the same bus — re-binds to the same
 * state, while two in-process sessions with distinct buses stay isolated.
 * Passing the bus itself works too: buses are fixed points of the resolution.
 *
 * The key namespace is session-wide, not per-extension. Two extensions that
 * pass the same key on the same session receive the same object; the later
 * factory is not called. Callers must prefix keys with a stable extension
 * identity and a version suffix (for example `"my-extension:state:v1"`).
 * Bumping the suffix declines an incompatible predecessor instead of reusing
 * it under a new shape.
 *
 * Entries live exactly as long as the bus they serve. They do not persist
 * across process restart; use `appendEntry` for durable session data.
 */
export function sessionScopedExtensionState<T extends object>(scope: object, key: string, create: () => T): T {
	const canonicalScope = canonicalEventBusFor(scope);
	const stateByScope = getSessionStateByScope();
	let entries = stateByScope.get(canonicalScope);
	if (!entries) {
		entries = new Map<string, object>();
		stateByScope.set(canonicalScope, entries);
	}
	const existing = entries.get(key);
	if (existing !== undefined) return existing as T;
	const created = create();
	entries.set(key, created);
	return created;
}
