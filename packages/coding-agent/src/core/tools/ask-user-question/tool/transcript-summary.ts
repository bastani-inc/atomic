import { terminalDisplayText } from "../../../../utils/terminal-text.ts";
import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionnaireResult, QuestionParams } from "./types.js";

function questionsOf(params: QuestionParams | undefined): QuestionParams["questions"] {
	return Array.isArray(params?.questions) ? params.questions : [];
}

function questionLabel(questions: QuestionParams["questions"], index: number): string {
	const question = questions[index];
	const header = typeof question?.header === "string" && question.header.length > 0 ? question.header : undefined;
	const prompt =
		typeof question?.question === "string" && question.question.length > 0 ? question.question : undefined;
	return summaryText(header ?? prompt ?? `Q${index + 1}`);
}

function summaryText(text: string): string {
	return terminalDisplayText(text).replace(/\s+/gu, " ").trim();
}

export function summarizeQuestions(params: QuestionParams): string {
	const questions = questionsOf(params);
	return ["Questions", ...questions.map((_, index) => questionLabel(questions, index))].join(" · ");
}

export function summarizeAnswers(params: QuestionParams, result: QuestionnaireResult): string[] {
	const questions = questionsOf(params);
	if (result.cancelled || result.answers.length === 0) {
		return questions.map((question, index) => {
			const options = Array.isArray(question?.options) ? question.options : [];
			return `Declined · ${questionLabel(questions, index)} (${options.map((option) => summaryText(typeof option?.label === "string" ? option.label : "")).join(" / ")})`;
		});
	}
	const lines: string[] = [];
	for (let index = 0; index < questions.length; index++) {
		const answer = result.answers.find((candidate) => candidate.questionIndex === index);
		if (!answer) continue;
		const notes = answer.notes && answer.notes.length > 0 ? ` · notes: ${summaryText(answer.notes)}` : "";
		lines.push(`${questionLabel(questions, index)} → ${summaryText(formatAnswerScalar(answer, "summary"))}${notes}`);
	}
	return lines;
}
