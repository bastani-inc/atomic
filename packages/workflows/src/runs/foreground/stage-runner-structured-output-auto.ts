import {
	type ExtensionToolContext,
	findDecisionError,
	isDecisionOutputError,
	type StructuredOutputCapture,
} from "@bastani/atomic";
import type { TSchema } from "typebox";
import {
	WorkflowStructuredOutputInferenceError,
	type WorkflowStructuredOutputInferenceErrorCode,
	type WorkflowStructuredOutputInferenceErrorFields,
} from "../../shared/structured-output-errors.js";
import { errorMessage } from "../shared/model-fallback.js";
import { extractMessageText } from "./stage-runner-messages.js";
import { isStructuredOutputContractFailure, type StageStructuredOutputTool } from "./stage-runner-structured-output.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

type StructuredOutputCallParams = Parameters<StageStructuredOutputTool["execute"]>[1];

type StageMessage = StageSessionRuntime["messages"][number];

/** How many earlier user and assistant messages the automatic inference sees beside the final answer. */
export const AUTOMATIC_STRUCTURED_OUTPUT_TRANSCRIPT_MESSAGES = 6;

/** The most characters of the stage task, the final answer or one earlier message the inference sees. */
export const AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS = 16_000;

export interface AutomaticStructuredOutputMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/** What the runtime hands the `structured_output` inference as named state: the task, the answer and what led to it. */
export interface AutomaticStructuredOutputEvidence {
	readonly stageTask: string;
	readonly finalAssistantText: string;
	readonly recentTranscript: readonly AutomaticStructuredOutputMessage[];
}

/** Keeps both ends of an over-long text, where a task states its goal and an answer its conclusion. */
function boundedText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.ceil(limit / 2);
	return `${text.slice(0, head)}\n[… ${text.length - limit} characters omitted …]\n${text.slice(text.length - (limit - head))}`;
}

function conversationText(message: StageMessage): AutomaticStructuredOutputMessage | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = extractMessageText(message).trim();
	return text.length === 0 ? undefined : { role: message.role, text };
}

interface FinalAnswer {
	readonly index: number;
	/** The message's ordinary text exactly as the model wrote it, which a stage's output artifact keeps. */
	readonly rawText: string;
}

/** The last assistant message of the turn that carries text, or undefined when the turn left none. */
function finalAssistantAnswer(messages: readonly StageMessage[], promptStartIndex: number): FinalAnswer | undefined {
	for (let index = messages.length - 1; index >= promptStartIndex; index -= 1) {
		const message = messages[index] as StageMessage;
		if (message.role !== "assistant") continue;
		const rawText = extractMessageText(message);
		if (rawText.trim().length > 0) return { index, rawText };
	}
	return undefined;
}

/**
 * The named state for the automatic inference with the final answer it was built from, or undefined when the turn left
 * no assistant text: with nothing the stage concluded there is nothing to infer a result from, and inferring one from
 * the task alone would invent it. The final answer is the last assistant text since the prompt began; the transcript
 * is the user and assistant messages before it, tool calls and their results left out.
 */
function automaticStructuredOutputInput(input: {
	readonly stagePrompt: string;
	readonly messages: readonly StageMessage[];
	readonly promptStartIndex: number;
}): { readonly evidence: AutomaticStructuredOutputEvidence; readonly finalText: string } | undefined {
	const { messages, promptStartIndex } = input;
	const final = finalAssistantAnswer(messages, promptStartIndex);
	if (final === undefined) return undefined;
	const recent: AutomaticStructuredOutputMessage[] = [];
	for (
		let index = final.index - 1;
		index >= 0 && recent.length < AUTOMATIC_STRUCTURED_OUTPUT_TRANSCRIPT_MESSAGES;
		index -= 1
	) {
		const message = conversationText(messages[index] as StageMessage);
		if (message !== undefined)
			recent.unshift({
				role: message.role,
				text: boundedText(message.text, AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS),
			});
	}
	return {
		finalText: final.rawText,
		evidence: {
			stageTask: boundedText(input.stagePrompt, AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS),
			finalAssistantText: boundedText(final.rawText.trim(), AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS),
			recentTranscript: recent,
		},
	};
}

/** The named state for the automatic inference, or undefined when the turn left no assistant text. */
export function automaticStructuredOutputEvidence(input: {
	readonly stagePrompt: string;
	readonly messages: readonly StageMessage[];
	readonly promptStartIndex: number;
}): AutomaticStructuredOutputEvidence | undefined {
	return automaticStructuredOutputInput(input)?.evidence;
}

