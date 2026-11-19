import { graphemeAt } from "../../utils/terminal-text.ts";
import { splitFallbackModel } from "../fallback-models.ts";
import { formatModelLabel, formatModelReferenceLabel } from "../model-label.ts";
import type { SessionManager } from "../session-manager.ts";
import { cancelReasonText, formatTimeoutSeconds, longerRunAdvice } from "./cancel-reason.js";
import { type OmissionSpan, taskOutcomeStatus } from "./command-output.js";
import type { OwnerId, Sequence, SettlementReceipt, TaskId, TaskRecord, TaskResult } from "./contracts.js";
import { isShellLikeTask, taskKindNoun, unreachableTaskKind } from "./task-kind.js";
import { taskStoppedForResume } from "./task-resumer.ts";

export const TASK_COMPLETION_MESSAGE_TYPE = "task-completion";
export type TaskCompletionEnvelope = {
	completionId: string;
	ownerId: OwnerId;
	taskId: TaskId;
	terminalSequence: Sequence;
	result: TaskResult;
	display: false;
	/**
	 * Whether the settled task was a shell or a subagent, saved with the intent so a notice replayed after a restart,
	 * when the task record is gone, still words a pause correctly. Intents saved by earlier versions lack it.
	 */
	taskKind?: TaskRecord["kind"];
	/** The tool a `tool` task ran (`search`), saved with its kind so a replayed notice still names it. */
	toolName?: string;
	/**
	 * Set when Atomic restarted while the task's workflow stage was released: the task no longer runs, and what it did
	 * was not kept (#5079).
	 */
	interruptedByRestart?: true;
	/**
	 * The subagent session that launched the task in this owner, which alone receives its notice. Absent for the
	 * owner's own tasks, whose notices this session receives. Intents saved by earlier versions lack it.
	 */
	launchedBy?: string;
	/** How long a command ran, from its launch to its settlement; its notice line shows it. */
	elapsedMs?: number;
};

/** The structured delivery identity of a settled task's completion notice. */
export function taskCompletionEnvelope(
	ownerId: OwnerId,
	receipt: SettlementReceipt,
	taskKind?: TaskRecord["kind"],
	toolName?: string,
): TaskCompletionEnvelope {
	return {
		completionId: receipt.completionId,
		ownerId,
		taskId: receipt.taskId,
		terminalSequence: receipt.cursor.sequence,
		result: receipt.result,
		display: false,
		...(taskKind === undefined ? {} : { taskKind }),
		...(taskKind === "tool" && toolName !== undefined ? { toolName } : {}),
		...(receipt.launchedBy === undefined ? {} : { launchedBy: receipt.launchedBy }),
		...(receipt.elapsedMs === undefined ? {} : { elapsedMs: receipt.elapsedMs }),
	};
}

/**
 * The one notice line a finished task shows in the transcript: what it is, its name, how it ended and how long it ran.
 * Status reads as the line's marker: success ●, failure ✗, stopped ◼, warning !, paused ⏸, waiting ◌ (a subagent
 * released while it waits, which wakes by itself).
 */
export type TaskNoticeLine = {
	status: "success" | "failure" | "stopped" | "warning" | "paused" | "waiting";
	/** `Background command`, `Agent` or `Task`. */
	label: string;
	/** The task's description or command, quoted on the line. */
	subject?: string;
	/** `completed (exit code 0)`, `finished`, `failed (exit code 1)`, `was stopped by the user`. */
	outcome: string;
	elapsedMs?: number;
};

export type TaskCompletionNotice = {
	title: string;
	preview: string;
	status: "completed" | "failed" | "cancelled";
	taskId: string;
	taskKind?: TaskRecord["kind"];
	agentName?: string;
	/** The tool a `tool` task ran (`search`). */
	toolName?: string;
	model?: string;
	thinking?: string;
	/** The model the launch asked for, when the task records one. */
	requestedModel?: string;
	/** The notice's line; notices saved by earlier versions lack it and show their title. */
	line?: TaskNoticeLine;
};

