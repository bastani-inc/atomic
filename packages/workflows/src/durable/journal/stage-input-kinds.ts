import { StageInputInvalidError } from "../../workers/placement-errors.js";
import type { WorkerDeliver } from "../../workers/protocol.js";
import { POOLED_STAGE_INPUT_KINDS, type PooledStageInputKind } from "../../workers/stage-input-kind.js";
import type { DeliveryIntent, DeliveryOpId, PooledPromptAnswer } from "../../workers/stage-watch-types.js";

export { POOLED_STAGE_INPUT_KINDS, type PooledStageInputKind } from "../../workers/stage-input-kind.js";

/** A read of the brokered question (`ask_user_question`) the stage waits on, by its prompt id. */
export interface QuestionReadInput {
	readonly promptId: string;
}

/** Stage chat text, admitted at most once per `deliveryOp`, in its mode. */
export interface UserMessageInput {
	readonly deliveryOp: DeliveryOpId;
	readonly text: string;
	readonly intent: DeliveryIntent;
	readonly expandPromptTemplates?: boolean;
}

/**
 * An Intercom message for the stage session `sessionId`, from the sender it was queued with. `generation` is the attempt
 * that ran that session: the stage's replacement on another attempt runs another session, and refuses it as replaced.
 */
export interface IntercomMessageInput {
	readonly sessionId: string;
	readonly generation: number;
	readonly from: Parameters<WorkerDeliver>[0];
	readonly message: Parameters<WorkerDeliver>[1];
}

/** The payload each kind of stage input carries, as JSON in the queue. */
export interface PooledStageInputPayloads {
	readonly "prompt-answer": PooledPromptAnswer;
	readonly "question-read": QuestionReadInput;
	readonly "user-message": UserMessageInput;
	readonly "intercom-message": IntercomMessageInput;
}

const INTENTS: ReadonlySet<unknown> = new Set<DeliveryIntent>(["steer", "followUp", "auto"]);
const PROMPT_ANSWERS: ReadonlySet<unknown> = new Set<PooledPromptAnswer["kind"]>(["prompt", "input", "failed"]);

const isText = (value: unknown): boolean => typeof value === "string";
const isRecord = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);
const hasTextId = (value: unknown): boolean => isRecord(value) && isText((value as { readonly id?: unknown }).id);

/** What each kind's payload must hold, field by field: the host that applies the input reads exactly these. */
const PAYLOAD_FIELDS: {
	readonly [Kind in PooledStageInputKind]: readonly (readonly [string, (value: unknown) => boolean])[];
} = {
	"prompt-answer": [
		["kind", (value) => PROMPT_ANSWERS.has(value)],
		["promptId", isText],
	],
	"question-read": [["promptId", isText]],
	"user-message": [
		["deliveryOp", isText],
		["text", isText],
		["intent", (value) => INTENTS.has(value)],
		["expandPromptTemplates", (value) => value === undefined || typeof value === "boolean"],
	],
	"intercom-message": [
		["sessionId", isText],
		["generation", (value) => Number.isSafeInteger(value) && (value as number) > 0],
		["from", hasTextId],
		["message", hasTextId],
	],
};

export function isPooledStageInputKind(kind: string): kind is PooledStageInputKind {
	return (POOLED_STAGE_INPUT_KINDS as readonly string[]).includes(kind);
}

/**
 * Checks a stage input before it is written: its kind is one a stage takes, and its payload is a JSON object with every
 * field its kind needs. Throws {@link StageInputInvalidError} otherwise, so a malformed input never reaches the head of a
 * stage's queue on another host.
 */
export function validateStageInput(input: {
	readonly kind: string;
	readonly payload: string;
	readonly runId: string;
	readonly stageId: string;
}): asserts input is typeof input & { readonly kind: PooledStageInputKind } {
	const { kind, runId, stageId } = input;
	if (!isPooledStageInputKind(kind))
		throw new StageInputInvalidError("unknown-kind", { kind, runId, stageId, field: "kind" });
	let parsed: unknown;
	try {
		parsed = JSON.parse(input.payload);
	} catch (cause) {
		throw new StageInputInvalidError("malformed-payload", { kind, runId, stageId, field: "payload" }, { cause });
	}
	if (!isRecord(parsed))
		throw new StageInputInvalidError("malformed-payload", { kind, runId, stageId, field: "payload" });
	for (const [field, valid] of PAYLOAD_FIELDS[kind])
		if (!valid((parsed as Readonly<Record<string, unknown>>)[field]))
			throw new StageInputInvalidError("malformed-payload", { kind, runId, stageId, field });
}

const OP_PREFIXES: { readonly [Kind in Exclude<PooledStageInputKind, "prompt-answer">]: string } = {
	"question-read": "question",
	"user-message": "user",
	"intercom-message": "intercom",
};

/**
 * The op of one input of a stage's attempt `generation`: the same delivery queued again, as a root that resumed queues
 * it, is the same input. Each attempt gets its own, as prompt answers' `<kind>:<prompt id>:<generation>` do.
 */
export function stageInputOp(
	kind: Exclude<PooledStageInputKind, "prompt-answer">,
	id: string,
	generation: number,
): string {
	return `${OP_PREFIXES[kind]}:${id}:${generation}`;
}
