import { type Api, type AssistantMessage, isModelType, type Model, retryAssistantCall } from "@bastani/pi-ai";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { raceWithAbortSignal } from "../../utils/abort.js";
import {
	createStructuredOutputTool,
	type JsonObject,
	STRUCTURED_OUTPUT_TOOL_NAME,
} from "../tools/structured-output.ts";
import { InvalidDecisionOutputError } from "./invalid-output.js";
import { inferJev, STRUCTURED_DECISION_POLICY } from "./jev.js";
import { DEFAULT_DECISION_RETRY, JevRequestError } from "./jev-client.js";
import { isStructuredOutputProviderModel, resolveRouterModel } from "./resolver.js";
import type { RouterDecisionRequest, StructuredOutputRequest, StructuredOutputResult } from "./types.js";

export type { JevStructuredOutputProvider } from "./resolver.js";
export {
	getStructuredOutputProviders,
	JEV_STRUCTURED_OUTPUT_PROVIDER,
	resolveRouterModel,
} from "./resolver.js";
export type {
	RouterDecisionRequest,
	RouterModelSelectionOptions,
	StructuredChoiceQuestion,
	StructuredOutputModel,
	StructuredOutputRequest,
	StructuredOutputResult,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;

function positiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
		throw new Error(`Structured output ${name} must be a positive integer no greater than 2147483647.`);
	}
}

