import { type DetachedToolResult, isTransientExtensionStartupFailure } from "@bastani/atomic";
import { isRetryableStorageError } from "@bastani/atomic/storage";
import type {
	ReleaseWhenWaiting,
	WorkflowSerializableObject,
	WorkflowSerializableValue,
} from "./authoring-contract-stage.js";
import { StageWaitConfigError } from "./stage-wait-errors.js";
import { boundedToolPayload } from "./tool-payload-bounds.js";
import { isRetryableWorkflowError } from "./workflow-infrastructure-error.js";

/** How long a stage waits on a tool call inline before it releases its session, unless configured otherwise. */
export const DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS = 60_000;

/**
 * The largest `releaseWhenWaiting.afterMs`: the longest delay a JavaScript timer honours (2³¹−1 ms, about 24.8 days).
 * Timers clamp anything longer to 1 ms, which would release the stage at once; keep a stage resident with `false`.
 */
export const MAX_RELEASE_WHEN_WAITING_AFTER_MS = 2_147_483_647;

/** A resolved release policy: release after `afterMs`, or `undefined` to stay resident. */
export interface StageReleasePolicy {
	readonly afterMs: number;
}

function invalid(field: string, value: string, stageName: string | undefined): StageWaitConfigError {
	return new StageWaitConfigError({
		source: "sdk",
		field,
		value,
		...(stageName === undefined ? {} : { stageName }),
	});
}

/**
 * Validate one `releaseWhenWaiting` value where it enters the SDK, before anything runs. Returns `null` for an
 * explicit `false`, `undefined` when unset, or the policy.
 */
export function parseReleaseWhenWaiting(
	value: ReleaseWhenWaiting | undefined,
	stageName?: string,
): StageReleasePolicy | null | undefined {
	if (value === undefined) return undefined;
	if (value === false) return null;
	if (value === true) return { afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS };
	if (typeof value !== "object" || value === null)
		throw invalid("releaseWhenWaiting", typeof value === "string" ? JSON.stringify(value) : String(value), stageName);
	const afterMs = (value as { readonly afterMs?: number | string }).afterMs;
	if (
		typeof afterMs !== "number" ||
		!Number.isFinite(afterMs) ||
		afterMs < 0 ||
		afterMs > MAX_RELEASE_WHEN_WAITING_AFTER_MS
	)
		throw invalid(
			"releaseWhenWaiting.afterMs",
			typeof afterMs === "string" ? JSON.stringify(afterMs) : String(afterMs),
			stageName,
		);
	return { afterMs };
}

/**
 * Validate the `releaseWhenWaiting` of every step of one `ctx.chain` or `ctx.parallel` call, with the call's shared
 * value, before any step starts. A step refused here names its stage; nothing has prompted a model yet.
 */
export function validateStepsReleaseWhenWaiting(
	steps: readonly { readonly name: string; readonly releaseWhenWaiting?: ReleaseWhenWaiting }[],
	shared: ReleaseWhenWaiting | undefined,
): void {
	for (const step of steps) parseReleaseWhenWaiting(step.releaseWhenWaiting ?? shared, step.name);
	parseReleaseWhenWaiting(shared);
}

/** The stage's own setting wins over the run's; with neither, stages release after the default threshold. */
export function resolveStageReleasePolicy(
	stageValue: ReleaseWhenWaiting | undefined,
	runPolicy: StageReleasePolicy | null | undefined,
	stageName: string,
): StageReleasePolicy | undefined {
	const stagePolicy = parseReleaseWhenWaiting(stageValue, stageName);
	const policy = stagePolicy === undefined ? runPolicy : stagePolicy;
	if (policy === null) return undefined;
	return policy ?? { afterMs: DEFAULT_RELEASE_WHEN_WAITING_AFTER_MS };
}

/** How many times a waiting stage tries to reopen its session, or to write one of its records, before it gives up. */
export const STAGE_WAIT_RETRY_ATTEMPTS = 3;
/** The wait before a waiting stage's second attempt, in milliseconds. */
export const STAGE_WAIT_RETRY_BASE_DELAY_MS = 500;
/** Each later wait between attempts is this many times longer than the one before. */
export const STAGE_WAIT_RETRY_BACKOFF_FACTOR = 4;
/** Each wait varies by up to this fraction either way, so stages that failed together do not retry together. */
export const STAGE_WAIT_RETRY_JITTER = 0.2;

function nominalRetryDelayMs(attempt: number): number {
	return STAGE_WAIT_RETRY_BASE_DELAY_MS * STAGE_WAIT_RETRY_BACKOFF_FACTOR ** (attempt - 1);
}

