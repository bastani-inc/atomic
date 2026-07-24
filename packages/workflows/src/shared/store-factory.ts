import type { Store } from "./store-public-types.js";
import { createStoreContext } from "./store-internal.js";
import { createPromptStoreMethods } from "./store-prompt-methods.js";
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

export const store: Store = createStore();
