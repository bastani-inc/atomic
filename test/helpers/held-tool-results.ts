/** The results a subagent child's record holds, as they arrived: without the number its record holds each under. */
export function heldAsArrived<T extends { readonly heldSeq?: number }>(
	held: readonly T[] | undefined,
): Omit<T, "heldSeq">[] | undefined {
	return held?.map(({ heldSeq: _seq, ...result }) => result);
}