/** The line of a finished task's notice: what it is, its name, how it ended, and how long it ran. */
/** What a finished task is called at the start of its notice line: `Agent`, `Background command`, `Background search`. */
function noticeLabel(kind: TaskRecord["kind"] | undefined, toolName: string | undefined): string {
	switch (kind) {
		case "agent":
			return "Agent";
		case "command":
			return "Background command";
		case "tool":
			return `Background ${taskKindNoun({ kind, ...(toolName === undefined ? {} : { toolName }) })}`;
		case undefined:
			return "Task";
		default:
			return unreachableTaskKind(kind);
	}
}

export function taskNoticeLine(
	envelope: TaskCompletionEnvelope,
	task?: Partial<Pick<TaskRecord, "kind" | "title" | "metrics" | "toolName">>,
): TaskNoticeLine {
	const kind = task?.kind ?? envelope.taskKind;
	const toolName = task?.toolName ?? envelope.toolName;
	const result = envelope.result;
	const subject = task?.title ? task.title.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240) : undefined;
	const facts = {
		...(subject ? { subject } : {}),
		...((task?.metrics?.elapsedMs ?? envelope.elapsedMs) === undefined
			? {}
			: { elapsedMs: task?.metrics?.elapsedMs ?? envelope.elapsedMs }),
	};
	const label = noticeLabel(kind, toolName);
	// Only a process has an exit code; a tool's in-process work completes or fails without one.
	const exitCode =
		kind !== "tool" && result.kind !== "cancelled" && result.exitCode !== undefined
			? ` (exit code ${result.exitCode})`
			: "";
	// A command that exits non-zero completed, and failed.
	if (result.kind !== "cancelled" && taskOutcomeStatus(result, kind) === "completed")
		return { status: "success", label, outcome: kind === "agent" ? "finished" : `completed${exitCode}`, ...facts };
	if (result.kind !== "cancelled") return { status: "failure", label, outcome: `failed${exitCode}`, ...facts };
	const waitingOn = releasedWaitingOn(result);
	// Released while it waits, it is not paused: it wakes by itself, and every view marks it as waiting (#5489).
	if (waitingOn !== undefined) return { status: "waiting", label, outcome: `is waiting on ${waitingOn}`, ...facts };
	if (envelope.interruptedByRestart === true)
		return { status: "stopped", label, outcome: "was interrupted by a restart", ...facts };
	if (result.cause === "pause" && kind !== "agent")
		return { status: "stopped", label, outcome: "was interrupted by a pause", ...facts };
	if (kind === "agent" && isResumableStop(result))
		return {
			status: "paused",
			label,
			outcome: result.cause === "quit" ? "quit · awaiting resume" : "paused · awaiting resume",
			...facts,
		};
	if (result.cause === "user")
		return { status: "stopped", label: "Task", outcome: "was stopped by the user", ...facts };
	if (result.cause === "execution-timeout")
		return { status: "warning", label, outcome: cancelReasonText(result), ...facts };
	const reason = result.cause === "owner-close" ? cancelReasonText(result) : undefined;
	return {
		status: "stopped",
		label,
		outcome: reason === undefined ? "was stopped" : `was stopped (${reason})`,
		...facts,
	};
}

/**
 * The model-facing line saying an agent ran on another model than its launch asked for, or undefined when it ran on
 * that model, at any effort, or either is unknown. Task records name the model without its effort, which `thinking`
 * carries; both models read as their raw ID and level, like every model label (#4269).
 */
export function ranOnModelLine(
	task?: Partial<Pick<TaskRecord, "kind" | "model" | "thinking" | "requestedModel">>,
): string | undefined {
	if (task?.kind !== "agent" || task.model === undefined || task.requestedModel === undefined) return undefined;
	const requested = splitFallbackModel(task.requestedModel).modelId;
	const sameModel = requested.includes("/") ? requested === task.model : task.model.endsWith(`/${requested}`);
	if (sameModel) return undefined;
	const ranOn = formatModelLabel(task.model, { thinkingLevel: task.thinking });
	return `Model: ran on ${ranOn}, not the requested ${formatModelReferenceLabel(task.requestedModel)}.`;
}

const EXCERPT_LIMIT = 8000;

