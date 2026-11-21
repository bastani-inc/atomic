import { AsyncLocalStorage } from "node:async_hooks";

/** A value bound to the current async context, as with an AsyncLocalStorage of its own. */
export interface AsyncScope<T> {
	getStore(): T | undefined;
	run<R>(value: T, operation: () => R): R;
}

// The host keeps all of its scopes in this one store (Atomic's core/async-scope.ts); these scopes join it.
const storeKey = Symbol.for("atomic.async-scopes.v1");
const host = globalThis as typeof globalThis & {
	[storeKey]?: AsyncLocalStorage<ReadonlyMap<object, unknown> | undefined>;
};
host[storeKey] ??= new AsyncLocalStorage<ReadonlyMap<object, unknown> | undefined>();
const scopes = host[storeKey];

/**
 * A scope in the host's shared store. On Node before 24 every AsyncLocalStorage that has run makes every await in the
 * process slower, so scopes share one store rather than adding their own. Like AsyncLocalStorage, `run` with the value
 * the scope already has does not enter a new value.
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
