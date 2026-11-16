import { terminalDisplayText } from "../../../../utils/terminal-text.ts";
import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionnaireResult, QuestionParams } from "./types.js";

function questionLabel(params: QuestionParams, index: number): string {
	const question = params.questions[index];
	return summaryText(
		question?.header && question.header.length > 0 ? question.header : (question?.question ?? `Q${index + 1}`),
	);
}

function summaryText(text: string): string {
	return terminalDisplayText(text).replace(/\s+/gu, " ").trim();
}

export function summarizeQuestions(params: QuestionParams): string {
	return ["Questions", ...params.questions.map((_, index) => questionLabel(params, index))].join(" · ");
}

export function summarizeAnswers(params: QuestionParams, result: QuestionnaireResult): string[] {
	if (result.cancelled || result.answers.length === 0) {
		return params.questions.map(
			(question, index) =>
				`Declined · ${questionLabel(params, index)} (${question.options.map((option) => summaryText(option.label)).join(" / ")})`,
		);
	}
	const lines: string[] = [];
	for (let index = 0; index < params.questions.length; index++) {
		const answer = result.answers.find((candidate) => candidate.questionIndex === index);
		if (!answer) continue;
		const notes = answer.notes && answer.notes.length > 0 ? ` · notes: ${summaryText(answer.notes)}` : "";
		lines.push(`${questionLabel(params, index)} → ${summaryText(formatAnswerScalar(answer, "summary"))}${notes}`);
	}
	return lines;
}
