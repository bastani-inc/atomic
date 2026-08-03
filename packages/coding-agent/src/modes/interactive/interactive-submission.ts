/**
 * One Enter press, carried end to end.
 *
 * The delivered text is trimmed and paste-expanded before it reaches the agent,
 * while the draft is the exact buffer the user had when they submitted. A failed
 * send must put that exact buffer back, so the two travel together instead of
 * through a shared "last submitted draft" slot: two submissions whose drafts
 * differ only in whitespace normalize to the same text, and the slot cannot tell
 * them apart.
 */
export interface InteractiveSubmission {
	/** Normalized delivery text (trimmed, pastes expanded). */
	text: string;
	/** Exact editor buffer captured for this submission. */
	draft: string;
}

/**
 * Accept a bare string wherever a submission is expected.
 *
 * Startup-recovered input and direct callers only ever have normalized text, and
 * `{ text, draft: text }` is the honest record for them.
 */
export function toInteractiveSubmission(value: InteractiveSubmission | string): InteractiveSubmission {
	return typeof value === "string" ? { text: value, draft: value } : value;
}
