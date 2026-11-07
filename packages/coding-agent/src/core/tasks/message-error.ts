import {
	findInCauseChain,
	hasErrorIdentity,
	rehydrateErrorCause,
	type SerializedTypedError,
	serializeErrorCause,
} from "../error-contract.ts";

/** Stable codes of {@link TaskMessageError}. */
export type TaskMessageErrorCode =
	| "task-unavailable"
	| "messages-unsupported"
	| "delivery-refused"
	| "delivery-unconfirmed";

/** The facts a {@link TaskMessageError} carries. */
export interface TaskMessageErrorFields {
	/** The task the message was for. */
	readonly taskId: string;
	/** The task's Intercom target, once one was known. */
	readonly target?: string;
	/** The short reason the delivery channel gave, without message text. */
	readonly detail?: string;
}

/** The facts a {@link TaskMessageTimeoutError} carries. */
export interface TaskMessageTimeoutErrorFields extends TaskMessageErrorFields {
	readonly target: string;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
}

/** A {@link TaskMessageError} as it crosses a process boundary. */
export interface SerializedTaskMessageError extends SerializedTypedError {
	code: TaskMessageErrorCode;
	fields: {
		taskId: string;
		target?: string;
		detail?: string;
		timeoutMs?: number;
		elapsedMs?: number;
		phase?: TaskMessageTimeoutPhase;
	};
}

/** The step that was running when a {@link TaskMessageTimeoutError} expired. */
export type TaskMessageTimeoutPhase = "delivery-acknowledgement";

const TASK_MESSAGE_ERROR_NAME = "TaskMessageError";
const TASK_MESSAGE_TIMEOUT_ERROR_NAME = "TaskMessageTimeoutError";
const TASK_MESSAGE_ERROR_NAMES: ReadonlySet<string> = new Set([
	TASK_MESSAGE_ERROR_NAME,
	TASK_MESSAGE_TIMEOUT_ERROR_NAME,
]);

const TASK_MESSAGE_COPY: Readonly<
	Record<TaskMessageErrorCode, { readonly failure: string; readonly hint: string; readonly retryable: boolean }>
> = {
	"task-unavailable": {
		failure: "Could not message the task",
		hint: "Run /tasks to see the current tasks",
		retryable: false,
	},
	"messages-unsupported": {
		failure: "This task cannot receive messages",
		hint: "Only agent tasks that have an Intercom target accept messages from their transcript",
		retryable: false,
	},
	"delivery-refused": {
		failure: "Intercom did not deliver the message",
		hint: "Check that the agent is still available, then send the message again",
		retryable: true,
	},
	"delivery-unconfirmed": {
		failure: "Intercom did not confirm the message",
		hint: "The agent may still receive it; check its transcript before sending it again",
		retryable: false,
	},
};

const TASK_MESSAGE_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(TASK_MESSAGE_COPY));

function isTaskMessageErrorCode(code: unknown): code is TaskMessageErrorCode {
	return typeof code === "string" && TASK_MESSAGE_ERROR_CODES.has(code);
}

/**
 * A message typed into a task's transcript did not reach the task. `retryable` is true only for
 * `delivery-refused`, where the channel reported the message undelivered, so sending it again cannot repeat it.
 */
export class TaskMessageError extends Error {
	override readonly name: string = TASK_MESSAGE_ERROR_NAME;
	readonly code: TaskMessageErrorCode;
	readonly hint: string;
	readonly retryable: boolean;
	readonly taskId: string;
	readonly target?: string;
	readonly detail?: string;

	constructor(code: TaskMessageErrorCode, fields: TaskMessageErrorFields, options?: ErrorOptions) {
		const copy = TASK_MESSAGE_COPY[code];
		const reason = fields.detail === undefined ? "" : `: ${fields.detail}`;
		super(`${copy.failure}: ${fields.target ?? fields.taskId} (${code})${reason}. ${copy.hint}.`, options);
		this.code = code;
		this.hint = copy.hint;
		this.retryable = copy.retryable;
		this.taskId = fields.taskId;
		if (fields.target !== undefined) this.target = fields.target;
		if (fields.detail !== undefined) this.detail = fields.detail;
	}

