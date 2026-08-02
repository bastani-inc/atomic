/**
 * The run identifier contract.
 *
 * A run id is a bare `crypto.randomUUID()` value (see `extension/dispatcher.ts`),
 * and the durable DBOS `workflowId` is that same value. Every user-facing surface
 * renders it in full, so every resolver accepts it only in full: there is no
 * unique-prefix fallback and no truncated form that addresses a run.
 *
 * This lives in `shared/` because both the extension resolvers and the durable
 * catalog need it, and `durable/` must not import from `extension/`.
 */

/** Canonical rendered length of a run id, dashes included. */
export const RUN_ID_LENGTH = 36;

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only for a full 8-4-4-4-12 hex UUID.
 *
 * Rejects a prefix, a 32-character dashless form, and a 36-character string that
 * is the right length but not hex — a transposed or truncated paste should fail
 * loudly here rather than silently miss during lookup.
 */
export function isFullRunId(value: string): boolean {
	return RUN_ID_PATTERN.test(value);
}

/**
 * Reported instead of "not found" so a truncated paste is diagnosable as
 * truncated. A well-formed id that no run happens to carry is a different
 * failure and keeps the not-found message.
 */
export function malformedRunIdMessage(target: string): string {
	return `Run id must be a full ${RUN_ID_LENGTH}-character UUID; got "${target}" (${target.length} chars).`;
}