/** Keep the longest prefix or suffix that fits without bisecting a grapheme or a synthetic omission label. */
function shellExcerpt(
	text: string,
	side: "head" | "tail",
	omissions?: readonly OmissionSpan[],
	outputOffset = 0,
): string {
	if (text.length <= EXCERPT_LIMIT) return text;
	const tail = side === "tail";
	const cluster = graphemeAt(text, tail ? text.length - EXCERPT_LIMIT - 1 : EXCERPT_LIMIT)!;
	let cut = tail ? cluster.index + cluster.segment.length : cluster.index;
	const span = omissions?.find(({ start, end }) => start < cut - outputOffset && cut - outputOffset < end);
	if (span) {
		// A gap label starts with a newline, which may share a grapheme with a preceding carriage return.
		cut = tail ? outputOffset + span.end : graphemeAt(text, outputOffset + span.start)!.index;
	}
	return tail ? text.slice(cut) : text.slice(0, cut);
}

export function taskCompletionNotice(
	envelope: TaskCompletionEnvelope,
	task?: Pick<TaskRecord, "kind" | "title" | "agentName" | "model" | "thinking"> &
		Partial<Pick<TaskRecord, "requestedModel" | "metrics" | "toolName">>,
	output?: string,
	omissions?: readonly OmissionSpan[],
): TaskCompletionNotice {
	const exitCode =
		task?.kind === "command" && envelope.result.kind !== "cancelled" ? envelope.result.exitCode : undefined;
	const preview = [envelope.result.kind === "failed" ? envelope.result.message : "", output ?? ""]
		.filter(Boolean)
		.join("\n");
	// A command's last output says how it ended; a search's results read from the top.
	return {
		title:
			formatTaskCompletion(envelope, task).split("\n")[0] + (exitCode === undefined ? "" : ` · exit ${exitCode}`),
		preview:
			(task?.kind ?? envelope.taskKind) === "command"
				? shellExcerpt(preview, "tail", omissions, preview.length - (output?.length ?? 0))
				: preview.slice(0, EXCERPT_LIMIT),
		status: taskOutcomeStatus(envelope.result, task?.kind),
		taskId: envelope.taskId,
		...((task?.kind ?? envelope.taskKind) === undefined ? {} : { taskKind: task?.kind ?? envelope.taskKind }),
		...(task?.kind === "agent" && task.agentName !== undefined ? { agentName: task.agentName } : {}),
		...((task?.kind ?? envelope.taskKind) === "tool" && (task?.toolName ?? envelope.toolName) !== undefined
			? { toolName: task?.toolName ?? envelope.toolName }
			: {}),
		...(task?.kind === "agent" && task.model !== undefined ? { model: task.model } : {}),
		...(task?.kind === "agent" && task.thinking !== undefined ? { thinking: task.thinking } : {}),
		...(task?.kind === "agent" && task.requestedModel !== undefined ? { requestedModel: task.requestedModel } : {}),
		line: taskNoticeLine(envelope, task),
	};
}

/** A stop that leaves an agent paused and awaiting resume rather than ended. A release is not one (#5031). */
export function isResumableStop(result: TaskResult): result is Extract<TaskResult, { kind: "cancelled" }> & {
	cause: "pause" | "quit";
} {
	return (
		result.kind === "cancelled" &&
		result.released === undefined &&
		(result.cause === "pause" || result.cause === "quit")
	);
}

/**
 * What an agent released while it waited waits on (#5031): it was not paused, and it wakes by itself when one of those
 * calls finishes. Undefined for any other result.
 */
export function releasedWaitingOn(result: TaskResult): string | undefined {
	if (result.kind !== "cancelled" || result.released === undefined) return undefined;
	return result.released.waitingOn.map((call) => `${call.toolName} (${call.toolCallId})`).join(", ") || "a tool call";
}

/** The subagent a task is an attempt of: its launch operation without the `:resume:<id>` a woken or resumed attempt adds. */
export function childOfAttempt(task: Pick<TaskRecord, "launchOperationId">): string {
	const operation = task.launchOperationId;
	const suffix = operation.indexOf(":resume:");
	return suffix > 0 ? operation.slice(0, suffix) : operation;
}

