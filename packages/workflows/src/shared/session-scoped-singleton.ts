import { sessionScopedExtensionState } from "@bastani/atomic";

const PRE_ADOPTION_STATES_KEY = Symbol.for("atomic-workflows/session-scoped-singleton-pre-adoption@1");

interface PreAdoptionState<T extends object> {
	readonly local: T;
	localClaimed: boolean;
}

interface ProcessPreAdoptionStates {
	readonly version: 1;
	readonly byKey: Map<string, PreAdoptionState<object>>;
}

function processBag(): Record<symbol, ProcessPreAdoptionStates | undefined> {
	return globalThis as typeof globalThis & Record<symbol, ProcessPreAdoptionStates | undefined>;
}

function preAdoptionState<T extends object>(key: string, local: T): PreAdoptionState<T> {
	const bag = processBag();
	let states = bag[PRE_ADOPTION_STATES_KEY];
	if (states === undefined || states.version !== 1) {
		states = { version: 1, byKey: new Map() };
		bag[PRE_ADOPTION_STATES_KEY] = states;
	}
	const existing = states.byKey.get(key);
	if (existing !== undefined) return existing as PreAdoptionState<T>;
	const created: PreAdoptionState<T> = { local, localClaimed: false };
	states.byKey.set(key, created as PreAdoptionState<object>);
	return created;
}

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
	const preAdoption = preAdoptionState(key, local);
	let instance = local;
	const createForScope = (): T => {
		if (preAdoption.localClaimed) return createLocal();
		preAdoption.localClaimed = true;
		return preAdoption.local;
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
