/**
 * One decision point for how a run-level outcome reads and which semantic
 * tone it takes, so notices, lists, detail views, headers and pickers do not
 * each keep an inline copy of "failed is red".
 *
 * A resume-eligible failure is a stop at a boundary someone chose or a
 * recoverable fault, not lost work, so it takes the warning tone and the
 * `resumable` cue. Terminal failures stay on the error tone. Stage and tool
 * nodes never route through here: a failed node is a real node failure even
 * when the run that contains it can resume.
 *
 * Presentation only. Eligibility is the two checks `/workflow resume` itself
 * runs, in its order: the authoritative {@link isWorkflowRunResumable} rule on
 * the run's resume candidate, then {@link resolveResumeStage} for a usable
 * restart point. Nothing here re-derives either from error strings or
 * specific caps, so a run that reads `failed · resumable` is one resume would
 * take; a run with no restart point (failed before its first stage, for
 * instance) stays red even though the engine's own flag says resumable.
 */
import type { DurableWorkflowBackend } from "../durable/backend.js";
import {
	isBudgetExceededStop,
	isResumableRunOutcome,
	RESUME_CUE_STATUSES,
	type RunResumeCandidateLookup,
} from "../durable/resume-outcome-eligibility.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { RunSnapshot, RunStatus } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";

export { isBudgetExceededStop, isResumableRunOutcome, type RunResumeCandidateLookup };

/** Semantic tone names already used by the notice card and theme role tokens. */
export type RunOutcomeTone = "success" | "warning" | "error" | "info" | "dim";

/** Separator used by every run-level label on these surfaces. */
export const RUN_LABEL_SEPARATOR = " · ";
/** The cue appended to a resume-eligible stop. */
export const RESUMABLE_CUE = "resumable";

export interface RunOutcomePresentationInput {
	/** Effective run status, or `crashed` for a durable row whose heartbeat went stale. */
	readonly status: RunStatus | "crashed";
	/** Result of the authoritative resume rule for this run; the caller decides how to probe. */
	readonly resumable: boolean;
	/** True only for the engine-owned `budget_exceeded` blocked rail. */
	readonly budgetExceeded?: boolean;
}

export interface RunOutcomePresentation {
	/** Bare status word, for surfaces that compose their own suffixes (`failed · 4m24s`). */
	readonly status: string;
	/** `resumable` when the cue applies, otherwise an empty string. */
	readonly cue: string;
	/** `status` joined with `cue` by {@link RUN_LABEL_SEPARATOR}, or `status` alone. */
	readonly label: string;
	readonly tone: RunOutcomeTone;
}

/**
 * Resolve the run-level label and tone for an outcome.
 *
 * Only `failed`, `blocked` and `crashed` can carry the cue. Every other status
 * keeps its existing word and tone: a run that is actively resuming is simply
 * `running` again, with no cue.
 */
export function runOutcomePresentation(input: RunOutcomePresentationInput): RunOutcomePresentation {
	const resumable = input.resumable && RESUME_CUE_STATUSES.has(input.status);
	const status = input.status === "blocked" && input.budgetExceeded === true ? "budget_exceeded" : input.status;
	const cue = resumable ? RESUMABLE_CUE : "";
	const label = cue === "" ? status : `${status}${RUN_LABEL_SEPARATOR}${cue}`;
	return { status, cue, label, tone: resumable ? "warning" : baseTone(input.status) };
}

function baseTone(status: RunOutcomePresentationInput["status"]): RunOutcomeTone {
	switch (status) {
		case "running":
		case "paused":
			return "warning";
		case "completed":
			return "success";
		case "failed":
		case "crashed":
		case "killed":
			return "error";
		default:
			return "dim";
	}
}

/** Map a semantic tone onto the theme's role colour. */
export function runOutcomeToneColor(tone: RunOutcomeTone, theme: GraphTheme): string {
	switch (tone) {
		case "success":
			return theme.success;
		case "warning":
			return theme.warning;
		case "error":
			return theme.error;
		case "info":
			return theme.info;
		default:
			return theme.dim;
	}
}

/** Convenience for surfaces that hold a full snapshot: probe, then present. */
export function runSnapshotOutcomePresentation(
	run: RunSnapshot,
	lookup?: RunResumeCandidateLookup,
	backend?: DurableWorkflowBackend | (() => DurableWorkflowBackend),
): RunOutcomePresentation {
	return runOutcomePresentation({
		status: effectiveRunStatus(run),
		resumable: isResumableRunOutcome(run, lookup, backend),
		budgetExceeded: isBudgetExceededStop(run),
	});
}
