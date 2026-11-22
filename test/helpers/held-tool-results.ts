import assert from "node:assert/strict";

/** The results a subagent child's record holds, as they arrived: without the number its record holds each under. */
export function heldAsArrived<T extends { readonly heldSeq?: number }>(
	held: readonly T[] | undefined,
): Omit<T, "heldSeq">[] | undefined {
	return held?.map(({ heldSeq: _seq, ...result }) => result);
}

/**
 * The calls a released child waits on, as its release recorded them: each names the entry that issued it, which the
 * caller does not know, so it is checked to be there and left out.
 */
export function waitedOnCalls<T extends { readonly callEntryId?: string }>(
	calls: readonly T[] | undefined,
): Omit<T, "callEntryId">[] | undefined {
	return calls?.map(({ callEntryId, ...call }) => {
		assert.equal(typeof callEntryId, "string", "the call names the entry that issued it");
		return call;
	});
}
