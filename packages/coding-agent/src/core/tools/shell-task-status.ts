/**
 * Plain-language wording for shell task observations (`wait`) and cancellations (`kill`).
 *
 * One source of truth for two audiences: the model reads compact sentences in the tool result text, and the
 * transcript renders the same facts as a single status line. Structured data stays in the result `details`.
 */
import type {
	CancelCause,
	CancelError,
	CancelReceipt,
	Cleanup,
	Failure,
	OutputError,
	TaskResult,
	WaitError,
	WaitOutcome,
	WatchError,
} from "../tasks/contracts.js";

export type TaskStatusTone = "success" | "error" | "warning" | "dim";

/** One line of task state: `✓ completed · exit 0`. The glyph and label alone carry the meaning without color. */
export interface TaskStatus {
	glyph: "✓" | "✗" | "●" | "○";
	tone: TaskStatusTone;
	label: string;
	detail?: string;
}

export const EMPTY_OUTPUT_TEXT = "(no output)";

const CANCEL_CAUSE_TEXT: Record<CancelCause, string> = {
	user: "stop requested",
	"owner-close": "session closed",
	"execution-timeout": "timed out",
	"output-limit": "output limit reached",
	"parent-handoff": "handed off",
	pause: "paused · awaiting resume",
	quit: "quit · paused · awaiting resume",
	shutdown: "Atomic shut down",
};