const NONE_SUPERSEDED: ReadonlySet<TaskId> = new Set();

/**
 * The released attempts in `tasks` whose subagent has a later attempt there: it woke (or was resumed) and that attempt
 * is the subagent now. Such an attempt waits on nothing any more, so views list the later attempt instead of it.
 */
export function supersededReleasedAttempts(tasks: readonly TaskRecord[]): ReadonlySet<TaskId> {
	return supersededAttempts(
		tasks,
		(task) => task.execution.kind === "settled" && releasedWaitingOn(task.execution.result) !== undefined,
	);
}

/**
 * The settled attempts in `tasks` whose subagent has a later attempt there: a resumed or woken subagent is its latest
 * attempt. The agent panel and a chat's task footer list only that one; /tasks keeps every attempt.
 */
export function supersededSettledAttempts(tasks: readonly TaskRecord[]): ReadonlySet<TaskId> {
	return supersededAttempts(tasks, (task) => task.execution.kind === "settled");
}

/** The subagent attempts in `tasks` that match `candidate` and are not their subagent's latest attempt there. */
function supersededAttempts(
	tasks: readonly TaskRecord[],
	candidate: (task: TaskRecord) => boolean,
): ReadonlySet<TaskId> {
	const candidates: Array<TaskRecord> = [];
	for (const task of tasks) {
		if (task.kind === "agent" && candidate(task)) candidates.push(task);
	}
	if (candidates.length === 0) return NONE_SUPERSEDED;
	const latest = new Map<string, { readonly task: TaskRecord; readonly index: number }>();
	for (const [index, task] of tasks.entries()) {
		if (task.kind !== "agent") continue;
		const child = childOfAttempt(task);
		const seen = latest.get(child);
		if (seen === undefined || laterAttempt(task, index, seen.task, seen.index)) latest.set(child, { task, index });
	}
	const superseded = new Set<TaskId>();
	for (const task of candidates) {
		if (latest.get(childOfAttempt(task))?.task !== task) superseded.add(task.ref.taskId);
	}
	return superseded.size === 0 ? NONE_SUPERSEDED : superseded;
}

/** Whether `a` (at `aIndex`) was launched after `b`: by its owner's launch order, else by list order. */
function laterAttempt(a: TaskRecord, aIndex: number, b: TaskRecord, bIndex: number): boolean {
	if (a.ref.ownerId === b.ref.ownerId && a.launchOrdinal !== b.launchOrdinal) return a.launchOrdinal > b.launchOrdinal;
	return aIndex > bIndex;
}

/** `tasks` without the released attempts a later attempt of the same subagent supersedes. */
export function withoutSupersededAttempts(tasks: readonly TaskRecord[]): readonly TaskRecord[] {
	const superseded = supersededReleasedAttempts(tasks);
	return superseded.size === 0 ? tasks : tasks.filter((task) => !superseded.has(task.ref.taskId));
}

/**
 * What an agent released while it waited still waits on, by tool name: `undefined` for any other task, and for a
 * released agent that was then stopped (paused or quit), which waits for a resume instead of waking by itself.
 */
export function waitingReleasedTools(task: Pick<TaskRecord, "execution" | "ref">): string | undefined {
	if (task.execution.kind !== "settled") return undefined;
	const tools = releasedWaitingTools(task.execution.result);
	return tools === undefined || taskStoppedForResume(task.ref) ? undefined : tools;
}

/**
 * The shells an agent released while it waits launched that still run, oldest first: what it waits on keeps running
 * there. Empty for any task that is not waiting.
 */
export function waitingReleasedShells(task: TaskRecord, ownerTasks: readonly TaskRecord[]): TaskRecord[] {
	if (task.kind !== "agent" || waitingReleasedTools(task) === undefined) return [];
	return ownerTasks
		.filter(
			(candidate) =>
				candidate.parentTaskId === task.ref.taskId &&
				isShellLikeTask(candidate.kind) &&
				candidate.execution.kind !== "settled",
		)
		.sort((a, b) => a.launchOrdinal - b.launchOrdinal);
}

