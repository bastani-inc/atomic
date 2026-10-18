/** Process-global owner for durable-backend initialization across bundle reloads. */

import type { DurableWorkflowBackend } from "./backend.js";

const DURABLE_BACKEND_PROCESS_OWNER_KEY = Symbol.for("atomic-workflows/durable-backend-process-owner@1");

export interface SelectedDurableBackend {
	readonly ready: Promise<DurableWorkflowBackend>;
	close?: () => Promise<void>;
	/** Sessions holding this backend; it is closed when the last of them releases it. */
	readonly holders: Set<object>;
	/** Set once a caller that holds nothing selects it: such a backend lives until process exit or reset. */
	pinned: boolean;
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

export async function releaseDurableBackendsHeldBy(holder: object): Promise<void> {
	const selected = getDurableBackendProcessOwner().selectedBackends;
	if (selected === undefined) return;
	const released: SelectedDurableBackend[] = [];
	for (const [key, entry] of selected) {
		if (!entry.holders.delete(holder) || entry.holders.size > 0 || entry.pinned) continue;
		selected.delete(key);
		released.push(entry);
	}
	await Promise.all(
		released.map((entry) =>
			entry.ready.then(
				() => entry.close?.(),
				() => undefined,
			),
		),
	);
}
