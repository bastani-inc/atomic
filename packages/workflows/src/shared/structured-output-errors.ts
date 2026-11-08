import type { WorkflowSerializableObject } from "./authoring-contract-stage.js";
import { causeChain, failureMessage, hasIdentity, MAX_CAUSE_DEPTH } from "./error-cause-chain.js";
import type { SerializedErrorCause } from "./stage-wait-errors.js";

/**
 * Why the runtime's own `structured_output` inference for a schema-backed stage did not produce a result. Codes are
 * public API: never rename or reuse one.
 *
 * - `auto-inference-failed`: the inference ran and failed; `cause` is the decision error.
 * - `tool-context-unavailable`: the stage's session offers no tool context to run the inference in, so it never ran.
 */
export type WorkflowStructuredOutputInferenceErrorCode = "auto-inference-failed" | "tool-context-unavailable";

const NAME = "WorkflowStructuredOutputInferenceError";

const CODES: ReadonlySet<string> = new Set<WorkflowStructuredOutputInferenceErrorCode>([
	"auto-inference-failed",
	"tool-context-unavailable",
]);

const NAMES: ReadonlySet<string> = new Set([NAME]);

/** JSON-safe facts a {@link WorkflowStructuredOutputInferenceError} carries. Never contains prompt text or transcripts. */
export interface WorkflowStructuredOutputInferenceErrorFields extends WorkflowSerializableObject {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	/** The id the runtime gave its own `structured_output` call, which no model message carries. */
	readonly toolCallId: string;
}

/** The serialized form of a {@link WorkflowStructuredOutputInferenceError}, for crossing a worker or IPC boundary. */
export interface SerializedWorkflowStructuredOutputInferenceError extends WorkflowSerializableObject {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
	readonly retryable: boolean;
	readonly fields: WorkflowStructuredOutputInferenceErrorFields;
	readonly cause?: SerializedErrorCause;
}

const SUBJECTS: Readonly<Record<WorkflowStructuredOutputInferenceErrorCode, string>> = {
	"auto-inference-failed": "The automatic structured_output inference failed",
	"tool-context-unavailable": "The automatic structured_output inference could not start",
};

const HINTS: Readonly<Record<WorkflowStructuredOutputInferenceErrorCode, string>> = {
	"auto-inference-failed":
		"The runtime falls back to corrective prompts. Check the decision model and its credentials (the decisionModel setting), raise the stage's schemaTimeoutMs for a slow model, or end the stage with the final answer its schema needs; the cause says what failed.",
	"tool-context-unavailable":
		"The runtime falls back to corrective prompts. Create the stage's session with the Atomic SDK, whose sessions expose the tool context the inference runs in.",
};

/**
 * The runtime ran, or tried to run, the `structured_output` inference itself because a schema-backed stage's turn
 * ended without a successful call, and got no result. It is never thrown to the workflow on its own: the stage goes on
 * to its corrective prompts, and the error is the `cause` of whatever the stage finally fails with, and is recorded as
 * a stage warning. Not retryable: the corrective prompts are the retry. A cancelled stage is not a failure of the
 * inference and never carries this error.
 */
export class WorkflowStructuredOutputInferenceError extends Error {
	override readonly name = NAME;
	readonly code: WorkflowStructuredOutputInferenceErrorCode;
	readonly hint: string;
	readonly retryable = false as const;
	readonly fields: WorkflowStructuredOutputInferenceErrorFields;

	constructor(
		code: WorkflowStructuredOutputInferenceErrorCode,
		fields: WorkflowStructuredOutputInferenceErrorFields,
		options?: ErrorOptions,
	) {
		const hint = HINTS[code];
		super(failureMessage(SUBJECTS[code], `stage "${fields.stageName}"`, code, hint), options);
		this.code = code;
		this.hint = hint;
		this.fields = fields;
	}

	toJSON(): SerializedWorkflowStructuredOutputInferenceError {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			hint: this.hint,
			retryable: this.retryable,
			fields: this.fields,
			...(this.cause === undefined ? {} : { cause: serializeCause(this.cause, 0) }),
		};
	}
}

/** True for the error, including a structural copy from another realm or process. */
export function isWorkflowStructuredOutputInferenceError(
	error: unknown,
): error is WorkflowStructuredOutputInferenceError {
	return error instanceof WorkflowStructuredOutputInferenceError || hasIdentity(error, NAMES, CODES);
}

/** The first {@link WorkflowStructuredOutputInferenceError} in `error`'s cause chain, at most eight levels deep. */
export function findWorkflowStructuredOutputInferenceError(
	error: unknown,
): WorkflowStructuredOutputInferenceError | undefined {
	return causeChain(error).find(isWorkflowStructuredOutputInferenceError);
}

/** Rebuild a serialized error as its own class on this side of a process boundary, with its rehydrated cause. */
export function deserializeWorkflowStructuredOutputInferenceError(
	serialized: SerializedWorkflowStructuredOutputInferenceError,
	cause?: Error,
): WorkflowStructuredOutputInferenceError | undefined {
	if (!CODES.has(serialized.code)) return undefined;
	const rebuilt = cause ?? (serialized.cause === undefined ? undefined : deserializeCause(serialized.cause, 0));
	const error = new WorkflowStructuredOutputInferenceError(
		serialized.code as WorkflowStructuredOutputInferenceErrorCode,
		serialized.fields,
		rebuilt === undefined ? undefined : { cause: rebuilt },
	);
	Object.defineProperty(error, "message", { value: serialized.message });
	return error;
}

function serializeCause(cause: unknown, depth: number): SerializedErrorCause {
	if (!(cause instanceof Error) || depth >= MAX_CAUSE_DEPTH)
		return { name: "Error", message: cause instanceof Error ? cause.message : String(cause) };
	const code = (cause as { readonly code?: unknown }).code;
	return {
		name: cause.name,
		message: cause.message,
		...(typeof code === "string" ? { code } : {}),
		...(cause.cause === undefined ? {} : { cause: serializeCause(cause.cause, depth + 1) }),
	};
}

function deserializeCause(cause: SerializedErrorCause, depth: number): Error {
	const nested =
		cause.cause === undefined || depth >= MAX_CAUSE_DEPTH ? undefined : deserializeCause(cause.cause, depth + 1);
	const error = new Error(cause.message, nested === undefined ? undefined : { cause: nested });
	error.name = cause.name;
	if (cause.code !== undefined) Object.assign(error, { code: cause.code });
	return error;
}
