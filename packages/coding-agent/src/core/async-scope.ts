import { AsyncLocalStorage } from "node:async_hooks";

/** A value bound to the current async context, as with an AsyncLocalStorage of its own. */
export interface AsyncScope<T> {
	getStore(): T | undefined;
	run<R>(value: T, operation: () => R): R;
}

// The built host and raw builtin TypeScript can share scopes, so they share the one store the scopes live in.
const storeKey = Symbol.for("atomic.async-scopes.v1");
const host = globalThis as typeof globalThis & {
	[storeKey]?: AsyncLocalStorage<ReadonlyMap<object, unknown> | undefined>;
};
host[storeKey] ??= new AsyncLocalStorage<ReadonlyMap<object, unknown> | undefined>();
const scopes = host[storeKey];

/**
 * A value bound to the current async context. Atomic's scopes all live in one shared store, keyed by the scope. On
 * Node before 24, AsyncLocalStorage runs on promise hooks: every store that has run stays in a process-wide list, and
 * every promise and async resource made later visits each store in it, so each store makes every await in the process
 * slower, and a store made per session or per call would also stay after its session is gone. With one shared store
 * the list holds one entry however many scopes, sessions and calls have run.
 *
 * Like an AsyncLocalStorage of its own, a scope's `run` with the value the scope already has does not enter a new
 * value: it runs `operation` with the shared store's current one, so a scope that only ever runs with its current
 * value (for example `undefined` outside any scope) never turns promise hooks on.
 */
export function asyncScope<T>(): AsyncScope<T> {
	const scope: AsyncScope<T> = {
		getStore: () => scopes.getStore()?.get(scope) as T | undefined,
		run: (value, operation) => {
			const outer = scopes.getStore();
			return scopes.run(Object.is(outer?.get(scope), value) ? outer : new Map(outer).set(scope, value), operation);
		},
	};
	return scope;
}
