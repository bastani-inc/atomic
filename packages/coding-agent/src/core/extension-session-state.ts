/**
 * Extension state that must survive extension module re-evaluation.
 *
 * `/reload` loads every file extension through jiti with `moduleCache: false`
 * and a generation-busted specifier (see extensions/loader-virtual-modules.ts),
 * so an extension's module graph — including every module-scoped singleton —
 * is evaluated afresh while the host process, the session, and any work the
 * extension started keep running. An extension whose state must outlive its
 * own module graph (the workflows run store keeps executing runs across
 * `/reload`) registers that state here and re-binds to it on every load.
 *
 * The scope callers hold is `pi.events`. As with the workflow lifecycle
 * bridge, each per-extension facade resolves to the one shared bus that
 * outlives every load generation, so successive generations of one session
 * find each other while two in-process sessions with distinct buses stay
 * isolated. Entries live exactly as long as the bus they serve.
 */

import { canonicalEventBusFor } from "./event-bus.ts";

const extensionStateByScope = new WeakMap<object, Map<string, object>>();

/**
 * Resolve (or create) one keyed state object for a host session scope.
 *
 * The first caller for a `(scope, key)` pair registers `create()`'s result;
 * every later caller — typically the same extension after a reload evaluated
 * its modules again — receives that same object. Keys should carry a version
 * suffix (for example `"atomic-workflows/run-store@1"`) so an extension whose
 * state shape changes can decline to adopt an incompatible predecessor.
 */
export function sessionScopedExtensionState<T extends object>(scope: object, key: string, create: () => T): T {
	const canonicalScope = canonicalEventBusFor(scope);
	let container = extensionStateByScope.get(canonicalScope);
	if (container === undefined) {
		container = new Map();
		extensionStateByScope.set(canonicalScope, container);
	}
	const existing = container.get(key);
	if (existing !== undefined) return existing as T;
	const created = create();
	container.set(key, created);
	return created;
}
