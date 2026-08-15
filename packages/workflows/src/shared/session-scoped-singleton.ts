/**
 * Module singletons that survive `/reload`.
 *
 * The host loads this package's extension through jiti with
 * `moduleCache: false` and a generation-busted specifier, so `/reload`
 * evaluates the whole module graph again while the session — and any
 * in-flight workflow run the previous graph is still executing — keeps
 * running. A plain `export const x = create()` therefore loses every run
 * record, stage handle, and cancellation controller exactly when the
 * replacement session needs them (#2247's W8).
 *
 * Every run-scoped singleton is instead exported as a stable facade over an
 * instance the extension factory re-binds ("adopts") to the host session
 * scope: the first load registers its instance with the host, and each later
 * load of the same session finds and reuses it, so a run started before
 * `/reload` stays observable and controllable after it. Without adoption
 * (unit tests, embedded SDK use, hosts without an event bus) the facade
 * resolves to a module-local instance — the previous behavior, unchanged.
 */

import { sessionScopedExtensionState } from "@bastani/atomic";

export interface SessionScopedSingleton<T extends object> {
	/** Stable facade every importer holds; forwards to the current instance. */
	readonly facade: T;
	/** Re-bind the facade to the instance registered for this session scope. */
	adopt(scope: object): void;
	/** The instance behind the facade right now. */
	current(): T;
}

/**
 * Create a facade-backed singleton.
 *
 * `key` must be versioned (`"atomic-workflows/<name>@1"`): adoption hands a
 * later load generation the instance an earlier generation created, so a
 * change to the instance's shape must bump the key rather than let new code
 * drive an incompatible predecessor object.
 */
export function createSessionScopedSingleton<T extends object>(
	key: string,
	createLocal: () => T,
): SessionScopedSingleton<T> {
	let local: T | undefined;
	let adopted: T | undefined;
	const current = (): T => {
		if (adopted !== undefined) return adopted;
		local ??= createLocal();
		return local;
	};
	const facade = new Proxy({} as T, {
		get(_target, property): unknown {
			const instance = current();
			const value = Reflect.get(instance, property) as unknown;
			// Bind so class-based instances (`this._runs` etc.) keep their receiver
			// when invoked through the facade.
			return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(instance) : value;
		},
		has(_target, property): boolean {
			return property in current();
		},
	});
	return {
		facade,
		current,
		adopt(scope): void {
			adopted = sessionScopedExtensionState(scope, key, current);
		},
	};
}