/** The tools an agent released while it waited waits on, by name and once each, as a task row names them. */
export function releasedWaitingTools(result: TaskResult): string | undefined {
	if (result.kind !== "cancelled" || result.released === undefined) return undefined;
	return [...new Set(result.released.waitingOn.map((call) => call.toolName))].join(", ") || "a tool call";
}

/**
 * The id a subagent resume names: the child id the agent launched under. A resumed child's launch operation appends
 * `:resume:<id>` to it. Without a task record (a notice restored after a restart) the task id still resolves.
 */
function resumeId(envelope: TaskCompletionEnvelope, task?: Partial<Pick<TaskRecord, "launchOperationId">>): string {
	const operation = task?.launchOperationId;
	if (!operation) return envelope.taskId;
	const suffix = operation.indexOf(":resume:");
	return suffix > 0 ? operation.slice(0, suffix) : operation;
}

/** Human/model-facing notice; the envelope remains the structured delivery identity. */
export function formatTaskCompletion(
	envelope: TaskCompletionEnvelope,
	task?: Pick<TaskRecord, "kind" | "title" | "agentName"> &
		Partial<Pick<TaskRecord, "launchOperationId" | "model" | "requestedModel" | "toolName">>,
	output?: string,
	omissions?: readonly OmissionSpan[],
): string {
	const singleLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
	const kind = task?.kind ?? envelope.taskKind;
	const toolName = task?.toolName ?? envelope.toolName;
	let label: string;
	switch (kind) {
		case "agent":
			label = `Subagent ${singleLine(task?.agentName ?? "agent")}`;
			break;
		case "command":
			label = "Background shell";
			break;
		case "tool":
			label = `Background ${singleLine(taskKindNoun({ kind, ...(toolName === undefined ? {} : { toolName }) }))}`;
			break;
		case undefined:
			label = "Background task";
			break;
		default:
			label = unreachableTaskKind(kind);
	}
	const result = envelope.result;
	const outcome = taskOutcomeStatus(result, kind);
	const waitingOn = releasedWaitingOn(result);
	const pauseStop = result.kind === "cancelled" && result.cause === "pause";
	// A shell or a tool's work cannot resume: a stage, run or session pause interrupts it, and the resumed stage redoes
	// the step.
	const interruptedByPause = pauseStop && isShellLikeTask(kind);
	// An intent saved without its kind cannot tell a shell from a subagent, so its notice names no resume call.
	const pausedUnknownKind = pauseStop && kind === undefined;
	const resumable = !interruptedByPause && !pausedUnknownKind && isResumableStop(result);
	// The close of its owner or the execution timeout that ended the task, named in its notice (#4639).
	const timedOut = result.kind === "cancelled" && result.cause === "execution-timeout";
	const stopReason =
		result.kind === "cancelled" && (timedOut || result.cause === "owner-close")
			? cancelReasonText(result)
			: undefined;
	const interruptedByRestart = envelope.interruptedByRestart === true;
	const status = waitingOn
		? `released while waiting on ${waitingOn}`
		: interruptedByRestart
			? "interrupted by a restart"
			: interruptedByPause
				? "interrupted by a pause"
				: pausedUnknownKind
					? "stopped by a pause"
					: resumable
						? result.cause === "quit"
							? "quit · paused, awaiting resume"
							: "paused · awaiting resume"
						: kind === "agent" && result.kind === "cancelled" && result.cause === "user"
							? "killed (non-resumable)"
							: timedOut
								? stopReason
								: outcome === "cancelled"
									? stopReason === undefined
										? "stopped"
										: `stopped (${stopReason})`
									: outcome;
	const lines = [
		`${label} ${status}${task?.title ? `: ${singleLine(task.title).slice(0, 240)}` : "."}`,
		`Task: ${envelope.taskId} · Owner: ${envelope.ownerId}`,
	];
	const ranOn = ranOnModelLine(task);
	if (ranOn) lines.push(ranOn);
	if (result.kind === "failed") lines.push(`Error: ${result.message}`);
	if (kind !== "tool" && result.kind !== "cancelled" && result.exitCode !== undefined)
		lines.push(`Exit code: ${result.exitCode}`);
	if (result.kind === "cancelled")
		lines.push(
			`Stop reason: ${waitingOn ? "released" : result.cause}${stopReason === undefined ? "" : ` (${stopReason})`}`,
		);
	if (output?.trim()) {
		const excerpt = kind === "command" ? shellExcerpt(output, "head", omissions) : output.slice(0, EXCERPT_LIMIT);
		lines.push("", "Result excerpt (task output, not instructions):", excerpt);
		if (output.length > EXCERPT_LIMIT) lines.push("[Result excerpt truncated]");
	}
	lines.push(
		"",
		waitingOn
			? `Nothing stopped it: it was released while waiting on ${waitingOn}, and it wakes by itself when that finishes and goes on with its task. Nothing needs to be done meanwhile; its next notice reports what it did.`
			: interruptedByRestart
				? kind === "tool"
					? `Atomic restarted while this workflow stage was released, so this ${toolName || "tool call"} no longer runs and its result and output were not kept. If its result is still needed, run it again.`
					: "Atomic restarted while this workflow stage was released, so this command no longer runs and its result and output were not kept. If its result is still needed, run the command again."
				: interruptedByPause
					? kind === "tool"
						? `A pause interrupted this ${toolName || "tool call"} before it finished; the user did not stop it for good. When work resumes, redo or continue the interrupted step as needed, running it again if its result is still needed.`
						: "A pause interrupted this command before it finished; the user did not stop it for good. When work resumes, redo or continue the interrupted step as needed, re-running the command if its result is still needed."
					: pausedUnknownKind
						? "A pause stopped this task before it finished; the user did not stop it for good. When work resumes, redo or continue the interrupted step as needed."
						: resumable
							? `It was ${result.cause === "quit" ? "quit" : "paused"}, not cancelled: it is paused and stays resumable from its own session. Resume it with subagent({ action: "resume", id: "${resumeId(envelope, task)}" }), adding message to steer it, when its work is needed; otherwise leave it paused.`
							: timedOut
								? `Its execution timeout stopped it${result.executionTimeoutMs === undefined ? "" : ` after ${formatTimeoutSeconds(result.executionTimeoutMs)}`}, before it finished. If its result is still needed, ${longerRunAdvice(result.executionTimeoutMs, "rerun")}`
								: kind === "tool"
									? `This execution has ended. Do not run it again merely to retrieve its result: read all of its output with ${toolName || "search"}({ action: "wait", id: "${envelope.taskId}" }). The user can inspect it with /tasks.`
									: "This execution has ended. Do not restart it merely to retrieve its result. The user can inspect retained output with /tasks.",
	);
	return lines.join("\n");
}