/** The complete judgment instructions for the automatic inference, from the stage's result schema. */
export function automaticStructuredOutputInstructions(schema: TSchema): string {
	const { title, description } = schema as { readonly title?: string; readonly description?: string };
	const contract = [title, description].filter((part) => part !== undefined && part.trim().length > 0).join(": ");
	return [
		"Produce the machine-readable result this workflow stage was asked to return, as the registered result schema defines it.",
		"state.stageTask is the stage's task, state.finalAssistantText is the agent's final answer to it, and state.recentTranscript is the exchange that led to that answer.",
		"Report what the agent concluded. Do not redo the task, and do not invent facts the state does not contain.",
		...(contract.length === 0 ? [] : [`Result schema: ${contract}`]),
	].join("\n");
}

/** What a stage's automatic inference ended in. A cancelled stage throws its abort reason instead of returning. */
export type AutomaticStructuredOutputOutcome =
	| { readonly kind: "captured"; readonly finalAssistantText: string }
	| { readonly kind: "skipped" }
	| { readonly kind: "failed"; readonly error: WorkflowStructuredOutputInferenceError };

export interface AutomaticStructuredOutputInput<TValue> {
	readonly tool: StageStructuredOutputTool;
	readonly schema: TSchema;
	readonly capture: StructuredOutputCapture<TValue>;
	readonly stagePrompt: string;
	readonly messages: readonly StageMessage[];
	readonly promptStartIndex: number;
	/** The tool context a model's call would run in, or undefined when the stage's session offers none. */
	readonly toolContext: (toolCallId: string, signal: AbortSignal) => ExtensionToolContext | undefined;
	/** Cancels the inference when the workflow or the stage is aborted. */
	readonly signal: AbortSignal;
	readonly fields: WorkflowStructuredOutputInferenceErrorFields;
}

function failure(
	code: WorkflowStructuredOutputInferenceErrorCode,
	fields: WorkflowStructuredOutputInferenceErrorFields,
	cause?: unknown,
): AutomaticStructuredOutputOutcome {
	return {
		kind: "failed",
		error: new WorkflowStructuredOutputInferenceError(code, fields, cause === undefined ? undefined : { cause }),
	};
}

/**
 * Run the inference the `structured_output` tool performs, for a schema-backed stage whose turn ended without a
 * successful call: the stage's own tool, so the result lands in the capture and the execution snapshot exactly as a
 * model's call would put it. The tool picks the decision model, then its fallbacks, then the stage session's chat
 * model, from the same tool context a model's call runs in.
 */
export async function runAutomaticStructuredOutput<TValue>(
	input: AutomaticStructuredOutputInput<TValue>,
): Promise<AutomaticStructuredOutputOutcome> {
	const { fields, signal } = input;
	const built = automaticStructuredOutputInput(input);
	if (built === undefined) return { kind: "skipped" };
	const { evidence, finalText } = built;
	let context: ExtensionToolContext | undefined;
	try {
		context = input.toolContext(fields.toolCallId, signal);
	} catch (error) {
		signal.throwIfAborted();
		return failure("tool-context-unavailable", fields, error);
	}
	if (context === undefined) return failure("tool-context-unavailable", fields);
	const params: StructuredOutputCallParams = {
		instructions: automaticStructuredOutputInstructions(input.schema),
		state: evidence,
	};
	try {
		await input.tool.execute(fields.toolCallId, params, signal, undefined, context);
	} catch (error) {
		signal.throwIfAborted();
		return failure("auto-inference-failed", fields, error);
	}
	return { kind: "captured", finalAssistantText: finalText };
}

/**
 * The failure text of an automatic inference that no corrective prompt can repair, such as a deadline overrun or a
 * provider outage, classified as the same failure of a model's own call is. Undefined when the inference never
 * started, or failed on something a corrective prompt may fix.
 *
 * A decision model's invalid output is a typed `DecisionOutputError` and is correctable, whatever its message says.
 * Only an error outside the decision family, such as the raw repair exhaustion a decision-less host raises, is told
 * apart by the contract-failure text the model's own calls are classified by.
 */
export function automaticInferenceExecutionFailure(error: WorkflowStructuredOutputInferenceError): string | undefined {
	if (error.cause === undefined) return undefined;
	const decision = findDecisionError(error.cause);
	if (decision !== undefined) return isDecisionOutputError(decision) ? undefined : errorMessage(error.cause);
	const detail = errorMessage(error.cause);
	return isStructuredOutputContractFailure(detail) ? undefined : detail;
}

/**
 * The stage warning for a failed automatic inference: the typed error's own message and the class and code of its
 * cause. No cause text, which can quote the decision model's answer.
 */
export function automaticInferenceWarning(error: WorkflowStructuredOutputInferenceError): string {
	const cause = error.cause;
	const code = typeof cause === "object" && cause !== null ? (cause as { readonly code?: unknown }).code : undefined;
	const name = cause instanceof Error ? cause.name : undefined;
	const reason = name === undefined ? "" : ` Cause: ${name}${typeof code === "string" ? ` (${code})` : ""}.`;
	return `[structured-output] ${error.message}${reason}`;
}
