import { AsyncLocalStorage } from "node:async_hooks";
import { raceAbort } from "../shared/abort.js";

export const DBOS_ADMISSION_TIMEOUT_MS = 10_000;

/** Deliberately has no raw message/cause: DBOS retries even wrapped connection errors. */
export class DbosDependencyError extends Error {
	readonly code = "ATOMIC_DBOS_DEPENDENCY";
	constructor(message = "Workflow database unavailable during admission. Restore PostgreSQL before retrying.") {
		super(message);
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
): Promise<T> {
	const controller = new AbortController();
	const abort = (): void => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DbosDependencyError("Workflow database admission timed out.")),
		timeoutMs,
	);
	try {
		controller.signal.throwIfAborted();
		return await raceAbort(operation(controller.signal), controller.signal);
	} catch (error) {
		controller.abort(error);
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
