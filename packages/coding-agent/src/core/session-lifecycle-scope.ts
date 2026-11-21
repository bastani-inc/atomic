import type { ModelsRefreshOptions } from "@bastani/atomic-ai";
import type { ExtensionBindings } from "./agent-session-types.js";
import { asyncScope } from "./async-scope.ts";

/** Internal factory context; never inherited by independently admitted child sessions. */
export interface SessionLifecycleContext {
	scope: object;
	bindings?: ExtensionBindings;
	claimed?: boolean;
	/** Runtime retains lineage if an unpublished replacement rolls back. */
	replacement?: boolean;
	/** Only the SDK's own cache-only refresh can authorize recovery on its later first prompt. */
	catalogRestore?: ModelsRefreshOptions;
	catalogRuntime?: object;
	copilotObservation?: "restoring" | "absent" | "confirmed";
}
export const sessionLifecycleCreation = asyncScope<SessionLifecycleContext>();
export const sessionLifecycleScopes = new WeakMap<object, object>();

/** Communication transports may be borrowed; only runtime/loader identities own a lifetime. */
export function lifecycleScopeForOwner(owner: object): object {
	let scope = sessionLifecycleScopes.get(owner);
	if (!scope) {
		scope = sessionLifecycleCreation.getStore()?.scope ?? {};
		sessionLifecycleScopes.set(owner, scope);
	}
	return scope;
}
