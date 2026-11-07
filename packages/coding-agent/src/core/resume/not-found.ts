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

/** Network codes, along a storage failure's cause chain, of storage this node cannot reach for now. */
const UNREACHABLE_CODES: ReadonlySet<unknown> = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"ENETUNREACH",
	"ENETDOWN",
	"EHOSTUNREACH",
	"EHOSTDOWN",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

function unreachable(error: StorageUnavailableError): boolean {
	if (isRetryableStorageError(error)) return true;
	let current: unknown = error.cause;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		if (UNREACHABLE_CODES.has((current as NodeJS.ErrnoException).code)) return true;
		current = current.cause;
	}
	return false;
}

/**
 * `error` as a resume lookup failure: storage this node cannot reach for now (a retryable storage error, or a network
 * failure such as a refused connection or an unreachable host) becomes a retryable
 * {@link ResumeCatalogUnavailableError} with the original as its cause; anything else, such as a missing token file,
 * is returned unchanged.
 */
export function resumeLookupError(error: unknown, subject: ResumeSubject, id: string | null): unknown {
	if (!(error instanceof StorageUnavailableError) || !unreachable(error)) return error;
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
