/**
 * `keepContext` marks prompt text that compaction must never compress.
 *
 * This is a pure string transform rather than a `ctx.*` primitive: it creates no graph node,
 * has no side effect, and needs no durability, so it is safe to call anywhere a prompt is
 * assembled — including outside a run.
 */

export const KEEP_CONTEXT_OPEN_TAG = "<keepContext>";
export const KEEP_CONTEXT_CLOSE_TAG = "</keepContext>";

/**
 * Wrap text so compaction protects it verbatim.
 *
 * Every line of the span, tag lines included, becomes a protected line. Protected lines are
 * removed from the planner's deletion ranges after it responds, and the keep target rises to
 * fit them, so the span survives regardless of the compression ratio. Because the tag lines are
 * protected too, the span is re-detected on each subsequent boundary and stays protected for
 * the life of the session.
 *
 * Reserve it for text whose loss silently changes behavior — role constraints, acceptance
 * criteria and immutable contracts, explicit prohibitions, and identifiers a stage must not
 * lose such as a target branch, worktree path, or run ID. Compaction ranks lines individually,
 * so a terse constraint loses to the verbose objective it qualifies, and a prohibition deleted
 * from context reads as permission.
 *
 * Do not wrap bulk context. Protection raises the keep target, so a large protected span forces
 * heavier deletion everywhere else; tag the constraint, not the material it applies to, and
 * pass that through files and `reads`.
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
