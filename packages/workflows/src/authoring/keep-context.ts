/**
 * `keepContext` marks prompt text an agent must recover verbatim first after its context window is cleared.
 *
 * This is a pure string transform rather than a `ctx.*` primitive: it creates no graph node,
 * has no side effect, and needs no durability, so it is safe to call anywhere a prompt is
 * assembled — including outside a run.
 */

export const KEEP_CONTEXT_OPEN_TAG = "<keepContext>";
export const KEEP_CONTEXT_CLOSE_TAG = "</keepContext>";

/**
 * Wrap text so an agent recovers it verbatim first after compaction.
 *
 * Compaction clears the context window and the agent recovers what it needs from its session
 * history. Its recovery instructions tell it to search that history for every tagged span and
 * restore each one whole before anything else. The tag has no other effect: nothing is kept in
 * context automatically, and a configured compactor model may or may not honour it.
 *
 * Reserve it for text whose loss silently changes behavior — role constraints, acceptance
 * criteria and immutable contracts, explicit prohibitions, and identifiers a stage must not
 * lose such as a target branch, worktree path, or run ID.
 *
 * Do not wrap bulk context: tag the constraint, not the material it applies to, and pass that
 * through files and `reads`, so the tagged spans stay short enough to recover first.
 *
 * Nesting is flattened rather than rejected: an already-wrapped string is returned unchanged.
 *
 * @example
 * ```ts
 * const prompt = `${keepContext("Research only. Do not implement code changes.")}\n\n${question}`;
 * ```
 */
export function keepContext(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith(KEEP_CONTEXT_OPEN_TAG) && trimmed.endsWith(KEEP_CONTEXT_CLOSE_TAG)) return trimmed;
	return `${KEEP_CONTEXT_OPEN_TAG}\n${trimmed}\n${KEEP_CONTEXT_CLOSE_TAG}`;
}
