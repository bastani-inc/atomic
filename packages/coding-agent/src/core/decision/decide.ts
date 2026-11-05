import { type ClassifierAnswer, containsKnownEnvCredential } from "@bastani/pi-ai";
import { type TSchema, Type } from "typebox";
import { raceWithAbortSignal } from "../../utils/abort.js";
import { type DecisionRunResult, decisionFailure, runDecision } from "../structured-output/index.js";
import { resolveDecisionModel } from "../structured-output/resolver.js";
import type {
	DecisionModelSelectionOptions,
	StructuredDecisionQuestion,
	StructuredOutputModel,
} from "../structured-output/types.js";
import type { JsonValue } from "../tools/structured-output.ts";
import {
	DecisionModelUnavailableError,
	DecisionProviderError,
	DecisionRequestError,
	type DecisionRequestErrorReason,
} from "./errors.js";
import type {
	DecisionAnswers,
	DecisionQuestion,
	DecisionQuestions,
	DecisionRequest,
	DecisionResult,
	DecisionSource,
} from "./types.js";

const DEFAULT_INSTRUCTIONS = "Answer each question about `state`.";

const CREDENTIAL_PATTERN =
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}/i;

function refuse(field: string, reason: DecisionRequestErrorReason): never {
	throw new DecisionRequestError({ field, reason });
}

function described(text: unknown): boolean {
	return typeof text === "string" && text.trim().length > 0;
}

function isJsonValue(value: unknown, seen: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
	seen.add(value);
	const valid = Object.values(value).every((child) => isJsonValue(child, seen));
	seen.delete(value);
	return valid;
}

function validQuestion(question: DecisionQuestion | null): boolean {
	if (!described(question?.instructions)) return false;
	const asked = question as DecisionQuestion;
	if (asked.type === "bool") return described(asked.criteria?.true) && described(asked.criteria.false);
	if (asked.type === "score")
		return Array.isArray(asked.criteria) && asked.criteria.length >= 2 && asked.criteria.every(described);
	if (asked.type !== "choice" || asked.criteria === null || typeof asked.criteria !== "object") return false;
	const options = Object.entries(asked.criteria);
	return options.length > 0 && options.every(([option, meaning]) => option.trim().length > 0 && described(meaning));
}

/** Refuse a malformed request before any model is resolved or asked. */
function validateRequest(request: DecisionRequest<DecisionQuestions>): void {
	const { state, questions } = request;
	if (
		state === null ||
		typeof state !== "object" ||
		Array.isArray(state) ||
		Object.keys(state).length === 0 ||
		!isJsonValue(state, new Set())
	)
		refuse("state", "invalid-state");
	if (questions === null || typeof questions !== "object" || Object.keys(questions).length === 0)
		refuse("questions", "no-questions");
	for (const [id, question] of Object.entries(questions)) {
		if (!id.trim() || !validQuestion(question)) refuse(`questions.${id}`, "invalid-question");
	}
	const serialized = JSON.stringify(state);
	if (containsKnownEnvCredential(serialized) || CREDENTIAL_PATTERN.test(serialized))
		refuse("state", "credential-in-state");
	if (request.instructions !== undefined && !described(request.instructions))
		refuse("instructions", "invalid-instructions");
	if (request.deadline !== undefined && (!Number.isSafeInteger(request.deadline) || request.deadline <= 0))
		refuse("deadline", "invalid-deadline");
	if (
		request.model !== undefined &&
		(typeof request.model !== "string" ||
			!request.model ||
			request.model.trim() !== request.model ||
			request.model === "auto")
	)
		refuse("model", "invalid-model");
}

function optionList(entries: readonly (readonly [string, string])[]): string {
	return `${entries.map(([option, meaning]) => `${option}: ${meaning}`).join("; ")}.`;
}

/** The chat model's result contract: one property per question. */
function chatSchema(questions: DecisionQuestions): TSchema {
	return Type.Object(
		Object.fromEntries(
			Object.entries(questions).map(([id, question]) => {
				if (question.type === "bool")
					return [
						id,
						Type.Boolean({
							description: `${question.instructions} ${optionList([
								["true", question.criteria.true],
								["false", question.criteria.false],
							])}`,
						}),
					];
				if (question.type === "score")
					return [
						id,
						Type.Integer({
							minimum: 0,
							maximum: question.criteria.length - 1,
							description: `${question.instructions} ${optionList(question.criteria.map((level, index) => [String(index), level]))}`,
						}),
					];
				return [
					id,
					Type.String({
						enum: Object.keys(question.criteria),
						description: `${question.instructions} ${optionList(Object.entries(question.criteria))}`,
					}),
				];
			}),
		),
		{ additionalProperties: false },
	);
}

function structuredQuestion(question: DecisionQuestion): StructuredDecisionQuestion {
	if (question.type === "bool")
		return {
			type: "bool",
			instructions: question.instructions,
			criteria: { true: question.criteria.true, false: question.criteria.false },
		};
	if (question.type === "score")
		return { type: "score", instructions: question.instructions, criteria: [...question.criteria] };
	return { instructions: question.instructions, criteria: { ...question.criteria } };
}

