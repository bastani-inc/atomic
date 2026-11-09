import { AsyncLocalStorage } from "node:async_hooks";

/** A value bound to the current async context, as with an AsyncLocalStorage of its own. */
export interface AsyncScope<T> {
	getStore(): T | undefined;
	run<R>(value: T, operation: () => R): R;
}

// The built host and raw builtin TypeScript can share scopes, so they share the one store the scopes live in.
const storeKey = Symbol.for("atomic.async-scopes.v1");
const host = globalThis as typeof globalThis & { [storeKey]?: AsyncLocalStorage<ReadonlyMap<object, unknown>> };
host[storeKey] ??= new AsyncLocalStorage<ReadonlyMap<object, unknown>>();
const scopes = host[storeKey];

/**
 * A scope for something made per session or per call. On Node before 24 an AsyncLocalStorage that has run stays
 * registered for the rest of the process, and every promise and async resource made later visits each one; one per
 * session would be kept after the session is gone and slow the process down with every session. Every scope therefore
 * lives in one shared store, keyed by the scope.
 */
export function asyncScope<T>(): AsyncScope<T> {
	const scope: AsyncScope<T> = {
		getStore: () => scopes.getStore()?.get(scope) as T | undefined,
		run: (value, operation) => scopes.run(new Map(scopes.getStore()).set(scope, value), operation),
	};
	return scope;
}
