import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierFunction,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { getProviderRetryAfterMs } from "../utils/retry-hints.ts";
import { RetryDeadlineError } from "../utils/retry-sleep.ts";
import {
	InvalidClassifierJsonError,
	isRecord,
	parseClassifierUsage,
	postClassifierRequest,
} from "./classifier-shared.ts";
import { parseNoulAnswers } from "./system-one-shared.ts";

const LABEL = "Gemini Decisions";
// https://aistudio.google.com/docs/decisions-api#limits
const MAX_QUESTIONS = 1000;
const MAX_CRITERIA = 255;
const MAX_REQUEST_BYTES = 100_000_000;

function wireInput(context: ClassifierContext) {
	const text = JSON.stringify(context.state);
	if (!context.images?.length) return text;
	return [
		{ type: "text", text },
		...context.images.map(({ data, mimeType }) => ({
			type: "image",
			data: data.replace(/^data:[^,]*,/u, ""),
			mime_type: mimeType,
		})),
	];
}

function validOption(key: string): boolean {
	return key.length > 0 && [...key].length <= 128 && key === key.trim() && !/\p{Cc}|[^\S ]/u.test(key);
}

function wireQuestion(question: ClassifierQuestion) {
	if (question.type !== "bool") return question;
	const { true: yes, false: no } = question.criteria;
	return {
		type: "noul",
		instructions: question.instructions,
		...(yes || no ? { criteria: { true_description: yes || undefined, false_description: no || undefined } } : {}),
	};
}

function prepareQuestions(questions: ClassifierContext["questions"]) {
	const entries = Object.entries(questions);
	if (entries.length === 0 || entries.length > MAX_QUESTIONS) {
		throw Object.assign(new Error(`${LABEL} accepts 1 to ${MAX_QUESTIONS} questions per request`), {
			code: "invalid_request",
		});
	}
	// Structured Choice schemas can use property names and enum literals that Gemini rejects as IDs.
	const renameIds = entries.some(([id]) => !/^[A-Za-z0-9_-]{1,64}$/u.test(id));
	return entries.map(([id, question], index) => {
		const wireId = renameIds ? `q${index}` : id;
		if (question.type === "bool") return { id, wireId, question };
		const criteria = Object.entries(question.criteria);
		if (criteria.length < 2 || criteria.length > MAX_CRITERIA) {
			const kind = question.type === "choice" ? "options" : "levels";
			throw Object.assign(new Error(`${LABEL} requires 2 to ${MAX_CRITERIA} ${kind} for ${id}`), {
				code: "invalid_request",
			});
		}
		if (question.type === "score" || criteria.every(([key]) => validOption(key))) return { id, wireId, question };
		const optionKeys = new Map<string, string>();
		const wireCriteria = Object.fromEntries(
			criteria.map(([key, description], i) => {
				const wireKey = `o${i}`;
				optionKeys.set(wireKey, key);
				return [wireKey, description ? `${JSON.stringify(key)}: ${description}` : JSON.stringify(key)];
			}),
		);
		return { id, wireId, question: { ...question, criteria: wireCriteria }, optionKeys };
	});
}

function restoreChoiceKeys(answer: ClassifierAnswer, keys: ReadonlyMap<string, string> | undefined): ClassifierAnswer {
	if (answer.type !== "choice" || keys === undefined) return answer;
	return {
		...answer,
		choice: keys.get(answer.choice)!,
		probabilities: Object.fromEntries(
			Object.entries(answer.probabilities).map(([key, value]) => [keys.get(key)!, value]),
		),
	};
}

const CONTENT_BLOCK_CODES = new Set(["safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"]);

function failureCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	if ("code" in error && typeof error.code === "string") return error.code;
	if (!("body" in error) || typeof error.body !== "string") return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(error.body);
	} catch {
		return undefined;
	}
	if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
	const { code, status, details } = payload.error;
	if (typeof code === "string" && CONTENT_BLOCK_CODES.has(code)) return "content_filter";
	if (Array.isArray(details)) {
		for (const detail of details) {
			if (!isRecord(detail)) continue;
			if (detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && detail.reason === "API_KEY_INVALID") {
				return "api_key_invalid";
			}
			if (
				detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure" &&
				Array.isArray(detail.violations) &&
				detail.violations.some(
					(violation) =>
						isRecord(violation) && typeof violation.quotaId === "string" && /PerDay/i.test(violation.quotaId),
				)
			) {
				return "insufficient_quota";
			}
		}
	}
	return typeof code === "string" ? code : typeof status === "string" ? status : undefined;
}

export const classify: ClassifierFunction<ClassifierOptions> = async (model, context, options) => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	let parsingAnswers = false;
	try {
		if (model.api !== "google-decisions") throw new Error(`Unsupported classifier API: ${model.api}`);
		const questions = prepareQuestions(context.questions);
		const body = await postClassifierRequest(
			LABEL,
			new URL("decisions", `${model.baseUrl.replace(/\/+$/u, "")}/`),
			model,
			{
				model: model.id,
				input: wireInput(context),
				questions: Object.fromEntries(questions.map(({ wireId, question }) => [wireId, wireQuestion(question)])),
			},
			options,
			{
				apiKeyHeader: "x-goog-api-key",
				maxRequestBytes: MAX_REQUEST_BYTES,
				noRetry: (error) => failureCode(error) === "insufficient_quota",
			},
		);
		parsingAnswers = true;
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (isRecord(body.usage)) {
			const usage = parseClassifierUsage(
				{ input_tokens: body.usage.total_input_tokens, output_tokens: body.usage.total_output_tokens },
				model,
			);
			if (usage) output.usage = usage;
		}
		if (isRecord(body.prompt_feedback) && typeof body.prompt_feedback.block_reason === "string") {
			return {
				...output,
				stopReason: "error",
				errorMessage: `${LABEL} blocked the request`,
				code: "content_filter",
			};
		}
		const answers = parseNoulAnswers(LABEL, body.answers, {
			...context,
			questions: Object.fromEntries(questions.map(({ wireId, question }) => [wireId, question])),
		});
		output.answers = Object.fromEntries(
			questions.map(({ id, wireId, optionKeys }) => [id, restoreChoiceKeys(answers[wireId]!, optionKeys)]),
		);
	} catch (error) {
		output.stopReason = options?.signal?.aborted || error instanceof RetryDeadlineError ? "aborted" : "error";
		if (error instanceof InvalidClassifierJsonError) {
			output.errorMessage = `${LABEL} returned invalid JSON`;
			output.code = "invalid-output";
			return output;
		}
		const failure = normalizeProviderError(error);
		output.errorMessage = formatProviderError(failure, `${LABEL} error`);
		if (parsingAnswers) {
			output.code = "invalid-output";
			return output;
		}
		if (failure.status !== undefined) output.status = failure.status;
		if (error instanceof Error) {
			// The retry-delay-cap failure wraps the original HTTP error and retains the longest server hint.
			const cause = "retryAfterMs" in error && error.cause instanceof Error ? error.cause : error;
			const code = failureCode(cause);
			const retryAfterMs = getProviderRetryAfterMs(error);
			if (code !== undefined) output.code = code;
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
		}
	}
	return output;
};
