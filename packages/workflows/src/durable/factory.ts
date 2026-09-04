/** DBOS-first durable backend factory with a non-durable last-resort fallback. */

import { type DurableWorkflowBackend, InMemoryDurableBackend } from "./backend.js";
import {
	type DurabilityWarningSink,
	getDurableBackendProcessOwner,
	resetDurableBackendProcessOwner,
} from "./backend-process-owner.js";
import {
	DbosNotReadyError,
	DbosShutdownError,
	dbosLifecycleState,
	getReadyDbosBackend,
	getReadyDbosBackendSync,
} from "./dbos-lifecycle.js";
import { classifyDbosDurabilityFailure, readDbosFailureDetail } from "./dbos-registration-diagnostics.js";

export type { DurabilityWarningSink } from "./backend-process-owner.js";

/**
 * A memoized backend is only reusable while its lifecycle generation is
 * healthy. The in-memory degraded backend has no external lifecycle; a
 * persistent (DBOS) backend is usable only while the process-scoped DBOS
 * executor is still `ready` — never after shutdown.
 */
function isMemoizedBackendUsable(backend: DurableWorkflowBackend): boolean {
	return !backend.persistent || dbosLifecycleState() === "ready";
}

/** Return the injected test backend or the process-wide initialized backend. */
export function getDurableBackend(): DurableWorkflowBackend {
	const owner = getDurableBackendProcessOwner();
	const memoized =
		owner.initializedBackend !== undefined && isMemoizedBackendUsable(owner.initializedBackend)
			? owner.initializedBackend
			: undefined;
	const backend = owner.injectedBackend ?? memoized ?? getReadyDbosBackendSync();
	if (backend === undefined) throw new DbosNotReadyError();
	return backend;
}

/** Internal injection seam. Production initialization uses DBOS. */
export function setDurableBackend(backend: DurableWorkflowBackend | undefined): void {
	if (backend === undefined) {
		resetDurableBackendProcessOwner();
		return;
	}
	getDurableBackendProcessOwner().injectedBackend = backend;
}

/** Create an isolated current-interface backend for tests only. */
export function createInMemoryTestBackend(): InMemoryDurableBackend {
	return new InMemoryDurableBackend();
}

/**
 * Configure, register, launch, and install the DBOS backend.
 *
 * When no durable backend can be provisioned (no `DBOS_SYSTEM_DATABASE_URL`,
 * embedded Postgres unavailable — e.g. running as root without an
 * unprivileged account — and no Docker), workflows degrade to a process-local
 * in-memory backend with a loud warning instead of refusing to run at all.
 * Non-durable runs execute normally but do not survive the process:
 * `/workflow resume` after exit has nothing to restore.
 */
export async function initializeDurableBackend(warningSink?: DurabilityWarningSink): Promise<DurableWorkflowBackend> {
	const owner = getDurableBackendProcessOwner();
	if (warningSink !== undefined) owner.warningSink = warningSink;
	if (owner.injectedBackend !== undefined) return owner.injectedBackend;
	if (owner.initializedBackend !== undefined) {
		if (isMemoizedBackendUsable(owner.initializedBackend)) return owner.initializedBackend;
		// Never hand out a backend from a stopped lifecycle generation.
		owner.initializedBackend = undefined;
		owner.initializing = undefined;
	}
	owner.initializing ??= getReadyDbosBackend()
		.catch(async (error: unknown) => {
			if (error instanceof DbosShutdownError) {
				owner.initializing = undefined;
				throw error;
			}
			return await degradeToNonDurableBackend(error);
		})
		.then((backend) => {
			owner.initializedBackend = backend;
			return backend;
		});
	return await owner.initializing;
}

async function degradeToNonDurableBackend(error: unknown): Promise<DurableWorkflowBackend> {
	const detail = readDbosFailureDetail(error);
	const kind = await classifyDbosDurabilityFailure(error);
	const restore =
		kind === "duplicate_registration"
			? `Restore durability by resolving the duplicate DBOS operation registration: ${detail}`
			: `Restore durability by fixing Postgres provisioning: ${detail}`;
	const warning =
		"atomic-workflows: durable backend unavailable — continuing NON-DURABLY with an in-memory backend. " +
		"Workflow runs will execute, but their state will not survive this process and `/workflow resume` " +
		`after exit will not work. ${restore}`;
	const owner = getDurableBackendProcessOwner();
	const backend = new InMemoryDurableBackend();
	owner.initializedBackend = backend;
	if (!owner.warningReported) {
		owner.warningReported = true;
		try {
			if (owner.warningSink !== undefined) {
				owner.warningSink(warning);
				return backend;
			}
		} catch {
			// A stale or failed host UI must not prevent the non-durable fallback.
		}
		console.error(warning);
	}
	return backend;
}
