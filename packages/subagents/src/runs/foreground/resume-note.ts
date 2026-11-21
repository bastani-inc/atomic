import { initTheme, NoticeLine } from "@bastani/atomic";
import type { Component } from "@bastani/atomic-tui";

/**
 * The custom message that tells a relaunched child why it runs again when no message from anyone does: Atomic restarted
 * while it worked, it was resumed without a message, or something it waited for arrived. Never a message from the user,
 * and never queued behind one.
 */
export const SUBAGENT_RESUME_NOTE_TYPE = "subagent-resume-note";

/** Why the child runs again: after a restart, resumed by run control, or woken while it was released. */
export type SubagentResumeNoteKind = "restart" | "resume" | "wake";

/** A child's resume note: its kind, and what the model reads. */
export interface SubagentResumeNote {
	readonly kind: SubagentResumeNoteKind;
	readonly text: string;
}

export interface SubagentResumeNoteMessage {
	readonly customType: typeof SUBAGENT_RESUME_NOTE_TYPE;
	readonly content: string;
	readonly display: true;
	readonly details: { readonly kind: SubagentResumeNoteKind };
}

const KINDS: ReadonlySet<string> = new Set<SubagentResumeNoteKind>(["restart", "resume", "wake"]);

/** What a resume note's card says, one short line. */
const CARD_TEXT: Readonly<Record<SubagentResumeNoteKind, string>> = {
	restart: "Continuing after Atomic restarted",
	resume: "Continuing where it left off",
	wake: "Woken: what it waited for arrived",
};

export function resumeNoteMessage(note: SubagentResumeNote): SubagentResumeNoteMessage {
	return { customType: SUBAGENT_RESUME_NOTE_TYPE, content: note.text, display: true, details: { kind: note.kind } };
}

/** The kind of a saved resume note, or `undefined` for any other message. */
export function resumeNoteKindOf(message: {
	readonly customType?: string;
	readonly details?: unknown;
}): SubagentResumeNoteKind | undefined {
	if (message.customType !== SUBAGENT_RESUME_NOTE_TYPE) return undefined;
	const kind = (message.details as { readonly kind?: unknown } | null | undefined)?.kind;
	return typeof kind === "string" && KINDS.has(kind) ? (kind as SubagentResumeNoteKind) : undefined;
}

/** The card of a resume note: one dim line saying why the child runs again. */
export function renderResumeNote(
	message: { readonly customType?: string; readonly details?: unknown },
	options: { readonly outputPad?: number },
): Component | undefined {
	const kind = resumeNoteKindOf(message);
	if (kind === undefined) return undefined;
	if (!(globalThis as Record<symbol, unknown>)[Symbol.for("@bastani/atomic:theme")]) initTheme("dark", false);
	return new NoticeLine({
		status: "info",
		label: CARD_TEXT[kind],
		outcome: "",
		...(options.outputPad === undefined ? {} : { outputPad: options.outputPad }),
	});
}