function firstLine(text: string): string {
	return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function withoutTrailingPeriods(text: string): string {
	let end = text.length;
	while (end > 0 && (text[end - 1] === "." || /\s/.test(text[end - 1] ?? ""))) end--;
	return text.slice(0, end);
}

/** The message of a failure, unless it only repeats the failure code. */
function informativeMessage(code: string, message: string): string | undefined {
	const line = firstLine(message);
	return line && line !== code ? line : undefined;
}

function withDetail(status: Omit<TaskStatus, "detail">, detail: string | undefined): TaskStatus {
	return detail === undefined ? status : { ...status, detail };
}

export function taskResultStatus(result: TaskResult): TaskStatus {
	switch (result.kind) {
		case "completed":
			if (result.exitCode === 0) return { glyph: "✓", tone: "success", label: "completed", detail: "exit 0" };
			if (result.exitCode === undefined) return { glyph: "✗", tone: "error", label: "ended without an exit code" };
			return { glyph: "✗", tone: "error", label: `exited ${result.exitCode}` };
		case "failed":
			return withDetail(
				{ glyph: "✗", tone: "error", label: "failed" },
				informativeMessage(result.code, result.message),
			);
		case "cancelled":
			return withDetail(
				{ glyph: "○", tone: "dim", label: "cancelled" },
				result.cause === "user" ? undefined : CANCEL_CAUSE_TEXT[result.cause],
			);
	}
}

/** What happened to a task, as a verb phrase that follows its subject: `exited with code 1`. */
function taskResultPhrase(result: TaskResult): string {
	switch (result.kind) {
		case "completed":
			if (result.exitCode === 0) return "completed with exit code 0";
			if (result.exitCode === undefined) return "ended without an exit code";
			return `exited with code ${result.exitCode}`;
		case "failed": {
			const message = informativeMessage(result.code, result.message);
			const reason = message === undefined ? undefined : withoutTrailingPeriods(message);
			return `failed (${result.code})${reason ? `: ${reason}` : ""}${result.exitCode === undefined ? "" : ` (exit code ${result.exitCode})`}`;
		}
		case "cancelled":
			return `was cancelled (${CANCEL_CAUSE_TEXT[result.cause]})`;
	}
}

/** Status line for a `wait` result. `hasOutput` says whether any output is shown below it. */
export function waitStatus(observation: WaitOutcome, hasOutput: boolean): TaskStatus {
	if (observation.kind === "settled") return taskResultStatus(observation.result);
	return withDetail(
		{ glyph: "●", tone: "warning", label: "still running" },
		hasOutput ? "showing output so far" : undefined,
	);
}

function waitSentence(observation: WaitOutcome): string {
	if (observation.kind === "yielded")
		return `Task ${observation.taskId} is still running (yielded: ${observation.reason}).`;
	return `Task ${observation.taskId} ${taskResultPhrase(observation.result)}.`;
}

export interface WaitResultTail {
	observation: WaitOutcome;
	truncated: boolean;
	fullOutputPath?: string;
}

/**
 * Everything the model reads after a wait's output: the truncation marker, one sentence with the task's state and
 * exit code, and the path of the full output when it was truncated. The renderer strips the same tail.
 */
export function waitResultTail({ observation, truncated, fullOutputPath }: WaitResultTail): string {
	return `${truncated ? "\n[Output truncated.]" : ""}\n\n${waitSentence(observation)}${fullOutputPath ? `\nFull output: ${fullOutputPath}` : ""}`;
}

function cleanupSentence(cleanup: Cleanup): string {
	if (cleanup.kind !== "failed") return `Cleanup: ${cleanup.kind}.`;
	const resources = cleanup.resources.map(
		(entry) => `${entry.resource} (${entry.code}): ${withoutTrailingPeriods(firstLine(entry.message))}`,
	);
	return `Cleanup failed: ${resources.join("; ")}.`;
}

/** Model-facing text of a `kill` result. The receipt itself stays in the result details. */
export function cancelReceiptSentence(receipt: CancelReceipt): string {
	const { taskId, execution } = receipt;
	let lead: string;
	if (execution.kind === "settled") {
		const phrase = taskResultPhrase(execution.result);
		lead =
			receipt.decision === "already-settled"
				? `Task ${taskId} had already finished; nothing to stop. It ${phrase}.`
				: `Task ${taskId} ${phrase}.`;
	} else if (execution.kind === "cancelling") {
		lead = `Cancellation requested for task ${taskId}; it has not stopped yet.`;
	} else {
		lead = `Cancellation requested for task ${taskId}; it is still ${execution.kind}.`;
	}
	return `${lead} ${cleanupSentence(receipt.cleanup)}`;
}

/** Status line for a `kill` result, describing the task rather than the request. */
export function cancelReceiptStatus(receipt: CancelReceipt): TaskStatus {
	const { execution } = receipt;
	if (execution.kind === "settled") {
		const status = taskResultStatus(execution.result);
		return receipt.decision === "already-settled" ? { ...status, label: `already ${status.label}` } : status;
	}
	return {
		glyph: "●",
		tone: "warning",
		label: execution.kind === "cancelling" ? "stopping" : "still running",
		detail: "cancellation requested",
	};
}

/** The first resource that could not be cleaned up, for a status line; undefined when cleanup did not fail. */
export function cleanupFailureSummary(cleanup: Cleanup): string | undefined {
	if (cleanup.kind !== "failed") return undefined;
	const [first, ...rest] = cleanup.resources;
	if (!first) return undefined;
	const message = informativeMessage(first.code, first.message);
	return `${first.resource}${message ? `: ${message}` : ""}${rest.length ? ` (+${rest.length} more)` : ""}`;
}

export type TaskToolFailureCode = WaitError["code"] | CancelError["code"] | OutputError["code"] | WatchError["code"];

interface TaskErrorCopy {
	/** Names the id and what went wrong; `detail` is the supervisor's message when it says more than the code. */
	headline: (taskId: string, detail: string | undefined) => string;
	/** The next step. Shown in the transcript only, not sent to the model. */
	hint?: string;
}

const TASKS_HINT = "Run /tasks to check on it.";

const TASK_ERROR_COPY: Record<TaskToolFailureCode, TaskErrorCopy> = {
	UnknownTask: {
		headline: (taskId) => `No background task "${taskId}" in this session`,
		hint: "It may have finished and been cleaned up, or belong to another session. Run /tasks to see current tasks.",
	},
	ScopeMismatch: {
		headline: (taskId) => `Task "${taskId}" belongs to another session`,
		hint: "Run /tasks to see the tasks in this session.",
	},
	OwnerClosed: {
		headline: () => "This session's background tasks are closed",
		hint: "Run the command again to start a new task.",
	},
	EnvironmentClosing: { headline: () => "Atomic is shutting down" },
	ObserverCancelled: { headline: (taskId) => `Stopped waiting for task "${taskId}"`, hint: TASKS_HINT },
	OutputUnavailable: {
		headline: (taskId) => `Output for task "${taskId}" is no longer available`,
		hint: "Run /tasks to check on the task.",
	},
	CleanupFailed: {
		headline: (taskId, detail) => `Could not stop task "${taskId}"${detail ? `: ${detail}` : ""}`,
		hint: "Run /tasks to check whether it is still running.",
	},
	StaleGeneration: { headline: () => "The task list changed while it was being read", hint: "Try again." },
};

function isTaskToolFailureCode(code: string): code is TaskToolFailureCode {
	return Object.hasOwn(TASK_ERROR_COPY, code);
}

/**
 * A task failure on the `wait`/`kill` path. The message is `<Code>: <plain-language headline naming the task>`;
 * callers that branch on the failure read `code` instead of parsing it.
 */
export class TaskToolError extends Error {
	readonly code: TaskToolFailureCode;
	readonly taskId: string;

	constructor(failure: Failure<TaskToolFailureCode>, taskId: string) {
		super(
			`${failure.code}: ${TASK_ERROR_COPY[failure.code].headline(taskId, informativeMessage(failure.code, failure.message))}`,
		);
		this.name = "TaskToolError";
		this.code = failure.code;
		this.taskId = taskId;
	}
}

export interface TaskErrorPresentation {
	headline: string;
	hint?: string;
}

/** How the transcript presents the text of a thrown {@link TaskToolError}; undefined for any other error text. */
export function presentTaskError(text: string, taskId: string | undefined): TaskErrorPresentation | undefined {
	const match = /^(\w+): ([^\n]*)$/.exec(text.trim());
	if (!match) return undefined;
	const [, code, rest] = match;
	if (code === undefined || rest === undefined || !isTaskToolFailureCode(code)) return undefined;
	const copy = TASK_ERROR_COPY[code];
	// Sessions saved before the message was plain language hold only the code, repeated as the message.
	const headline = rest === code && taskId ? copy.headline(taskId, undefined) : rest;
	return copy.hint ? { headline, hint: copy.hint } : { headline };
}
