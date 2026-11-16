import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionnaireResult, QuestionParams } from "./types.js";

function questionLabel(params: QuestionParams, index: number): string {
	const question = params.questions[index];
	return question?.header && question.header.length > 0 ? question.header : (question?.question ?? `Q${index + 1}`);
}

/** The call line while the questions are open: `Questions · Navigation · Packaging`. */
export function summarizeQuestions(params: QuestionParams): string {
	return ["Questions", ...params.questions.map((_, index) => questionLabel(params, index))].join(" · ");
}

/**
 * The transcript lines for a finished questionnaire, one per question: `Navigation → Build it as shown`, notes after
 * the answer. A declined or cancelled one lists what was asked: `Declined · Navigation (Build it as shown / Simplify)`.
 */
export function summarizeAnswers(params: QuestionParams, result: QuestionnaireResult): string[] {
	if (result.cancelled || result.answers.length === 0) {
		return params.questions.map(
			(question, index) =>
				`Declined · ${questionLabel(params, index)} (${question.options.map((option) => option.label).join(" / ")})`,
		);
	}
	const lines: string[] = [];
	for (let index = 0; index < params.questions.length; index++) {
		const answer = result.answers.find((candidate) => candidate.questionIndex === index);
		if (!answer) continue;
		const notes = answer.notes && answer.notes.length > 0 ? ` · notes: ${answer.notes}` : "";
		lines.push(`${questionLabel(params, index)} → ${formatAnswerScalar(answer, "summary")}${notes}`);
	}
	return lines;
}