/** The chat-shaped value of a classifier's answers, so both kinds of model meet one schema. */
function chatValue(
	questions: DecisionQuestions,
	answers: Readonly<Record<string, ClassifierAnswer>>,
): Record<string, JsonValue> {
	return Object.fromEntries(
		Object.keys(questions).map((id) => {
			const answer = answers[id]!;
			if (answer.type === "bool") return [id, answer.probability >= 0.5];
			if (answer.type === "score") return [id, Math.round(answer.score)];
			return [id, answer.choice];
		}),
	);
}

function typedAnswers<Q extends DecisionQuestions>(
	questions: Q,
	run: DecisionRunResult<Record<string, JsonValue>> & { readonly source: DecisionSource },
): DecisionAnswers<Q> {
	return Object.fromEntries(
		Object.entries(questions).map(([id, question]) => {
			const value = run.value[id];
			const classified = run.source === "classifier" ? run.classifierAnswers?.[id] : undefined;
			if (question.type === "bool")
				return [
					id,
					{
						type: "bool",
						value: value === true,
						...(classified?.type === "bool" ? { probability: classified.probability } : {}),
					},
				];
			if (question.type === "score")
				return [
					id,
					classified?.type === "score"
						? { type: "score", score: classified.score, confidence: classified.confidence }
						: { type: "score", score: value as number },
				];
			return [
				id,
				classified?.type === "choice"
					? {
							type: "choice",
							choice: classified.choice,
							probabilities: { ...classified.probabilities },
							confidence: classified.confidence,
						}
					: { type: "choice", choice: value as string },
			];
		}),
	) as DecisionAnswers<Q>;
}

/**
 * Ask the user's decision model typed questions about `state`. It resolves `decisionModel` once: a classifier answers
 * first, with each answer's probabilities; when the classifier fails, the current chat model answers without
 * probabilities, unless `requireProbabilities` is set. Code keeps control: the caller applies its own thresholds to
 * the answers and caches results if it needs to. Failures reject with a {@link DecisionError}; a cancellation rejects
 * with the signal's reason.
 */
export async function decide<const Q extends DecisionQuestions>(
	request: DecisionRequest<Q>,
): Promise<DecisionResult<Q>> {
	request.signal?.throwIfAborted();
	validateRequest(request);
	const settings = decisionSettings(request);
	const model = resolveDecisionModel({
		settings,
		modelRegistry: request.modelRegistry,
		currentModel: request.currentModel,
	});
	return decideOn(request, settings, model);
}

export async function decideWithModel<const Q extends DecisionQuestions>(
	request: Omit<DecisionRequest<Q>, "model">,
	model: StructuredOutputModel,
): Promise<DecisionResult<Q>> {
	request.signal?.throwIfAborted();
	validateRequest(request);
	return decideOn(request, decisionSettings(request), model);
}

function decisionSettings(request: Omit<DecisionRequest, "model"> & { readonly model?: string }) {
	const source = request.settings;
	const settings: DecisionModelSelectionOptions["settings"] = {
		getDecisionModel: () => request.model ?? source.getDecisionModel(),
		getRetrySettings: source.getRetrySettings?.bind(source),
		getHttpIdleTimeoutMs: source.getHttpIdleTimeoutMs?.bind(source),
	};
	return settings;
}

async function decideOn<const Q extends DecisionQuestions>(
	request: Omit<DecisionRequest<Q>, "model">,
	settings: DecisionModelSelectionOptions["settings"],
	model: StructuredOutputModel,
): Promise<DecisionResult<Q>> {
	if (request.requireProbabilities === true && model.kind !== "classifier")
		throw new DecisionModelUnavailableError({ reason: "no-probabilities", model: model.fullId });
	const questions = request.questions;
	const registry = request.modelRegistry;
	const screen = registry.containsConfiguredCredential;
	let screeningFailure: { readonly error: unknown } | undefined;
	const prepare = screen
		? async (signal: AbortSignal): Promise<void> => {
				let found: boolean;
				try {
					found = await raceWithAbortSignal(screen.call(registry, JSON.stringify(request.state)), signal);
				} catch (error) {
					if (!signal.aborted) screeningFailure = { error };
					throw error;
				}
				if (found) refuse("state", "credential-in-state");
			}
		: undefined;
	try {
		const run = await runDecision<TSchema>(
			{
				settings,
				modelRegistry: request.modelRegistry,
				currentModel: request.currentModel,
				state: request.state,
				instructions: request.instructions ?? DEFAULT_INSTRUCTIONS,
				schema: chatSchema(questions),
				classifier: {
					questions: Object.fromEntries(
						Object.entries(questions).map(([id, question]) => [id, structuredQuestion(question)]),
					),
					decode: (_choices, answers) => chatValue(questions, answers),
				},
				signal: request.signal,
				timeoutMs: request.deadline,
				retry: request.retry,
			},
			undefined,
			{ model, chatFallback: request.requireProbabilities !== true, ...(prepare ? { prepare } : {}) },
		);
		const typed = run as DecisionRunResult<Record<string, JsonValue>> & { readonly source: DecisionSource };
		return {
			answers: typedAnswers(questions, typed),
			source: typed.source,
			model: typed.model,
			responseModel: typed.responseModel,
			usage: { ...typed.usage },
			...(typed.fallback ? { fallback: { ...typed.fallback } } : {}),
		};
	} catch (error) {
		if (screeningFailure !== undefined && !request.signal?.aborted)
			throw new DecisionProviderError(
				{ detail: "configured-credential screening failed before any model was asked" },
				{ cause: screeningFailure.error },
			);
		throw decisionFailure(error, request.signal, model.fullId);
	}
}
