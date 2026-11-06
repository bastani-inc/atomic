import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import { rehydrateError, type SerializedError } from "../shared/error-codec.js";
import type { WorkflowInfrastructureFault } from "../shared/workflow-infrastructure-error.js";
import { type StageInputIdentity, StageInputRefusedError } from "./placement-errors.js";
import type { WorkerRequest } from "./protocol.js";
import type { DeliveryResult, PooledStageQuestion } from "./stage-watch-types.js";

/** What a worker answered for one stage command; undefined when the worker exited with it in flight. */
export type StageCommandOutcome = Pick<
	Extract<WorkerRequest, { kind: "stage-command-result" }>,
	"refusal" | "action" | "question" | "error"
>;

/** The receipt of a question read: the question the stage waits on, or why it has none to show (#4391). */
export type QuestionReadReceipt =
	| { readonly ok: true; readonly question: PooledStageQuestion }
	| { readonly ok: false; readonly refusal: "StageNotLive" | "PromptNotPending" };

/** The receipt of a stage chat user message: how it was admitted, or why not, with the stage's own failure. */
export type UserMessageReceipt =
	| { readonly ok: true; readonly action: StageUserMessageDeliveryAction }
	| { readonly ok: false; readonly refusal: "StageNotLive" }
	| { readonly ok: false; readonly error: SerializedError };

/** The receipt of an Intercom message: the stage session took it, or why it did not, with the session's own failure. */
export type IntercomMessageReceipt =
	| { readonly ok: true }
	| { readonly ok: false; readonly refusal: "StageNotLive" | "SessionReplaced" }
	| { readonly ok: false; readonly error: SerializedError };

/**
 * The code of the error a stage session's Intercom runtime fails a hand-over with once it ended, as when the stage
 * released its session while it waits: the session that reopens takes the message.
 */
const SESSION_INTERCOM_ENDED: WorkflowInfrastructureFault = "intercom_unavailable";

/**
 * Whether a worker's answer leaves the input for the stage to take later: the stage cannot take it yet
 * (`StaleAttempt`), or its worker exited with it in flight, or its admission is unconfirmed. The input is then given
 * back as the stage's next input; the attempt that takes it again deduplicates it by its delivery id.
 */
function retries(result: StageCommandOutcome | undefined): result is undefined {
	return result === undefined || result.refusal === "StaleAttempt" || result.refusal === "Unconfirmed";
}

/** A text input the stage defers while it waits for an answer: inputs behind it that are not text go first. */
export type StageInputDefer = "defer";

/**
 * Settles a taken read of the question `promptId` from its worker's answer: its receipt, or "retry". A stage that waits
 * on another question has none for this read.
 */
export function questionReadOutcome(
	result: StageCommandOutcome | undefined,
	promptId: string,
): "retry" | QuestionReadReceipt {
	if (retries(result)) return "retry";
	if (result.question?.promptId === promptId) return { ok: true, question: result.question };
	if (result.question !== undefined) return { ok: false, refusal: "PromptNotPending" };
	if (result.refusal === "StageNotLive" || result.refusal === "PromptNotPending")
		return { ok: false, refusal: result.refusal };
	return "retry";
}

/** Settles a taken user message from its worker's answer: its receipt, or "retry". */
export function userMessageOutcome(
	result: StageCommandOutcome | undefined,
): "retry" | StageInputDefer | UserMessageReceipt {
	if (retries(result)) return "retry";
	if (result.refusal === "AwaitingInput") return "defer";
	if (result.action !== undefined) return { ok: true, action: result.action };
	if (result.refusal === "StageNotLive") return { ok: false, refusal: "StageNotLive" };
	return result.error === undefined ? "retry" : { ok: false, error: result.error };
}

/**
 * Settles a taken Intercom message from its worker's answer: its receipt, "retry", or "defer". A message the stage
 * session could not take because its Intercom runtime ended (a session released while its stage waits) stays queued
 * for it, deferred, so the stage's inputs that are not text, such as the answer that wakes it, go first. Any other
 * failure of the session settles the message with that error, so the stage's later text is not held behind it.
 */
export function intercomMessageOutcome(
	result: StageCommandOutcome | undefined,
): "retry" | StageInputDefer | IntercomMessageReceipt {
	if (retries(result)) return "retry";
	if (result.refusal === "AwaitingInput" || result.error?.code === SESSION_INTERCOM_ENDED) return "defer";
	if (result.refusal === "StageNotLive" || result.refusal === "SessionReplaced")
		return { ok: false, refusal: result.refusal };
	if (result.error !== undefined) return { ok: false, error: result.error };
	return result.refusal === undefined ? { ok: true } : "retry";
}

/**
 * The receipt of an Intercom message meant for a session an earlier attempt of the stage ran: the attempt that took it
 * runs another session, which reads the message from the root's queue itself. Undefined for the attempt's own session.
 */
export function earlierSessionReceipt(
	input: { readonly generation: number },
	attempt: { readonly generation: number },
): IntercomMessageReceipt | undefined {
	return input.generation < attempt.generation ? { ok: false, refusal: "SessionReplaced" } : undefined;
}

/** Why nothing will take an input any more, as the root's wait for its receipt found. */
export type StageInputEnded = "pool-closed" | "work-ended";

/** The delivery of user text no stage will take any more: its child ended, or the root's pool closed first. */
export function endedUserMessage(ended: StageInputEnded): DeliveryResult {
	return { ok: false, refusal: ended === "work-ended" ? "StageNotLive" : "StaleAttempt" };
}

/** Why an Intercom message no stage will take any more is refused: its child ended, or the root's pool closed first. */
export function endedIntercomReason(ended: StageInputEnded): "pool-closed" | "stage-not-live" {
	return ended === "pool-closed" ? "pool-closed" : "stage-not-live";
}

/** The delivery a user message's receipt stands for; a stage that could not admit it fails it typed. */
export function userMessageResult(receipt: UserMessageReceipt, input: StageInputIdentity): DeliveryResult {
	if ("error" in receipt)
		throw new StageInputRefusedError("stage-failed", input, {
			detail: receipt.error.message,
			cause: rehydrateError(receipt.error),
		});
	return receipt;
}

/** Settles an Intercom message's delivery from its receipt: a message the stage did not take fails typed. */
export function intercomMessageResult(receipt: IntercomMessageReceipt, input: StageInputIdentity): void {
	if (receipt.ok) return;
	if ("error" in receipt)
		throw new StageInputRefusedError("stage-failed", input, {
			detail: receipt.error.message,
			cause: rehydrateError(receipt.error),
		});
	throw new StageInputRefusedError(
		receipt.refusal === "SessionReplaced" ? "session-replaced" : "stage-not-live",
		input,
	);
}

/** The question a question read's receipt carries; undefined when the stage no longer waits on it. */
export function questionReadResult(receipt: QuestionReadReceipt): PooledStageQuestion | undefined {
	return receipt.ok ? receipt.question : undefined;
}
