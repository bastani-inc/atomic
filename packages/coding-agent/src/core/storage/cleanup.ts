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

/** Closes every database; one failure is thrown as it is, several together as an `AggregateError`. */
export async function closeEach(databases: Iterable<{ close(): Promise<void> }>): Promise<void> {
	const failures = (await Promise.allSettled([...databases].map((database) => database.close()))).flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length > 1)
		throw new AggregateError(failures, `${failures.length} journal store databases failed to close`);
	if (failures.length === 1) throw failures[0];
}
