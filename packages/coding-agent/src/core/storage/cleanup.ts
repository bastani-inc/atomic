/** Attaches a cleanup failure to the failure it followed, which stays the error callers see. */
export function attachCleanupCause(error: unknown, cleanupCause: unknown): void {
	Object.defineProperty(error as object, "cleanupCause", { value: cleanupCause, configurable: true });
}

/**
 * Runs `body`, then `cleanup` once. When both fail, `body`'s error is thrown with the cleanup failure attached as its
 * `cleanupCause`; a cleanup failure after a body that succeeded is thrown as it is.
 */
export async function withCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
	let result: T;
	try {
		result = await body();
	} catch (error) {
		await cleanup().catch((cleanupCause: unknown) => attachCleanupCause(error, cleanupCause));
		throw error;
	}
	await cleanup();
	return result;
}
