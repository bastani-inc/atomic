import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	availableStoreDurableBackend,
	requireStoreDurableBackend,
	workflowStoreBackend,
	workflowStoreBackendOverride,
} from "../../packages/workflows/src/durable/store-backend.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";

/** Inspect the current test session's own store, not the factory's process cache. */
export const currentStoreBackend = () => requireStoreDurableBackend(currentWorkflowStore());
export const availableCurrentStoreBackend = () => availableStoreDurableBackend(currentWorkflowStore());

/** Explicitly configure the singleton store used by isolated reader fixtures. */
export function configureCurrentTestStoreBackend(backend: DurableWorkflowBackend | undefined): void {
	setDurableBackend(backend);
	configureTestStoreBackend(currentWorkflowStore(), backend);
}

export function configureTestStoreBackend(store: Store, backend: DurableWorkflowBackend | undefined): void {
	(store as Store & { [workflowStoreBackend]?: DurableWorkflowBackend })[workflowStoreBackend] = backend;
	(store as Store & { [workflowStoreBackendOverride]?: DurableWorkflowBackend })[workflowStoreBackendOverride] =
		backend;
}
