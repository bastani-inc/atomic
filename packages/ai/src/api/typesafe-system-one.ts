import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierFunction,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ProviderHeaders,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

interface TypeSafeHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

function httpError(response: Response, body: string): TypeSafeHttpError {
	const error = new Error(`TypeSafe API returned ${response.status}`) as TypeSafeHttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): TypeSafeHttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as TypeSafeHttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`TypeSafe API returned an invalid ${label}`);
	}
	return value;
}

function probabilities(value: unknown, label: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`TypeSafe API returned invalid probabilities for ${label}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, probability]) => [
			key,
			requiredNumber(probability, `probability for ${label}.${key}`),
		]),
	);
}

function parseAnswers(value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error("TypeSafe API returned an unexpected response");
	const answers: Array<[string, ClassifierAnswer]> = [];
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`TypeSafe API did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string") {
				throw new Error(`TypeSafe API did not return a choice answer for ${id}`);
			}
			answers.push([
				id,
				{
					type: "choice",
					choice: answer.choice,
					probabilities: probabilities(answer.probabilities, id),
					confidence: requiredNumber(answer.confidence, `confidence for ${id}`),
				},
			]);
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`TypeSafe API did not return a score answer for ${id}`);
			answers.push([
				id,
				{
					type: "score",
					score: requiredNumber(answer.score, `score for ${id}`),
					confidence: requiredNumber(answer.confidence, `confidence for ${id}`),
				},
			]);
		} else {
			if (answer.type !== "noul") throw new Error(`TypeSafe API did not return a bool answer for ${id}`);
			answers.push([
				id,
				{
					type: "bool",
					probability: requiredNumber(answer.noul, `probability for ${id}`),
				},
			]);
		}
	}
	return Object.fromEntries(answers);
}

function wirePayload(model: ClassifierModel<ClassifierApi>, context: ClassifierContext): Record<string, unknown> {
	return {
		model: model.id,
		state: context.state,
		questions: Object.fromEntries(
			Object.entries(context.questions).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
}

function requestHeaders(
	model: ClassifierModel<ClassifierApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			model.headers,
			optionsHeaders,
		) ?? {}
	);
}

/** TypeSafe System One classification with public `bool` values mapped to wire-level `noul`. */
export const classify: ClassifierFunction<ClassifierOptions> = async (
	model,
	context,
	options,
): Promise<ClassifierResult> => {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "typesafe-system-one") throw new Error(`Unsupported classifier API: ${model.api}`);
		if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		let payload: unknown = wirePayload(model, context);
		const transformed = await options.onPayload?.(payload, model);
		if (transformed !== undefined) payload = transformed;
		const requestFetch = options.fetch ?? globalThis.fetch;
		const { response, body } = await retryProviderRequest(
			async () => {
				const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
				const signal =
					options.signal && timeoutSignal
						? AbortSignal.any([options.signal, timeoutSignal])
						: (options.signal ?? timeoutSignal);
				try {
					const next = await requestFetch(new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`), {
						method: "POST",
						headers: requestHeaders(model, options.apiKey!, options.headers),
						body: JSON.stringify(payload),
						signal,
					});
					if (!next.ok) throw httpError(next, await next.text());
					return { response: next, body: (await next.json()) as unknown };
				} catch (error) {
					if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs!);
					throw error;
				}
			},
			{
				maxRetries: options.maxRetries ?? 2,
				maxRetryDelayMs: options.maxRetryDelayMs,
				signal: options.signal,
			},
		);
		await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		if (!isRecord(body)) throw new Error("TypeSafe API returned an unexpected response");
		output.answers = parseAnswers(body.answers, context);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), "TypeSafe API error");
		return output;
	}
};
