import { chatAnswerIntent, formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
const CHAT_TERMINATION_DIRECTIVE =
	"User wants to chat about this before choosing. Stop the current task flow and wait for the user's next message.";
const TYPED_CHAT_DIRECTIVE =
	"User wants to chat about this before choosing and provided inline text. Stop the structured-choice flow and respond to the user's message.";

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
 * Chat rule: signal-only chat keeps the legacy `terminate: true` stop/wait
 * wording. Typed chat omits `terminate` and the generic continuation suffix so
 * the model can respond to the inline user message in this same turn.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
		});
	}
	const containsChatAnswer = hasChatAnswer(result);
	const segments = buildAnswerSegments(result.answers, params.questions.length);
	if (containsChatAnswer) {
		const answerSegments = segments.length > 0 ? ` ${segments.join(" ")}` : "";
		// Mixed-dialog precedence: signal-only chat WINS. In a multi-question dialog where one
		// question carried typed chat and another is signal-only, the whole envelope takes the
		// `terminate: true` stop/wait path — a bare "chat about this" is an explicit request to
		// pause the structured flow, so it dominates. The typed message is not lost: it still
		// rides along in `answerSegments` for context. This precedence is a deliberate product
		// decision; mixing typed + signal-only chat across questions is a rare edge.
		const hasSignalOnlyChat = result.answers.some((a) => a.kind === "chat" && chatAnswerIntent(a) === undefined);
		if (!hasSignalOnlyChat) {
			return buildToolResult(`${TYPED_CHAT_DIRECTIVE}${answerSegments}`, result);
		}
		return buildToolResult(`${CHAT_TERMINATION_DIRECTIVE}${answerSegments}`, result, { terminate: true });
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
function buildAnswerSegments(answers: readonly QuestionAnswer[], questionCount: number): string[] {
	const segments: string[] = [];
	for (let questionIndex = 0; questionIndex < questionCount; questionIndex++) {
		const answer = answers.find((candidate) => candidate.questionIndex === questionIndex);
		if (answer) segments.push(buildAnswerSegment(answer));
	}
	return segments;
}

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
