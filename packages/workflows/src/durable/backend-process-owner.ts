/** Process-global owner for durable-backend initialization across bundle reloads. */

import type { DurableWorkflowBackend } from "./backend.js";

const DURABLE_BACKEND_PROCESS_OWNER_KEY = Symbol.for("atomic-workflows/durable-backend-process-owner@1");

export interface SelectedDurableBackend {
	readonly ready: Promise<DurableWorkflowBackend>;
	close?: () => Promise<void>;
}

export interface DurableBackendProcessOwner {
	readonly version: 1;
	injectedBackend: DurableWorkflowBackend | undefined;
	selectedBackends?: Map<string | object, SelectedDurableBackend>;
}

function emptyOwner(): DurableBackendProcessOwner {
	return {
		version: 1,
		injectedBackend: undefined,
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
	for (const selected of owner.selectedBackends?.values() ?? []) {
		void (selected.close?.() ?? selected.ready.then(() => selected.close?.())).catch((error: Error) => {
			console.error(error);
			process.exitCode = 1;
		});
	}
	owner.selectedBackends = undefined;
	owner.injectedBackend = undefined;
}
