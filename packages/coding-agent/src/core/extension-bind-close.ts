import { asyncScope } from "./async-scope.ts";

const claimed = Symbol("claimed initial bind");

/** Only the initial host bind may acknowledge its own close error. Neither public dispatch needs an extra argument. */
export interface InitialExtensionBind {
	session: object;
	bindings?: object | typeof claimed;
	isQuitting(): boolean;
	cancelled?: Error;
}

// Extension callbacks can start long-lived work. It must not keep the initial host alive through the async context.
export const initialExtensionBind = asyncScope<WeakRef<InitialExtensionBind>>();
const discoveryBind = asyncScope<{ runner: WeakRef<object>; bind: WeakRef<InitialExtensionBind> }>();

export function initialExtensionBindings<T extends object>(session: object, bindings: T): T {
	const bind = initialExtensionBind.getStore()?.deref();
	if (bind && bind.session === session) bind.bindings ??= bindings;
	return bindings;
}

export function extensionBindFor(session: object, bindings: object): InitialExtensionBind | undefined {
	const bind = initialExtensionBind.getStore()?.deref();
	if (!bind || bind.session !== session || bind.bindings !== bindings) return undefined;
	bind.bindings = claimed;
	return bind;
}

export function recordExtensionBindClose(bind: InitialExtensionBind | undefined, error: Error): Error {
	if (bind?.isQuitting()) bind.cancelled = error;
	return error;
}

export function dispatchBindDiscovery<T>(runner: object, bind: InitialExtensionBind | undefined, dispatch: () => T): T {
	return bind ? discoveryBind.run({ runner: new WeakRef(runner), bind: new WeakRef(bind) }, dispatch) : dispatch();
}

export function discoveryBindFor(runner: object): InitialExtensionBind | undefined {
	const discovery = discoveryBind.getStore();
	return discovery?.runner.deref() === runner ? discovery.bind.deref() : undefined;
}
