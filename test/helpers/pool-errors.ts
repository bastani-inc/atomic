import assert from "node:assert/strict";
import {
	isPoolAppendRefusedError,
	isStaleLeaseError,
	type PoolAppendRefusedFields,
} from "../../packages/workflows/src/durable/journal/types.js";
import {
	isPoolNotInitializedError,
	isPublicationRejectedError,
	isStaleWorkLeaseError,
	type PublicationRejectedFields,
	type StaleWorkLeaseFields,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";

type Expected<T> = { readonly [K in keyof T]?: T[K] };

function fields(error: object, expected: object): void {
	for (const [key, value] of Object.entries(expected))
		assert.deepEqual((error as Record<string, unknown>)[key], value, `${String((error as Error).name)}.${key}`);
}

/** An `assert.rejects` validator for a {@link StaleWorkLeaseError} with the expected fields. */
export function staleWorkLease(expected: Expected<StaleWorkLeaseFields> = {}): (error: unknown) => true {
	return (error) => {
		assert.ok(isStaleWorkLeaseError(error), String(error));
		assert.equal(error.code, "stale_work_lease");
		assert.equal(error.retryable, true);
		fields(error, expected);
		return true;
	};
}

/** An `assert.rejects` validator for a root journal `StaleLeaseError` with the expected epochs. */
export function staleLease(
	expected: { readonly runId?: string; readonly heldEpoch?: number; readonly currentEpoch?: number } = {},
): (error: unknown) => true {
	return (error) => {
		assert.ok(isStaleLeaseError(error), String(error));
		assert.equal(error.code, "stale_lease");
		fields(error, expected);
		return true;
	};
}

/** An `assert.rejects` validator for a `PublicationRejectedError` with the expected fields. */
export function publicationRejected(expected: Expected<PublicationRejectedFields> = {}): (error: unknown) => true {
	return (error) => {
		assert.ok(isPublicationRejectedError(error), String(error));
		assert.equal(error.code, "publication_rejected");
		fields(error, expected);
		return true;
	};
}

/** An `assert.rejects` validator for a `PoolAppendRefusedError` whose cause passes `cause`. */
export function poolAppendRefused(
	expected: Expected<PoolAppendRefusedFields>,
	cause?: (error: unknown) => true,
): (error: unknown) => true {
	return (error) => {
		assert.ok(isPoolAppendRefusedError(error), String(error));
		assert.equal(error.code, "pool_append_refused");
		fields(error, expected);
		if (cause !== undefined) cause(error.cause);
		return true;
	};
}

/** An `assert.rejects` validator for a `PoolNotInitializedError` of `root`, or of no root for one never prepared. */
export function poolNotInitialized(root: string | undefined): (error: unknown) => true {
	return (error) => {
		assert.ok(isPoolNotInitializedError(error), String(error));
		assert.equal(error.code, "pool_not_initialized");
		assert.equal(error.root, root);
		return true;
	};
}
