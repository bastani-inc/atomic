import { type DurableWorkflowBackend, InMemoryDurableBackend } from "./backend.js";
import { getDurableBackendProcessOwner, resetDurableBackendProcessOwner } from "./backend-process-owner.js";
import { JournalDurableBackend } from "./journal/journal-backend.js";
import { JournalError } from "./journal/types.js";

export class DurableBackendNotInitializedError extends JournalError {
	constructor() {
		super("Workflow journal has not been initialized");
		this.name = "DurableBackendNotInitializedError";
	}
}

export function getDurableBackend(): DurableWorkflowBackend {
	const backend = getAvailableDurableBackend();
	if (backend === undefined) throw new DurableBackendNotInitializedError();
	return backend;
}

export function getAvailableDurableBackend(): DurableWorkflowBackend | undefined {
	const owner = getDurableBackendProcessOwner();
	return owner.injectedBackend ?? owner.initializedBackend;
}

export function setDurableBackend(backend: DurableWorkflowBackend | undefined): void {
	if (backend === undefined) {
		resetDurableBackendProcessOwner();
		return;
	}
	getDurableBackendProcessOwner().injectedBackend = backend;
}

export function createInMemoryTestBackend(): InMemoryDurableBackend {
	return new InMemoryDurableBackend();
}

export async function initializeDurableBackend(): Promise<DurableWorkflowBackend> {
	const owner = getDurableBackendProcessOwner();
	if (owner.injectedBackend !== undefined) return owner.injectedBackend;
	if (owner.initializedBackend !== undefined) return owner.initializedBackend;
	owner.initializing ??= JournalDurableBackend.open()
		.then((backend) => {
			backend.closeOnProcessExit();
			owner.closeInitializedBackend = () => backend.close();
			owner.initializedBackend = backend;
			return backend;
		})
		.finally(() => {
			owner.initializing = undefined;
		});
	return await owner.initializing;
}
