import type { Store } from "../shared/store-public-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { JournalError } from "./journal/types.js";

/** Stored on the owning store, including across module reloads; never a process-wide selection. */
export const workflowStoreBackend = Symbol.for("atomic-workflows/store-journal-backend@1");

type BackendStore = Store & { [workflowStoreBackend]?: DurableWorkflowBackend };

export class DurableBackendNotInitializedError extends JournalError {
	constructor() {
		super("Workflow journal has not been initialized");
		this.name = "DurableBackendNotInitializedError";
	}
}

export function bindStoreDurableBackend(store: Store, backend: DurableWorkflowBackend): void {
	(store as BackendStore)[workflowStoreBackend] = backend;
}

export function availableStoreDurableBackend(store: Store | undefined): DurableWorkflowBackend | undefined {
	return (store as BackendStore | undefined)?.[workflowStoreBackend];
}

export function requireStoreDurableBackend(store: Store | undefined): DurableWorkflowBackend {
	const backend = availableStoreDurableBackend(store);
	if (backend === undefined) throw new DurableBackendNotInitializedError();
	return backend;
}
