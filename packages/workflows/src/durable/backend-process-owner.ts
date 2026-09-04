/** Process-global owner for durable-backend initialization across bundle reloads. */

import type { DurableWorkflowBackend } from "./backend.js";

export type DurabilityWarningSink = (message: string) => void;

const DURABLE_BACKEND_PROCESS_OWNER_KEY = Symbol.for("atomic-workflows/durable-backend-process-owner@1");

export interface DurableBackendProcessOwner {
	readonly version: 1;
	injectedBackend: DurableWorkflowBackend | undefined;
	initializedBackend: DurableWorkflowBackend | undefined;
	initializing: Promise<DurableWorkflowBackend> | undefined;
	warningSink: DurabilityWarningSink | undefined;
	warningReported: boolean;
}

function emptyOwner(): DurableBackendProcessOwner {
	return {
		version: 1,
		injectedBackend: undefined,
		initializedBackend: undefined,
		initializing: undefined,
		warningSink: undefined,
		warningReported: false,
	};
}

function ownerBag(): Record<symbol, DurableBackendProcessOwner | undefined> {
	return globalThis as typeof globalThis & Record<symbol, DurableBackendProcessOwner | undefined>;
}

export function getDurableBackendProcessOwner(): DurableBackendProcessOwner {
	const bag = ownerBag();
	const existing = bag[DURABLE_BACKEND_PROCESS_OWNER_KEY];
	if (existing !== undefined && existing.version === 1) return existing;
	const created = emptyOwner();
	bag[DURABLE_BACKEND_PROCESS_OWNER_KEY] = created;
	return created;
}

export function resetDurableBackendProcessOwner(): void {
	const owner = getDurableBackendProcessOwner();
	owner.injectedBackend = undefined;
	owner.initializedBackend = undefined;
	owner.initializing = undefined;
	owner.warningSink = undefined;
	owner.warningReported = false;
}
