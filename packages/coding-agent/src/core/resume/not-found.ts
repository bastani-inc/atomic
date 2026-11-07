import { isLocalOnlySessionStorage } from "../agent-rehydrate-errors.ts";
import type { StorageDescriptor } from "../storage/database.js";
import { isRetryableStorageError, StorageUnavailableError } from "../storage/errors.js";
import {
	ResumeCatalogTimeoutError,
	ResumeCatalogUnavailableError,
	ResumeNotFoundError,
	type ResumeSubject,
} from "./errors.ts";

/**
 * The typed miss for a session resume whose id matched nothing in `descriptor`'s storage. Local-only storage says the
 * node is not joined to the shared storage; shared storage names only its adapter, never its URL.
 */
export function resumeNotFoundError(id: string, descriptor: StorageDescriptor): ResumeNotFoundError {
	const local = isLocalOnlySessionStorage(descriptor.adapter);
	return new ResumeNotFoundError({
		subject: "session",
		id,
		reason: local ? "local-storage-not-joined" : "shared-miss",
		storage: local ? `${descriptor.adapter} at ${descriptor.location}` : descriptor.adapter,
	});
}

/**
 * `error` as a resume lookup failure: storage that could not be reached for a reason that passes (a retryable storage
 * error, such as a refused or broken connection) becomes a retryable {@link ResumeCatalogUnavailableError} with the
 * original as its cause; anything else, such as a missing token file, is returned unchanged.
 */
export function resumeLookupError(error: unknown, subject: ResumeSubject, id: string | null): unknown {
	if (!(error instanceof StorageUnavailableError) || !isRetryableStorageError(error)) return error;
	return new ResumeCatalogUnavailableError({ subject, id, storage: error.adapter, phase: "catalog-lookup" }, error);
}

/** How long a resume waits for shared storage to answer its lookup before failing as retryable. */
export const RESUME_CATALOG_TIMEOUT_MS = 15_000;

export interface ResumeLookupTarget {
	readonly subject: ResumeSubject;
	readonly id: string | null;
	/** The storage adapter being asked. Never a URL or token. */
	readonly storage: string;
}

/**
 * `lookup`, unless it has not settled after `timeoutMs`: then a retryable {@link ResumeCatalogTimeoutError}, instead of
 * waiting for the network stack to give up on unreachable storage.
 */
export async function withResumeLookupDeadline<T>(
	lookup: Promise<T>,
	target: ResumeLookupTarget,
	timeoutMs: number,
): Promise<T> {
	const startedAt = Date.now();
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new ResumeCatalogTimeoutError({
						...target,
						phase: "catalog-lookup",
						timeoutMs,
						elapsedMs: Date.now() - startedAt,
					}),
				),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([lookup, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