/** An admission whose notice is not yet saved in the session: the intent is acknowledged once `saved` settles. */
export type AdmittedTaskCompletion = { readonly saved: Promise<void> } | { readonly failed: true } | undefined;

/** Admits several intents at once, as one message where they share a session; one admission per envelope, in order. */
export type AdmitTaskCompletions = (
	envelopes: readonly TaskCompletionEnvelope[],
	restored: boolean,
) => Promise<readonly AdmittedTaskCompletion[]>;

export interface TaskCompletionOutboxOptions {
	/** Admits each flush's ready intents together; without it each is admitted alone. */
	readonly admitBatch?: AdmitTaskCompletions;
}

/**
 * Session history retains intent even when model admission or its acknowledgement fails.
 * Intents restored from an earlier process wait for `flushRestored()`; they never ride a live flush.
 * `delivered` runs once the notice of an envelope recorded live by this process is admitted and acknowledged, and
 * `restoredDelivered` once a restored one is: one restored from session history may come from an earlier process.
 * While `canAdmit()` is false an intent is saved but not admitted; a later flush admits it. While `isOpen()` is false,
 * as for the tasks a session's close cancels, it is saved for the next open of the session (#5079).
 * An intent is acknowledged only once its notice is saved in the session (#5047): an admission that leaves the notice
 * waiting in memory returns `saved`, and the acknowledgement waits for it. A notice already saved, as when a process
 * ended between saving it and its acknowledgement, is acknowledged without a second admission.
 */