/** The most a waiting stage's attempts wait between them in total, in milliseconds: the retry's backoff budget. */
export const STAGE_WAIT_RETRY_BUDGET_MS = Array.from(
	{ length: STAGE_WAIT_RETRY_ATTEMPTS - 1 },
	(_, index) => nominalRetryDelayMs(index + 1) * (1 + STAGE_WAIT_RETRY_JITTER),
).reduce((total, delay) => total + delay, 0);

/** How long a waiting stage waits after its failed `attempt` (1-based) before it tries again. */
export function stageWaitRetryDelayMs(attempt: number): number {
	const jitter = 1 + STAGE_WAIT_RETRY_JITTER * (2 * Math.random() - 1);
	return Math.round(nominalRetryDelayMs(attempt) * jitter);
}

/**
 * Why a released stage's session failed to reopen. `transient`: the session store or the network failed, or the
 * failure says it is retryable (a store's write-lock timeout says so); another attempt may succeed. `session-not-found`:
 * the store answered, but does not hold the session. `other`: anything else, such as a model, credential or
 * configuration failure, or a store whose writers' queue is unusable.
 */
export type StageReopenFailureCause = "transient" | "session-not-found" | "other";

const MAX_CAUSE_DEPTH = 8;
/** Matched by name: the session store and the storage layer each define a `StorageUnavailableError`. */
const TRANSIENT_STORAGE_ERRORS: ReadonlySet<string> = new Set([
	"StorageUnavailableError",
	"StorageOutcomeUnknownError",
]);
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"EPIPE",
	"EAI_AGAIN",
]);

/** Read why a released stage's session failed to reopen from the failure's cause chain, at most eight levels deep. */
export function stageReopenFailureCause(error: unknown): StageReopenFailureCause {
	let transient = isRetryableWorkflowError(error) || isRetryableStorageError(error);
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const { name, code, cause } = current as {
			readonly name?: unknown;
			readonly code?: unknown;
			readonly cause?: unknown;
		};
		if (name === "SessionNotFoundError") return "session-not-found";
		if (
			(typeof name === "string" && TRANSIENT_STORAGE_ERRORS.has(name)) ||
			(typeof code === "string" && NETWORK_ERROR_CODES.has(code)) ||
			isTransientExtensionStartupFailure(current)
		)
			transient = true;
		current = cause;
	}
	return transient ? "transient" : "other";
}

/** A part of a recorded result the model reads: text, or an image as base64 data. */
export type StageWaitToolResultPart =
	| { readonly type: "text"; readonly text: string; readonly textSignature?: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

/**
 * A detached call's result as a waiting stage records it with its wait, so a resume continues the stage's turn from it
 * instead of running the call again. The parts the model reads are kept whole; `details` and `structuredContent` are
 * bounded like any recorded tool payload.
 */
export interface StageWaitToolResult extends WorkflowSerializableObject {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
	readonly content: readonly StageWaitToolResultPart[];
	readonly details?: WorkflowSerializableValue;
	readonly structuredContent?: WorkflowSerializableValue;
}

type DetachedResultPayload = DetachedToolResult["result"];

function recordedPart(part: DetachedResultPayload["content"][number]): StageWaitToolResultPart {
	if (part.type === "image") return { type: "image", data: part.data, mimeType: part.mimeType };
	return {
		type: "text",
		text: part.text,
		...(part.textSignature === undefined ? {} : { textSignature: part.textSignature }),
	};
}

/** The JSON-safe record of the results a waiting stage was woken with. */
export function recordStageWaitToolResults(results: readonly DetachedToolResult[]): StageWaitToolResult[] {
	return results.map(({ toolCallId, toolName, isError, result }) => ({
		toolCallId,
		toolName,
		isError,
		content: (result.content ?? []).map(recordedPart),
		...(result.details === undefined
			? {}
			: { details: boundedToolPayload(result.details as WorkflowSerializableValue) }),
		...(result.structuredContent === undefined
			? {}
			: { structuredContent: boundedToolPayload(result.structuredContent as WorkflowSerializableValue) }),
	}));
}

/** The results a waiting stage recorded, as its reopened session takes them. */
export function stageWaitToolResults(records: readonly StageWaitToolResult[]): DetachedToolResult[] {
	return records.map((record) => ({
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		isError: record.isError,
		result: {
			content: record.content.map((part) => ({ ...part })),
			details: record.details as DetachedResultPayload["details"],
			...(record.structuredContent === undefined
				? {}
				: { structuredContent: record.structuredContent as DetachedResultPayload["structuredContent"] }),
		},
	}));
}
