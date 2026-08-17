/**
 * Process-global owner for DBOS lifecycle state and registered wrappers.
 *
 * `@dbos-inc/dbos-sdk` keeps a process-global operation registry that #1958
 * leaves alive across session replacement. The workflows bundle is re-evaluated
 * on `/reload` and the other process-preserving boundaries, so module-local
 * variables restart at `uninitialized` and `configureDbosDurableBackend` would
 * register `atomicWorkflowHandle` / `atomicWorkflowCheckpoint` a second time.
 * The second registration throws and the replacement session degrades to
 * `InMemoryDurableBackend` (#2022).
 *
 * Session scope is the wrong lifetime: the SDK registry is process-global, so
 * a session-scoped owner would re-register per session and reproduce the bug.
 * This slot lives on `globalThis` under `Symbol.for` so every load generation
 * of the bundle — and a second copy of the module reached through a different
 * specifier — shares one owner.
 *
 * The `@1` suffix is the shape version. Bump it when these fields change so a
 * new generation declines an incompatible predecessor instead of reading it.
 */

import type { WorkflowSerializableValue } from "../shared/types.js";
import type { ConfiguredDbosDurability } from "./dbos-backend.js";
import type { DbosDurabilityError, DbosLifecycleState } from "./dbos-lifecycle.js";

export const DBOS_PROCESS_OWNER_KEY = Symbol.for("atomic-workflows/dbos-process-owner@1");

export interface DbosRegisteredWrappers {
	readonly mainWorkflow: (
		name: string,
		inputs: Record<string, WorkflowSerializableValue>,
	) => Promise<WorkflowSerializableValue>;
	readonly checkpointWorkflow: (
		workflowId: string,
		stepName: string,
		output: WorkflowSerializableValue,
	) => Promise<WorkflowSerializableValue>;
}

export interface DbosProcessOwner {
	readonly version: 1;
	state: DbosLifecycleState;
	configured: Promise<ConfiguredDbosDurability> | undefined;
	active: ConfiguredDbosDurability | undefined;
	launchPromise: Promise<void> | undefined;
	shutdownPromise: Promise<void> | undefined;
	failure: DbosDurabilityError | undefined;
	wrappers: DbosRegisteredWrappers | undefined;
}

function emptyOwner(): DbosProcessOwner {
	return {
		version: 1,
		state: "uninitialized",
		configured: undefined,
		active: undefined,
		launchPromise: undefined,
		shutdownPromise: undefined,
		failure: undefined,
		wrappers: undefined,
	};
}

function ownerBag(): Record<symbol, DbosProcessOwner | undefined> {
	return globalThis as typeof globalThis & Record<symbol, DbosProcessOwner | undefined>;
}

export function getDbosProcessOwner(): DbosProcessOwner {
	const bag = ownerBag();
	const existing = bag[DBOS_PROCESS_OWNER_KEY];
	if (existing !== undefined && existing.version === 1) return existing;
	const created = emptyOwner();
	bag[DBOS_PROCESS_OWNER_KEY] = created;
	return created;
}

/** Reset every field on the process-global slot. Used by durability tests. */
export function resetDbosProcessOwner(): void {
	const owner = getDbosProcessOwner();
	owner.state = "uninitialized";
	owner.configured = undefined;
	owner.active = undefined;
	owner.launchPromise = undefined;
	owner.shutdownPromise = undefined;
	owner.failure = undefined;
	owner.wrappers = undefined;
}