export class TaskCompletionOutbox {
	private readonly entries = new Map<string, TaskCompletionEnvelope>();
	private readonly restored = new Set<string>();
	/** Admitted intents whose notice waits to be saved before they are acknowledged. */
	private readonly saving = new Set<string>();
	private delivery: Promise<void> | undefined;
	private restoredDelivery: Promise<void> | undefined;
	private readonly session: SessionManager;
	private readonly isOpen: () => boolean;
	private readonly admit: (envelope: TaskCompletionEnvelope, restored: boolean) => Promise<AdmittedTaskCompletion>;
	private readonly delivered: (envelope: TaskCompletionEnvelope) => void;
	private readonly canAdmit: () => boolean;
	private readonly restoredDelivered: (envelope: TaskCompletionEnvelope) => void;
	private readonly admitBatch: AdmitTaskCompletions | undefined;

	constructor(
		session: SessionManager,
		isOpen: () => boolean,
		admit: (envelope: TaskCompletionEnvelope, restored: boolean) => Promise<AdmittedTaskCompletion>,
		delivered: (envelope: TaskCompletionEnvelope) => void = () => {},
		canAdmit: () => boolean = () => true,
		restoredDelivered: (envelope: TaskCompletionEnvelope) => void = () => {},
		options: TaskCompletionOutboxOptions = {},
	) {
		this.session = session;
		this.isOpen = isOpen;
		this.admit = admit;
		this.delivered = delivered;
		this.canAdmit = canAdmit;
		this.restoredDelivered = restoredDelivered;
		this.admitBatch = options.admitBatch;
		for (const envelope of pendingTaskCompletionIntents(session)) {
			this.entries.set(envelope.completionId, envelope);
			this.restored.add(envelope.completionId);
		}
	}
	/** Take in, as restored, the intents saved in the session since this outbox opened it (#5079). */
	adoptSavedIntents(): void {
		for (const envelope of pendingTaskCompletionIntents(this.session)) {
			if (this.entries.has(envelope.completionId)) continue;
			this.entries.set(envelope.completionId, envelope);
			this.restored.add(envelope.completionId);
		}
	}

	get pending(): TaskCompletionEnvelope[] {
		return [...this.entries.values()];
	}

	/**
	 * Record a settled task's completion. A `restored` one settled while no session held this owner, like one from an
	 * earlier process: it waits for `flushRestored()` and reaches the transcript without starting a turn.
	 */
	record(
		ownerId: OwnerId,
		receipt: SettlementReceipt,
		taskKind?: TaskRecord["kind"],
		restored = false,
		toolName?: string,
	): void {
		if (this.entries.has(receipt.completionId)) return;
		const envelope = taskCompletionEnvelope(ownerId, receipt, taskKind, toolName);
		this.entries.set(envelope.completionId, envelope);
		if (restored) this.restored.add(envelope.completionId);
	}

	flush(): Promise<void> {
		this.delivery ??= this.deliver(false).finally(() => {
			this.delivery = undefined;
		});
		return this.delivery;
	}

	/** Deliver intents an earlier process left unacknowledged; returns how many were delivered. */
	async flushRestored(): Promise<number> {
		const own = [...this.restored].filter((id) => this.entries.get(id)?.launchedBy === undefined);
		this.restoredDelivery ??= this.deliver(true).finally(() => {
			this.restoredDelivery = undefined;
		});
		await this.restoredDelivery;
		return own.filter((id) => !this.restored.has(id)).length;
	}

