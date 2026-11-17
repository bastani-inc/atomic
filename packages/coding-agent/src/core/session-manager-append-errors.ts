import {
	isStorageTransientError,
	isStorageWriteLockTimeoutError,
	isStorageWriterQueueUnusableError,
	StoragePayloadTooLargeError,
} from "./storage/errors.js";
import { SessionInvalidTextError, SessionInvalidTimestampError } from "./storage/session/errors.js";

export function appendFailureWroteNothing(error: unknown): boolean {
	return (
		(isStorageTransientError(error) && error.outcome === "not-applied") ||
		isStorageWriteLockTimeoutError(error) ||
		isStorageWriterQueueUnusableError(error) ||
		error instanceof SessionInvalidTextError ||
		error instanceof SessionInvalidTimestampError ||
		error instanceof StoragePayloadTooLargeError ||
		(error instanceof Error && error.name === "StoreClosedError")
	);
}
