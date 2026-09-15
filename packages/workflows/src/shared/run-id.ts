/**
 * The run identifier contract.
 *
 * A run id is a bare `crypto.randomUUID()` value (see `extension/dispatcher.ts`),
 * and the durable DBOS `workflowId` is that same value. Every user-facing surface
 * renders it in full. User-facing selectors accept either that full UUID or a
 * unique 8-character hexadecimal prefix; every other truncated form is invalid.
 *
 * This lives in `shared/` because both the extension resolvers and the durable
 * catalog need it, and `durable/` must not import from `extension/`.
 */

/** Canonical rendered length of a run id, dashes included. */
export const RUN_ID_LENGTH = 36;

/** Supported short selector length. */
export const RUN_ID_PREFIX_LENGTH = 8;

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID_PREFIX_PATTERN = /^[0-9a-f]{8}$/i;

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

export function isRunIdPrefix(value: string): boolean {
	return RUN_ID_PREFIX_PATTERN.test(value);
}

export type RunIdTargetResolution =
	| { kind: "exact"; runId: string }
	| { kind: "unique_prefix"; runId: string }
	| { kind: "ambiguous"; matches: readonly string[]; message: string }
	| { kind: "malformed"; message: string }
	| { kind: "not_found" };

/** Resolve a full UUID or unique 8-hex prefix within one authoritative namespace. */
export function resolveRunIdTarget(target: string, runIds: Iterable<string>): RunIdTargetResolution {
	const ids = [...new Set(runIds)];
	if (isFullRunId(target)) {
		const exact = ids.find((id) => id === target);
		return exact === undefined ? { kind: "not_found" } : { kind: "exact", runId: exact };
	}
	if (!isRunIdPrefix(target)) return { kind: "malformed", message: malformedRunIdMessage(target) };
	const normalized = target.toLowerCase();
	const matches = ids.filter((id) => isFullRunId(id) && id.toLowerCase().startsWith(normalized));
	if (matches.length === 0) return { kind: "not_found" };
	if (matches.length === 1) return { kind: "unique_prefix", runId: matches[0]! };
	return { kind: "ambiguous", matches, message: ambiguousRunIdMessage(target, matches) };
}

export function isResolvedRunId(
	resolution: RunIdTargetResolution,
): resolution is Extract<RunIdTargetResolution, { kind: "exact" | "unique_prefix" }> {
	return resolution.kind === "exact" || resolution.kind === "unique_prefix";
}

export function ambiguousRunIdMessage(target: string, matches: readonly string[]): string {
	return `Run id prefix "${target}" is ambiguous; matches: ${matches.join(", ")}. Use the full UUID.`;
}

/**
 * Reported instead of "not found" so a truncated paste is diagnosable as
 * truncated. A well-formed id that no run happens to carry is a different
 * failure and keeps the not-found message.
 */
export function malformedRunIdMessage(target: string): string {
	return `Run id must be a full ${RUN_ID_LENGTH}-character UUID or a unique ${RUN_ID_PREFIX_LENGTH}-character hexadecimal prefix; got "${target}" (${target.length} chars).`;
}
