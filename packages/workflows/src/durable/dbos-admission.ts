import { AsyncLocalStorage } from "node:async_hooks";
import { raceAbort } from "../shared/abort.js";
import {
	type DbosDatabaseDiagnostics,
	databaseDependencyMessage,
	redactedDatabaseMessage,
} from "./dbos-database-diagnostics.js";
import { getDbosProcessOwner } from "./dbos-process-owner.js";

export const DBOS_ADMISSION_TIMEOUT_MS = 10_000;

export class DbosDependencyError extends Error {
	readonly code = "ATOMIC_DBOS_DEPENDENCY";
	readonly admissionDetail?: string;
	constructor(
		message = "Workflow database unavailable during admission. Restore PostgreSQL before retrying.",
		diagnostics: DbosDatabaseDiagnostics | null | undefined = getDbosProcessOwner().databaseDiagnostics?.(),
		admissionDetail?: string,
	) {
		super(databaseDependencyMessage(message, diagnostics ?? undefined));
		this.admissionDetail = admissionDetail === undefined ? undefined : redactedDatabaseMessage(admissionDetail);
		this.name = "DbosDependencyError";
	}
}

export function isDbosDependencyError(error: unknown): error is DbosDependencyError {
	return error instanceof Error && "code" in error && error.code === "ATOMIC_DBOS_DEPENDENCY";
}

// A queued write and SDK-created bookkeeping inherit the admission that created
// them. Keeping this on globalThis also fences callbacks across bundle reloads.
const key = Symbol.for("atomic-workflows/dbos-admission-context@1");
const bag = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<AbortSignal> };
bag[key] ??= new AsyncLocalStorage<AbortSignal>();
export const dbosAdmissionContext = bag[key];

export async function boundedAdmission<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
	timeoutMs = DBOS_ADMISSION_TIMEOUT_MS,
	timeoutMessage = "Workflow database admission timed out.",
): Promise<T> {
	const controller = new AbortController();
	const abort = (): void => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new DbosDependencyError(timeoutMessage)), timeoutMs);
	try {
		controller.signal.throwIfAborted();
		return await raceAbort(operation(controller.signal), controller.signal);
	} catch (error) {
		controller.abort(error);
		if (isDbosDependencyError(error) && error.admissionDetail !== undefined)
			throw new DbosDependencyError(error.admissionDetail, null);
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