	toJSON(): SerializedTaskMessageError {
		const cause = serializeErrorCause(this.cause);
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			hint: this.hint,
			retryable: this.retryable,
			fields: {
				taskId: this.taskId,
				...(this.target === undefined ? {} : { target: this.target }),
				...(this.detail === undefined ? {} : { detail: this.detail }),
			},
			...(cause === undefined ? {} : { cause }),
		};
	}
}

/** The delivery channel did not acknowledge a message within `timeoutMs`; it may still arrive. */
export class TaskMessageTimeoutError extends TaskMessageError {
	override readonly name: string = TASK_MESSAGE_TIMEOUT_ERROR_NAME;
	override readonly code: "delivery-unconfirmed" = "delivery-unconfirmed";
	override readonly target: string;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase: TaskMessageTimeoutPhase = "delivery-acknowledgement";

	constructor(fields: TaskMessageTimeoutErrorFields, options?: ErrorOptions) {
		super("delivery-unconfirmed", fields, options);
		this.target = fields.target;
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
	}

	override toJSON(): SerializedTaskMessageError {
		const serialized = super.toJSON();
		return {
			...serialized,
			fields: { ...serialized.fields, timeoutMs: this.timeoutMs, elapsedMs: this.elapsedMs, phase: this.phase },
		};
	}
}

/** True for a {@link TaskMessageError}, also a copy from another realm or process that kept its `name` and `code`. */
export function isTaskMessageError(error: unknown): error is TaskMessageError {
	return (
		error instanceof TaskMessageError || hasErrorIdentity(error, TASK_MESSAGE_ERROR_NAMES, TASK_MESSAGE_ERROR_CODES)
	);
}

/** True for a {@link TaskMessageTimeoutError}, also a copy from another realm or process. */
export function isTaskMessageTimeoutError(error: unknown): error is TaskMessageTimeoutError {
	return (
		error instanceof TaskMessageTimeoutError ||
		hasErrorIdentity(error, new Set([TASK_MESSAGE_TIMEOUT_ERROR_NAME]), new Set(["delivery-unconfirmed"]))
	);
}

/** True when `error`, or an error in its `cause` chain, is a {@link TaskMessageError} that may be sent again. */
export function isRetryableTaskMessageError(error: unknown): boolean {
	return (
		findInCauseChain(
			error,
			(candidate): candidate is TaskMessageError => isTaskMessageError(candidate) && candidate.retryable === true,
		) !== undefined
	);
}

/** The {@link TaskMessageError} that is `error` or sits in its `cause` chain; undefined when there is none. */
export function findTaskMessageError(error: unknown): TaskMessageError | undefined {
	return findInCauseChain(error, isTaskMessageError);
}

function finiteMilliseconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Rebuilds a {@link TaskMessageError} or {@link TaskMessageTimeoutError} from its serialized form, such as a local
 * worker's reply. A copy without a known `code` or a string `fields.taskId` gives undefined.
 */
export function rehydrateTaskMessageError(value: unknown): TaskMessageError | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<Record<keyof SerializedTaskMessageError, unknown>>;
	if (!isTaskMessageErrorCode(candidate.code)) return undefined;
	const fields = (typeof candidate.fields === "object" && candidate.fields !== null ? candidate.fields : {}) as Record<
		string,
		unknown
	>;
	const taskId = optionalString(fields.taskId);
	if (taskId === undefined) return undefined;
	const target = optionalString(fields.target);
	const detail = optionalString(fields.detail);
	const cause = rehydrateErrorCause(candidate.cause as SerializedTypedError["cause"]);
	const options = cause === undefined ? undefined : { cause };
	const timeoutMs = finiteMilliseconds(fields.timeoutMs);
	const elapsedMs = finiteMilliseconds(fields.elapsedMs);
	if (candidate.code === "delivery-unconfirmed" && target !== undefined && timeoutMs !== undefined) {
		return new TaskMessageTimeoutError(
			{ taskId, target, timeoutMs, elapsedMs: elapsedMs ?? timeoutMs, ...(detail === undefined ? {} : { detail }) },
			options,
		);
	}
	return new TaskMessageError(
		candidate.code,
		{ taskId, ...(target === undefined ? {} : { target }), ...(detail === undefined ? {} : { detail }) },
		options,
	);
}
