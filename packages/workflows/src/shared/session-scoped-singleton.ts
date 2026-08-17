import { sessionScopedExtensionState } from "@bastani/atomic";

/**
 * Stable facade over a run-scoped singleton that can re-bind to host
 * session-scoped state after `/reload` re-evaluates the module graph.
 *
 * Local state seeds at most one unseen scope; later unseen scopes start fresh.
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
	let localClaimed = false;
	const createForScope = (): T => {
		if (localClaimed) return createLocal();
		localClaimed = true;
		return local;
	};

	const current = (): T => instance;

	const adopt = (scope: object): T => {
		instance = sessionScopedExtensionState(scope, key, createForScope);
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
