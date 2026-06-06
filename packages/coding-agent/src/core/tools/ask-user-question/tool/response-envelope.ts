import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

/**
 * True when any answer in the result carries `kind: "chat"`.
 * Used by `buildQuestionnaireResponse` to switch to the terminate path.
 */
export function hasChatAnswer(result: QuestionnaireResult): boolean {
	return result.answers.some((a) => a.kind === "chat");
}

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and non-chat "no segments" both fall to
 * `DECLINE_MESSAGE` so the model sees a single canonical "didn't answer" signal
 * regardless of why.
 *
 * Chat rule: when any non-cancelled answer is `kind: "chat"`, the result carries
 * `terminate: true` and stop/wait wording instead of the generic continuation suffix.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
		});
	}
	const containsChatAnswer = hasChatAnswer(result);
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	if (containsChatAnswer) {
		const answerSegments = segments.length > 0 ? ` ${segments.join(" ")}` : "";
		const chatDirective =
			"User wants to chat about this before choosing. Stop the current task flow and wait for the user's next message.";
		return buildToolResult(`${chatDirective}${answerSegments}`, result, { terminate: true });
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult, options?: { terminate?: boolean }) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(options?.terminate === true ? { terminate: true } : {}),
	};
}
