import type { QuestionAnswer } from "./types.ts";

/**
 * Continuation message used in the LLM-facing envelope. Two-sentence form —
 * the model needs the "Stop…wait…" directive to know what to do next after the
 * user picks chat instead of answering.
 */
export const CHAT_CONTINUATION_MESSAGE =
	"User wants to chat about this. Stop the current task flow and wait for the user's next message.";

/**
 * One-sentence summary form shown in the on-screen Submit-tab review pane. The dialog
 * already shows the question; the imperative continuation directive belongs in the
 * envelope, not in the user-facing summary box.
 */
export const CHAT_SUMMARY_MESSAGE = "User wants to chat about this";

/**
 * Placeholder for empty / null answer text. Used uniformly across both variants — the
 * earlier `(no answer)` fallback in the dialog summary was accidental drift; tests pin
 * `(no input)` only.
 */
export const NO_INPUT_PLACEHOLDER = "(no input)";

export type FormatAnswerVariant = "summary" | "envelope";

/**
 * Format a `QuestionAnswer` to its scalar string form. Variant controls only the
 * `kind: "chat"` branch — the envelope's stop/wait directive is needed by the LLM,
 * the dialog summary's one-sentence reminder is not. All other branches return identical
 * strings; the `kind: "custom"` empty-string handling and the option fallback both unify
 * on `NO_INPUT_PLACEHOLDER`. Switch is exhaustive — non-`void` return enforces every
 * variant is handled.
 */
export function formatAnswerScalar(a: QuestionAnswer, variant: FormatAnswerVariant): string {
	switch (a.kind) {
		case "chat":
			return variant === "envelope" ? CHAT_CONTINUATION_MESSAGE : CHAT_SUMMARY_MESSAGE;
		case "multi":
			return a.selected && a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
	}
}
