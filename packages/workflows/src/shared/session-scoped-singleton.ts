import { sessionScopedExtensionState } from "@bastani/atomic";

/**
 * Stable facade over a run-scoped singleton that can re-bind to host
 * session-scoped state after `/reload` re-evaluates the module graph.
 *
 * Importers keep the same Proxy. Without {@link SessionScopedSingleton.adopt}
 * the facade resolves to a module-local instance, matching the previous
 * `export const x = create()` behavior.
 */
export interface SessionScopedSingleton<T extends object> {
	readonly facade: T;
	readonly adopt: (scope: object) => T;
	readonly current: () => T;
}

export function createSessionScopedSingleton<T extends object>(
	key: string,
	createLocal: () => T,
): SessionScopedSingleton<T> {
	const local = createLocal();
	let instance = local;

	const current = (): T => instance;

	const adopt = (scope: object): T => {
		instance = sessionScopedExtensionState(scope, key, current);
		return instance;
	};

	const facade = new Proxy(local, {
		get(_target, prop) {
			const live = instance;
			const value = Reflect.get(live, prop, live);
			if (typeof value === "function") {
				return value.bind(live);
			}
			return value;
		},
		has(_target, prop) {
			return Reflect.has(instance, prop);
		},
	});

	return { facade, adopt, current };
}
