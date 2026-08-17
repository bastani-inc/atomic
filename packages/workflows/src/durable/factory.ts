/** DBOS-first durable backend factory with a non-durable last-resort fallback. */

import { type DurableWorkflowBackend, InMemoryDurableBackend } from "./backend.js";
import {
	DbosNotReadyError,
	DbosShutdownError,
	dbosLifecycleState,
	getReadyDbosBackend,
	getReadyDbosBackendSync,
} from "./dbos-lifecycle.js";
import { classifyDbosDurabilityFailure, readDbosFailureDetail } from "./dbos-registration-diagnostics.js";

let injectedBackend: DurableWorkflowBackend | undefined;
let initializedBackend: DurableWorkflowBackend | undefined;
let initializing: Promise<DurableWorkflowBackend> | undefined;

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
	const memoized =
		initializedBackend !== undefined && isMemoizedBackendUsable(initializedBackend) ? initializedBackend : undefined;
	const backend = injectedBackend ?? memoized ?? getReadyDbosBackendSync();
	if (backend === undefined) throw new DbosNotReadyError();
	return backend;
}

/** Internal injection seam. Production initialization uses DBOS. */
export function setDurableBackend(backend: DurableWorkflowBackend | undefined): void {
	injectedBackend = backend;
	if (backend === undefined) {
		initializedBackend = undefined;
		initializing = undefined;
	}
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
export async function initializeDurableBackend(): Promise<DurableWorkflowBackend> {
	if (injectedBackend !== undefined) return injectedBackend;
	if (initializedBackend !== undefined) {
		if (isMemoizedBackendUsable(initializedBackend)) return initializedBackend;
		// Never hand out a backend from a stopped lifecycle generation.
		initializedBackend = undefined;
		initializing = undefined;
	}
	initializing ??= getReadyDbosBackend()
		.catch(async (error: unknown) => {
			if (error instanceof DbosShutdownError) throw error;
			return await degradeToNonDurableBackend(error);
		})
		.then((backend) => {
			initializedBackend = backend;
			return backend;
		});
	return await initializing;
}

async function degradeToNonDurableBackend(error: unknown): Promise<DurableWorkflowBackend> {
	const detail = readDbosFailureDetail(error);
	const kind = await classifyDbosDurabilityFailure(error);
	const restore =
		kind === "duplicate_registration"
			? `Restore durability by resolving the duplicate DBOS operation registration: ${detail}`
			: `Restore durability by fixing Postgres provisioning: ${detail}`;
	console.error(
		"atomic-workflows: durable backend unavailable — continuing NON-DURABLY with an in-memory backend. " +
			"Workflow runs will execute, but their state will not survive this process and `/workflow resume` " +
			`after exit will not work. ${restore}`,
	);
	return new InMemoryDurableBackend();
}
