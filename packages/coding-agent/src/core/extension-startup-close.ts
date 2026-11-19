import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionBindings } from "./agent-session-types.ts";
import { hostInputError } from "./extensions/host-input.ts";

// The eager rebind owns one set of bindings. A decorator can start a second bind on the same session.
export interface InitialBind {
	mode: object;
	active: boolean;
	session?: object;
}
export const initialBindScope = new AsyncLocalStorage<WeakRef<InitialBind>>();
const bindingOwners = new WeakMap<ExtensionBindings, WeakRef<InitialBind>>();
export function initialBindings(mode: object, session: object, bindings: ExtensionBindings): ExtensionBindings {
	const scope = initialBindScope.getStore();
	const bind = scope?.deref();
	if (scope && bind?.active && bind.mode === mode && bind.session === undefined) {
		bind.session = session;
		bindingOwners.set(bindings, scope);
	}
	return bindings;
}

export function claimInteractiveBind(session: object, bindings: ExtensionBindings): boolean {
	const bind = bindingOwners.get(bindings)?.deref();
	return bind?.active === true && bind.session === session && bindingOwners.delete(bindings);
}

export const closingSessions = new WeakSet<object>();
const owners = new WeakMap<Error, WeakRef<object>>();
export function bindClosed(
	session: object,
	interactive: boolean,
	error: Error = hostInputError("SessionClosed"),
): Error {
	if (interactive && closingSessions.has(session)) owners.set(error, new WeakRef(session));
	return error;
}

export function isOwnBindClose(session: object, error: unknown): boolean {
	return owners.get(error as Error)?.deref() === session;
}
