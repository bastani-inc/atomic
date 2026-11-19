/**
 * Truncation that actually releases the untruncated source.
 *
 * V8 does not copy characters for `String.prototype.slice`. For a flat parent of
 * 13 characters or more it allocates a **SlicedString**, which is a length, an
 * offset, and a pointer to the parent. Template interpolation then wraps that in
 * a **ConsString**, which keeps the same pointer. So the obvious way to bound a
 * value for storage:
 *
 * ```ts
 * `${JSON.stringify(value).slice(0, 237)}...`
 * ```
 *
 * produces a 240-character string that reports `length === 240` while holding
 * the entire serialized payload alive. The bound is on what you can read, not on
 * what you retain. An 8 MiB tool result summarized to 240 characters still costs
 * 8 MiB for as long as anything keeps the summary.
 *
 * That is invisible in every ordinary test: the value is correct, its length is
 * correct, and equality holds. It only shows up as heap that never comes back.
 *
 * `split("").join("")` copies the code units into a fresh flat string with no
 * parent pointer. It is code-unit exact, including lone surrogates, because
 * `split("")` splits on UTF-16 code units rather than code points.
 *
 * Use this at any truncation whose result outlives the value it came from —
 * memoized projections, durable checkpoints, catalogs, persisted summaries.
 * A truncation that is consumed and dropped within the same turn does not need
 * it, and paying for a copy there is waste.
 */
export function flattenTruncatedString(value: string): string {
	return value.split("").join("");
}
