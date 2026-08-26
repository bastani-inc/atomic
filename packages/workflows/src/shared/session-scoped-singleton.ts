import { sessionScopedExtensionState } from "@bastani/atomic";

/**
 * Shared across duplicate copies of this module after a host scope is adopted.
 * Windows' resolver can evaluate the same singleton file twice: one copy
 * registers, the other adopts. A module-local `instance` then splits them.
 *
 * Construction records this copy's local in the process bag if the key is new,
 * but `current()` / `facade` stay module-local until `adopt`. That keeps
 * no-scope evaluations isolated. The first `adopt` claims the recorded local
 * (the first constructor's populated object) into the host scope.
 */
const SHARED_STATES_KEY = Symbol.for("atomic-workflows/session-scoped-singleton-pre-adoption@1");

interface SharedSingletonState<T extends object> {
	local: T;
	instance: T | undefined;
	localClaimed: boolean;
}

interface ProcessSingletonStates {
	readonly version: 1;
	readonly byKey: Map<string, SharedSingletonState<object>>;
}

function processBag(): Record<symbol, ProcessSingletonStates | undefined> {
	return globalThis as typeof globalThis & Record<symbol, ProcessSingletonStates | undefined>;
}

function recordLocal<T extends object>(key: string, local: T): SharedSingletonState<T> {
	const bag = processBag();
	let states = bag[SHARED_STATES_KEY];
	if (states === undefined || states.version !== 1) {
		states = { version: 1, byKey: new Map() };
		bag[SHARED_STATES_KEY] = states;
	}
	const existing = states.byKey.get(key) as SharedSingletonState<T> | undefined;
	if (existing !== undefined) return existing;
	const created: SharedSingletonState<T> = { local, instance: undefined, localClaimed: false };
	states.byKey.set(key, created as SharedSingletonState<object>);
	return created;
}

/** Drop every shared slot so unit tests stay isolated. */
export function resetSessionScopedSingletonPreAdoptionForTests(): void {
	delete processBag()[SHARED_STATES_KEY];
}

/**
 * Stable facade over a run-scoped singleton that can re-bind to host
 * session-scoped state after `/reload` re-evaluates the module graph.
 *
 * Local state seeds at most one unseen scope; later unseen scopes start fresh.
 * After the first adopt, every module copy for the same key reads one instance.
 */
export interface SessionScopedAdoptOptions<T extends object> {
	/**
	 * Keep the currently bound instance when returning to an existing scope.
	 * Never applies to a scope being seen for the first time.
	 */
	readonly preserveCurrentWhenTargetExists?: (current: T, target: T) => boolean;
}

export interface SessionScopedAdoptResult<T extends object> {
	readonly instance: T;
	readonly preservedCurrent: boolean;
}

export interface SessionScopedSingleton<T extends object> {
	readonly facade: T;
	readonly adopt: (scope: object, options?: SessionScopedAdoptOptions<T>) => T;
	readonly adoptWithResult: (scope: object, options?: SessionScopedAdoptOptions<T>) => SessionScopedAdoptResult<T>;
	readonly current: () => T;
}

export function createSessionScopedSingleton<T extends object>(
	key: string,
	createLocal: () => T,
): SessionScopedSingleton<T> {
	const local = createLocal();
	const shared = recordLocal(key, local);
	let instance = local;

	const live = (): T => shared.instance ?? instance;

	const current = (): T => live();

	const adoptWithResult = (scope: object, options?: SessionScopedAdoptOptions<T>): SessionScopedAdoptResult<T> => {
		const current = live();
		let targetCreated = false;
		const target = sessionScopedExtensionState(scope, key, () => {
			targetCreated = true;
			if (shared.localClaimed) return createLocal();
			shared.localClaimed = true;
			return shared.local;
		});
		const preservedCurrent =
			!targetCreated && target !== current && options?.preserveCurrentWhenTargetExists?.(current, target) === true;
		shared.instance = preservedCurrent ? current : target;
		instance = shared.instance;
		return { instance: shared.instance, preservedCurrent };
	};

	const adopt = (scope: object, options?: SessionScopedAdoptOptions<T>): T => adoptWithResult(scope, options).instance;

	const facade = new Proxy(local, {
		get(_target, prop) {
			const value = Reflect.get(live(), prop, live());
			if (typeof value === "function") {
				return value.bind(live());
			}
			return value;
		},
		has(_target, prop) {
			return Reflect.has(live(), prop);
		},
	});

	return { facade, adopt, adoptWithResult, current };
}
