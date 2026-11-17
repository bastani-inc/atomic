import { type SessionStartStep, sessionStartStepText } from "@bastani/atomic";
import { SUBAGENT_SESSION_START_TIMEOUT_MS } from "../inprocess/session-start-budget.js";

/** How many times a child's start is tried: once, and once more after a start that ran out of its budget. */
export const SUBAGENT_START_ATTEMPTS = 2;

/**
 * How long a send to a starting child waits for it to register on Intercom: through both of its start attempts and
 * the wait between them, with a margin. The launching session ends the wait sooner when the start fails.
 */
export function subagentStartHoldMs(sessionStartTimeoutMs: number | undefined): number {
	const budget = sessionStartTimeoutMs ?? SUBAGENT_SESSION_START_TIMEOUT_MS;
	return SUBAGENT_START_ATTEMPTS * budget + 2 * 60_000;
}

/** Where one attempt of a child's start is: its step, and when the attempt and that step began (`Date.now()` time). */
export interface SubagentStartAttemptProgress {
	readonly step: SessionStartStep;
	readonly startedAt: number;
	readonly stepStartedAt: number;
}

/** A child's start, across its attempts, until its first turn starts. */
export interface SubagentStartProgress extends SubagentStartAttemptProgress {
	/** 1 for the first attempt, 2 for its retry. */
	readonly attempt: number;
	/** When the child was launched; its first attempt's start. */
	readonly launchedAt: number;
	/** The earlier attempt that ran out of its budget, and the step it stalled in. */
	readonly stalled?: { readonly step: SessionStartStep; readonly afterMs: number };
	/** The stalled attempt has not released its session yet: the retry waits for it. */
	readonly awaitingRelease?: boolean;
}

/** What `subagent status` shows of a child that has not started its first turn. */
export interface SubagentStartStatus {
	readonly state: "starting" | "stalled";
	readonly step: SessionStartStep;
	readonly stepText: string;
	readonly attempt: number;
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly stepElapsedMs: number;
	readonly stalled?: { readonly step: SessionStartStep; readonly stepText: string; readonly afterMs: number };
	readonly summary: string;
}

const progressByTask = new Map<string, SubagentStartProgress>();

/** Record where a task's child is in its start; `undefined` once its first turn starts or the start is over. */
export function recordSubagentStartProgress(taskId: string, progress: SubagentStartProgress | undefined): void {
	if (progress === undefined) progressByTask.delete(taskId);
	else progressByTask.set(taskId, progress);
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** Describe a start, at `now`. A child that is starting is never reported as merely running. */
export function describeSubagentStart(progress: SubagentStartProgress, now = Date.now()): SubagentStartStatus {
	const elapsedMs = Math.max(0, now - progress.launchedAt);
	const stepElapsedMs = Math.max(0, now - progress.stepStartedAt);
	const stepText = sessionStartStepText(progress.step);
	const stalled =
		progress.stalled === undefined
			? undefined
			: {
					step: progress.stalled.step,
					stepText: sessionStartStepText(progress.stalled.step),
					afterMs: progress.stalled.afterMs,
				};
	const attempt = `attempt ${progress.attempt} of ${SUBAGENT_START_ATTEMPTS}`;
	const summary =
		stalled === undefined
			? `starting: ${stepText} for ${seconds(stepElapsedMs)} (${seconds(elapsedMs)} since launch, ${attempt}); it has not run a turn yet`
			: progress.awaitingRelease === true
				? `stalled: its start ran out of its budget ${stalled.stepText} after ${seconds(stalled.afterMs)}; the retry (${attempt}) waits for the stalled start to release its session (${seconds(elapsedMs)} since launch)`
				: `stalled, retrying: its first start ran out of its budget ${stalled.stepText} after ${seconds(stalled.afterMs)}; the retry is ${stepText} for ${seconds(stepElapsedMs)} (${seconds(elapsedMs)} since launch, ${attempt})`;
	return {
		state: stalled === undefined ? "starting" : "stalled",
		step: progress.step,
		stepText,
		attempt: progress.attempt,
		attempts: SUBAGENT_START_ATTEMPTS,
		elapsedMs,
		stepElapsedMs,
		...(stalled === undefined ? {} : { stalled }),
		summary,
	};
}

/** The start of a task's child, while it has not started its first turn in this process. */
export function subagentStartStatus(taskId: string, now = Date.now()): SubagentStartStatus | undefined {
	const progress = progressByTask.get(taskId);
	return progress === undefined ? undefined : describeSubagentStart(progress, now);
}

/** Starts recorded now; counted by tests and the benchmark. */
export function subagentStartProgressSize(): number {
	return progressByTask.size;
}
