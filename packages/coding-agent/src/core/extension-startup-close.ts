import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionBindings } from "./agent-session-types.js";

/** One eager interactive start. Independent SDK binds (even on this session) have no claim on its outcome. */
export interface InitialBind {
	mode: object;
	active: boolean;
	session?: object;
	binding?: Promise<void>;
	closed?: Error;
	deliveredWhileOpen?: object;
	joinedStart?: object;
	cancelled?: boolean;
}
export const initialBindScope = new AsyncLocalStorage<WeakRef<InitialBind>>();
const bindingOwners = new WeakMap<ExtensionBindings, WeakRef<InitialBind>>();
export function registerInitialBindings(
	mode: object,
	session: object,
	bindings: ExtensionBindings,
): InitialBind | undefined {
	const scope = initialBindScope.getStore();
	const bind = scope?.deref();
	if (scope && bind?.active && bind.mode === mode && bind.session === undefined) {
		bind.session = session;
		bindingOwners.set(bindings, scope);
		return bind;
	}
	return undefined;
}

export function claimInteractiveBind(session: object, bindings: ExtensionBindings): InitialBind | undefined {
	const bind = bindingOwners.get(bindings)?.deref();
	return bind?.active && bind.session === session && bindingOwners.delete(bindings) ? bind : undefined;
}

// A second startup event may join the first start, or reach its cached rejection after closure.
// A cached error does not keep its runner alive, nor does the runner retain a replaced rollback error.
const closedStarts = new WeakMap<object, WeakRef<Error>>();
export function recordClosedStart(runner: object, bind: InitialBind | undefined, error: unknown): void {
	if (bind?.closed !== undefined && bind.closed === error) closedStarts.set(runner, new WeakRef(bind.closed));
}
export function cancelInitialBinding(bind: InitialBind | undefined, binding: Promise<void>, error: unknown): boolean {
	if (!bind || bind.binding !== binding || error === undefined) return false;
	if (bind.closed !== error && (!bind.joinedStart || closedStarts.get(bind.joinedStart)?.deref() !== error))
		return false;
	bind.cancelled = true;
	return true;
}