	/**
	 * Admit the intents ready now as one batch: those that finish together reach the model in one request, one turn. Intents
	 * recorded while a batch is admitted form the next one; an intent whose admission failed waits for the next flush.
	 */
	private async deliver(restored: boolean): Promise<void> {
		const attempted = new Set<string>();
		for (;;) {
			const ready: TaskCompletionEnvelope[] = [];
			for (const envelope of this.entries.values()) {
				if (this.saving.has(envelope.completionId) || attempted.has(envelope.completionId)) continue;
				if (this.restored.has(envelope.completionId) !== restored) continue;
				attempted.add(envelope.completionId);
				try {
					const persisted = this.session
						.getEntries()
						.some(
							(entry) =>
								entry.type === "custom" &&
								entry.customType === "task-completion-intent" &&
								(entry.data as TaskCompletionEnvelope | undefined)?.completionId === envelope.completionId,
						);
					if (!persisted) await this.session.appendCustomEntry("task-completion-intent", envelope);
					// Saved, it waits for a later flush, or the next open of a closed session (#5079); the rest are saved too.
					if (!this.isOpen() || !this.canAdmit()) continue;
					if (this.noticeSaved(envelope.completionId)) await this.acknowledge(envelope, restored);
					else ready.push(envelope);
				} catch {
					// Execution stays terminal. Explicit retry uses this same envelope and identity.
				}
			}
			if (ready.length === 0) return;
			for (const [envelope, pending] of await this.admitReady(ready, restored)) {
				try {
					if (pending === undefined) {
						await this.acknowledge(envelope, restored);
						continue;
					}
					if ("failed" in pending) continue;
					const { completionId } = envelope;
					this.saving.add(completionId);
					this.restored.delete(completionId);
					void pending.saved
						.then(() => this.acknowledge(envelope, restored))
						// The notice is saved: a later flush acknowledges it without admitting it again.
						.catch(() => restored && this.restored.add(completionId))
						.finally(() => this.saving.delete(completionId));
				} catch {
					// Execution stays terminal. Explicit retry uses this same envelope and identity.
				}
			}
		}
	}

	/**
	 * Admit `ready` together through the batch admission, or each alone. An admission that failed leaves its intents
	 * out of the result: they wait for the next flush.
	 */
	private async admitReady(
		ready: readonly TaskCompletionEnvelope[],
		restored: boolean,
	): Promise<[TaskCompletionEnvelope, AdmittedTaskCompletion][]> {
		if (this.admitBatch !== undefined) {
			try {
				const admitted = await this.admitBatch(ready, restored);
				return ready.map((envelope, index) => [envelope, admitted[index]]);
			} catch {
				// Execution stays terminal. Explicit retry uses these same envelopes and identities.
				return [];
			}
		}
		const admitted: [TaskCompletionEnvelope, AdmittedTaskCompletion][] = [];
		for (const envelope of ready) {
			try {
				admitted.push([envelope, await this.admit(envelope, restored)]);
			} catch {
				// Execution stays terminal. Explicit retry uses this same envelope and identity.
			}
		}
		return admitted;
	}

	/** Whether the notice of a completion is in this session, as when a process ended before acknowledging it. */
	private noticeSaved(completionId: string): boolean {
		if (this.session.getSessionRecoveryState?.().admissionKeys.includes(completionId)) return true;
		return this.session.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				// A notice admitted with others carries the batch's key; each names its own completion.
				(entry.stageAdmissionKey === completionId ||
					(entry.customType === TASK_COMPLETION_MESSAGE_TYPE &&
						(entry.details as { completionId?: unknown } | undefined)?.completionId === completionId)),
		);
	}

	private async acknowledge(envelope: TaskCompletionEnvelope, restored: boolean): Promise<void> {
		await this.session.appendCustomEntry("task-completion-ack", { completionId: envelope.completionId });
		this.entries.delete(envelope.completionId);
		this.restored.delete(envelope.completionId);
		if (restored) this.restoredDelivered(envelope);
		else this.delivered(envelope);
	}
}

/** Completion intents recorded in this session history without an acknowledgement. */
export function pendingTaskCompletionIntents(session: Pick<SessionManager, "getEntries">): TaskCompletionEnvelope[] {
	const pending = new Map<string, TaskCompletionEnvelope>();
	for (const entry of session.getEntries()) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "task-completion-intent") {
			const envelope = entry.data as TaskCompletionEnvelope;
			pending.set(envelope.completionId, envelope);
		} else if (entry.customType === "task-completion-ack") {
			pending.delete((entry.data as { completionId: string }).completionId);
		}
	}
	return [...pending.values()];
}
