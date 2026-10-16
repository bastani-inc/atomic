import type { Store } from "../shared/store-public-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { JournalError } from "./journal/types.js";
import { availableRunDurableBackend } from "./run-owner-backend.js";

/** Stored on the owning store, including across module reloads; never a process-wide selection. */
export const workflowStoreBackend = Symbol.for("atomic-workflows/store-journal-backend@1");

/** Explicit construction-time override; default journal bindings never replace it. */
export const workflowStoreBackendOverride = Symbol.for("atomic-workflows/store-journal-override@1");

type BackendStore = Store & { [workflowStoreBackend]?: DurableWorkflowBackend };
type BackendOverrideStore = Store & { [workflowStoreBackendOverride]?: DurableWorkflowBackend };

export function availableStoreDurableBackendOverride(store: Store): DurableWorkflowBackend | undefined {
	return (store as BackendOverrideStore)[workflowStoreBackendOverride];
}

export class DurableBackendNotInitializedError extends JournalError {
	constructor() {
		super("Workflow journal has not been initialized");
		this.name = "DurableBackendNotInitializedError";
	}
}

export function bindStoreDurableBackend(store: Store, backend: DurableWorkflowBackend): void {
	(store as BackendStore)[workflowStoreBackend] = backend;
}

export function availableStoreDurableBackend(
	store: Store | undefined,
	runId?: string,
): DurableWorkflowBackend | undefined {
	return (
		(store !== undefined && runId !== undefined ? availableRunDurableBackend(store.runs(), runId) : undefined) ??
		(store as BackendStore | undefined)?.[workflowStoreBackend]
	);
}

export function requireStoreDurableBackend(store: Store | undefined, runId?: string): DurableWorkflowBackend {
	const backend = availableStoreDurableBackend(store, runId);
	if (backend === undefined) throw new DurableBackendNotInitializedError();
	return backend;
}
