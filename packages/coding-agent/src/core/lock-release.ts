import { failureDebugFields, reportDebugAsync as reportDebug } from "./debug.ts";

/**
 * Releases a proper-lockfile lock without letting a failed release replace the guarded operation's outcome (#5090).
 * proper-lockfile throws when it considers the lock compromised or already released; the operation's own result or
 * error stands, and the release failure goes to the debug log.
 */
export function releaseLockSync(release: () => void, lock: string): void {
	try {
		release();
	} catch (error) {
		reportReleaseFailure(lock, error);
	}
}

/** {@link releaseLockSync} for an asynchronous release. */
export async function releaseLock(release: () => Promise<void>, lock: string): Promise<void> {
	try {
		await release();
	} catch (error) {
		reportReleaseFailure(lock, error);
	}
}

function reportReleaseFailure(lock: string, error: unknown): void {
	reportDebug("storage", "lock-release-failed", { lock, ...failureDebugFields(error) });
}
