import { createSessionScopedSingleton } from "./session-scoped-singleton.js";
import { createStoreContext } from "./store-internal.js";
import { createPromptStoreMethods } from "./store-prompt-methods.js";
import type { Store } from "./store-public-types.js";
import { createRunStoreMethods } from "./store-run-methods.js";
import { createStageStoreMethods } from "./store-stage-methods.js";
import { createToolNodeStoreMethods } from "./store-tool-node-methods.js";

export function createStore(): Store {
	const context = createStoreContext();
	return {
		...createRunStoreMethods(context),
		...createStageStoreMethods(context),
		...createToolNodeStoreMethods(context),
		...createPromptStoreMethods(context),
	};
}

const storeSingleton = createSessionScopedSingleton<Store>("atomic-workflows/run-store@1", createStore);

/**
 * Session-scoped singleton store. A facade, so runs recorded before `/reload`
 * re-evaluated this module stay visible afterwards; see
 * session-scoped-singleton.ts.
 */
export const store: Store = storeSingleton.facade;

/** Re-bind the singleton store to the host session scope (`pi.events`). */
export function adoptWorkflowRunStore(scope: object): void {
	storeSingleton.adopt(scope);
}