/** Reject lossy/non-JSON state rather than silently dropping context or exact numbers. */
function jsonSnapshot<T>(value: T): T {
	const seen = new Set<object>();
	const visit = (item: unknown): void => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (typeof item !== "object" || item === null || seen.has(item))
			throw new Error("Structured output inputs must be finite, acyclic JSON data.");
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			throw new Error("Structured output inputs must be plain JSON objects.");
		seen.add(item);
		for (const child of Object.values(item)) visit(child);
		seen.delete(item);
	};
	visit(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

function validateState(state: JsonObject): void {
	if (!state || typeof state !== "object" || Array.isArray(state) || Object.keys(state).length === 0) {
		throw new Error(
			"Structured output requires a nonempty named state object containing the task and relevant context text.",
		);
	}
}

async function inferChat<T extends TSchema>(
	request: StructuredOutputRequest<T>,
	model: Model<Api>,
	signal: AbortSignal,
	assertActive: () => void,
): Promise<StructuredOutputResult<Static<T>>> {
	// Anthropic catalog configuration may opt into server-side fallback. A decision must not.
	const decisionModel =
		model.api === "anthropic-messages"
			? { ...model, compat: { ...(model as Model<"anthropic-messages">).compat, allowedFallbackModels: [] } }
			: model;
	const tool = createStructuredOutputTool({ schema: request.schema });
	let response: AssistantMessage;
	assertActive();
	try {
		response = await retryAssistantCall(
			() =>
				request.modelRegistry
					.streamSimple(
						decisionModel,
						{
							systemPrompt: `${STRUCTURED_DECISION_POLICY}\n\n${request.instructions}\n\nCall ${STRUCTURED_OUTPUT_TOOL_NAME} exactly once with the decision. Do not use prose or other tools.`,
							messages: [
								{
									role: "user",
									content: JSON.stringify({ state: request.state, questions: request.jev.questions }),
									timestamp: Date.now(),
								},
							],
							tools: [
								{
									name: tool.name,
									description: tool.description,
									parameters: tool.parameters,
									constrainedSampling: { type: "json_schema", strict: "prefer" },
								},
							],
						},
						{
							signal,
							maxRetries: 0,
							transport: "sse",
							toolChoice: "auto",
							maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
						},
					)
					.result(),
			request.retry ?? DEFAULT_DECISION_RETRY,
			signal,
		);
	} catch {
		signal.throwIfAborted();
		// Provider exceptions can echo private state or credentials; do not retain their cause.
		throw new Error("Structured output provider request failed. Check provider configuration and connectivity.");
	}
	signal.throwIfAborted();
	if (response.stopReason === "error" || response.stopReason === "aborted")
		throw new Error(
			`Structured output inference ended with ${response.stopReason}; provider request failed; no decision was accepted.`,
		);
	if (response.content.some((part) => part.type === "fallback"))
		throw new Error("Structured output requires exactly one structured_output call and no provider fallback.");
	if (response.stopReason !== "toolUse") {
		const error = new InvalidDecisionOutputError("Structured output requires one structured_output call.");
		error.usage = { inputTokens: response.usage.input, outputTokens: response.usage.output };
		throw error;
	}
	const calls = response.content.filter((part) => part.type === "toolCall");
	if (calls.length !== 1 || calls[0].name !== STRUCTURED_OUTPUT_TOOL_NAME) {
		const error = new InvalidDecisionOutputError(
			"Structured output requires exactly one structured_output call and no provider fallback.",
		);
		error.usage = { inputTokens: response.usage.input, outputTokens: response.usage.output };
		throw error;
	}
	// These are result arguments, never executable tool calls. Strict validation happens below.
	return {
		value: calls[0].arguments as Static<T>,
		model: `${model.provider}/${model.id}`,
		responseModel: response.model,
		usage: { inputTokens: response.usage.input, outputTokens: response.usage.output },
	};
}

/** Credential failures get a static reason; their messages carry auth guidance. */
function jevFallbackReason(error: unknown): string {
	if (error instanceof JevRequestError && error.credential) return "Jev credentials are missing or were rejected.";
	return error instanceof Error ? error.message : "Jev routing failed.";
}

/** General structured inference remains one-shot. */
export function inferStructuredOutput<T extends TSchema>(
	request: StructuredOutputRequest<T>,
): Promise<StructuredOutputResult<Static<T>>> {
	return inferDecision(request, 0);
}

async function inferDecision<T extends TSchema>(
	request: StructuredOutputRequest<T>,
	repairs: number,
	validateDecision?: (value: Static<T>) => boolean,
	fallbackModel?: Model<Api>,
): Promise<StructuredOutputResult<Static<T>>> {
	request.signal?.throwIfAborted();
	positiveInteger(request.maxTokens ?? DEFAULT_MAX_TOKENS, "maxTokens");
	validateState(request.state);
	if (!request.instructions?.trim()) throw new Error("Structured output requires complete judgment instructions.");
	const questions = jsonSnapshot(request.jev.questions);
	if (Object.keys(questions).length === 0) throw new Error("Structured output requires at least one Choice question.");
	for (const [id, question] of Object.entries(questions)) {
		if (
			!id.trim() ||
			!question.instructions?.trim() ||
			!question.criteria ||
			Object.keys(question.criteria).length === 0 ||
			Object.entries(question.criteria).some(
				([key, text]) => !key.trim() || typeof text !== "string" || !text.trim(),
			)
		) {
			throw new Error(
				"Structured output questions require nonempty IDs, full instructions and described Choice candidates.",
			);
		}
		if (
			question.retainForFinal !== undefined &&
			(typeof question.retainForFinal !== "string" || !Object.hasOwn(question.criteria, question.retainForFinal))
		) {
			throw new Error("Structured output retainForFinal must name an original Choice option.");
		}
	}
	// Own immutable input data across awaits, including schema and candidates. The mapper is trusted code.
	let selected = request.model ? structuredClone(request.model) : request.model;
	const snapshot = {
		...request,
		model: selected,
		state: jsonSnapshot(request.state),
		schema: jsonSnapshot(request.schema),
		jev: { questions, decode: request.jev.decode },
	};
	if (!selected || (selected.kind !== "chat" && selected.kind !== "jev")) {
		throw new Error("Structured output requires an explicit concrete inference model.");
	}
	if (
		selected.kind === "chat" &&
		(!selected.model || selected.model.id === "auto" || !isModelType(selected.model, "chat"))
	) {
		throw new Error(
			"Structured output requires a concrete chat model or Jev classifier; image models cannot decide.",
		);
	}
	const fallbackChat = fallbackModel ? structuredClone(fallbackModel) : undefined;
	if (fallbackChat && !isModelType(fallbackChat, "chat")) {
		throw new Error("Structured output fallback requires a chat model; image and classifier models cannot decide.");
	}
	let fallback: StructuredOutputResult<Static<T>>["fallback"];
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Structured output cancelled; no decision was accepted."));
	request.signal?.addEventListener("abort", abort, { once: true });
	const assertActive = () => controller.signal.throwIfAborted();
	try {
		if (request.signal?.aborted) abort();
		const usage = { inputTokens: 0, outputTokens: 0 };
		for (let attempt = 0; ; ) {
			assertActive();
			const current = {
				...snapshot,
				model: selected,
				instructions:
					attempt === 0
						? snapshot.instructions
						: `${snapshot.instructions}\n\nThe previous response failed output validation. Return a complete valid decision satisfying the original schema, candidates and constraints. Do not change the task or invent values.`,
			};
			try {
				const result = await raceWithAbortSignal(
					selected.kind === "jev"
						? inferJev(current, controller.signal, assertActive)
						: inferChat(current, selected.model, controller.signal, assertActive),
					controller.signal,
				);
				assertActive();
				usage.inputTokens += result.usage.inputTokens;
				usage.outputTokens += result.usage.outputTokens;
				let value: Static<T>;
				try {
					value = jsonSnapshot(result.value);
				} catch {
					throw new InvalidDecisionOutputError("Invalid structured output: non-JSON decision.");
				}
				if (!Check(snapshot.schema, value) || (validateDecision && !validateDecision(value)))
					throw new InvalidDecisionOutputError(
						"Invalid structured output: response does not match the decision schema.",
					);
				assertActive();
				return { ...result, value, usage, ...(fallback ? { fallback } : {}) };
			} catch (error) {
				assertActive();
				if (selected.kind === "jev" && fallbackChat && !fallback) {
					if ((error instanceof InvalidDecisionOutputError || error instanceof JevRequestError) && error.usage) {
						usage.inputTokens += error.usage.inputTokens;
						usage.outputTokens += error.usage.outputTokens;
					}
					fallback = {
						from: selected.fullId,
						to: `${fallbackChat.provider}/${fallbackChat.id}`,
						reason: jevFallbackReason(error),
					};
					// Static text only: Jev errors can carry credential guidance.
					console.warn(
						`Jev routing failed; falling back to current chat model ${fallback.to} for this routing decision.`,
					);
					selected = { kind: "chat", fullId: fallback.to, model: fallbackChat };
					attempt = 0;
					continue;
				}
				if (!(error instanceof InvalidDecisionOutputError)) throw error;
				if (error.usage) {
					usage.inputTokens += error.usage.inputTokens;
					usage.outputTokens += error.usage.outputTokens;
				}
				if (attempt < repairs) {
					attempt++;
					continue;
				}
				throw new Error(
					`${error.message} ${repairs ? `${fallback ? "Chat fallback" : "Routing"} output repair exhausted after ${repairs + 1} attempts.` : "No repair request was made."}`,
				);
			}
		}
	} finally {
		request.signal?.removeEventListener("abort", abort);
	}
}

/** Resolve only prerequisite routing inference. Does not execute the selected action or alter chat/tools. */
export async function inferRouterDecision<T extends TSchema>(
	request: RouterDecisionRequest<T>,
	/** Pure correlated-field validation against original candidates, never live admission checks. */
	validateDecision?: (value: Static<T>) => boolean,
): Promise<StructuredOutputResult<Static<T>>> {
	request.signal?.throwIfAborted();
	const { settings, currentModel, ...inference } = request;
	const model = resolveRouterModel({ settings, currentModel, modelRegistry: request.modelRegistry });
	// Any Jev failure, pinned or automatic, falls back to the current chat model.
	const fallback =
		model.kind === "jev" &&
		currentModel &&
		currentModel.id !== "auto" &&
		!isStructuredOutputProviderModel(currentModel.provider, currentModel.id)
			? currentModel
			: undefined;
	const retry = inference.retry ?? settings.getRetrySettings?.() ?? DEFAULT_DECISION_RETRY;
	return inferDecision({ ...inference, model, retry }, 3, validateDecision, fallback);
}
