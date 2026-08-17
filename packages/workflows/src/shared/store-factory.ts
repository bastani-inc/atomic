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

const SESSION_KEY = "workflows:store:v1";
const singleton = createSessionScopedSingleton(SESSION_KEY, createStore);

export const store: Store = singleton.facade;

export function adoptStore(scope: object): Store {
	return singleton.adopt(scope);
}
