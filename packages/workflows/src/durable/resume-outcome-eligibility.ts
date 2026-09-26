/**
 * Whether a run's outcome is resume-eligible, for presentation.
 *
 * The two checks `/workflow resume` itself runs, in its order: the
 * authoritative rule in `resume-eligibility.ts` on the run's resume candidate,
 * then `resolveResumeStage` for a usable restart point. Kept apart from the
 * rule module because the candidate builder in shared/workflow-artifacts
 * imports that module, and apart from the TUI helper because the run detail
 * builder in runs/background stores this answer and must not depend on TUI
 * code. The persisted `resumable` field on snapshots is never rewritten from
 * here; this is a separate answer computed for display (#2565).
 */
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { RunSnapshot, StoreSnapshot } from "../shared/store-types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { DbosNotReadyError } from "./dbos-lifecycle.js";
import { getDurableBackend } from "./factory.js";
import { isWorkflowRunResumable, type WorkflowRunResumeCandidate } from "./resume-eligibility.js";
import { resolveResumeStage } from "./resume-restart-point.js";

/** Statuses whose outcome can carry the cue; every other status keeps its word and never pays for a probe. */
export const RESUME_CUE_STATUSES: ReadonlySet<RunSnapshot["status"] | "crashed"> = new Set([
	"failed",
	"blocked",
	"crashed",
]);

/** True only for the engine-owned `budget_exceeded` blocked rail, never an author-returned status. */
export function isBudgetExceededStop(run: Pick<RunSnapshot, "result" | "budgetState">): boolean {
	return run.result?.status === "budget_exceeded" && run.budgetState?.systemOwnedStop === true;
}

export type RunResumeCandidateLookup = (run: RunSnapshot) => WorkflowRunResumeCandidate;

/**
 * Whether a live snapshot's outcome is resume-eligible, for the cue.
 *
 * The candidate probe touches the durable backend and artifact paths, and the
 * restart-point check can walk tool checkpoints, so both run only when the
 * effective status could carry the cue; a running or completed run never pays
 * for either. Pickers that already cache candidates per store revision pass
 * their lookup through. The backend is fetched lazily and only for a tool
 * frontier; before it is ready the run gets the benefit of the doubt, the way
 * the candidate builder treats a checkpoint it cannot yet look up: not ready
 * is not "known to lack the state".
 */
export function isResumableRunOutcome(
	run: RunSnapshot,
	lookup: RunResumeCandidateLookup = workflowRunResumeCandidate,
	backend: DurableWorkflowBackend | (() => DurableWorkflowBackend) = getDurableBackend,
): boolean {
	const status = effectiveRunStatus(run);
	if (!RESUME_CUE_STATUSES.has(status)) return false;
	if (!isWorkflowRunResumable(lookup(run))) return false;
	try {
		return resolveResumeStage(run, backend).ok;
	} catch (error) {
		// A backend that has not started yet cannot prove a missing restart point,
		// so a not-ready backend keeps the benefit of the doubt, the way
		// `workflowRunResumeCandidate` already treats an unreachable checkpoint
		// lookup. Any other fault is different: it is not a state that clears on
		// the next repaint, and this runs inside `inspectRun`, which feeds
		// read-only surfaces (/workflow status, the workflow tool, durable
		// inspection) that must not fail because the durable backend did. Those
		// callers get the terminal reading instead of an exception (#2565 review).
		return error instanceof DbosNotReadyError;
	}
}

/** Whether a run's outcome carries the resumable cue, for one render pass. */
export type ResumableRunOutcomeLookup = (run: RunSnapshot) => boolean;

/**
 * Cache eligibility answers for one store revision.
 *
 * The two checks behind {@link isResumableRunOutcome} touch the filesystem (one
 * `existsSync` per referenced artifact owner) and the durable backend (a
 * checkpoint lookup, and for a tool frontier a walk over the run's
 * checkpoints). The surfaces that need them repaint far more often than the
 * store changes: the BACKGROUND widget repaints every second while anything
 * runs, and a picker repaints on every store change and every keystroke. So the
 * work is done once per run per store revision, exactly as
 * `createSessionPickerResumeCandidateCache` in `../tui/session-picker.ts` does
 * for the candidate probe it wraps.
 *
 * Invalidation is the store's own revision plus the identity of its runs array,
 * so a mutation that bumps neither cannot be observed here either.
 */
export function createResumableRunOutcomeCache(
	probe: RunResumeCandidateLookup = workflowRunResumeCandidate,
	backend: DurableWorkflowBackend | (() => DurableWorkflowBackend) = getDurableBackend,
): (snapshot: Pick<StoreSnapshot, "runs" | "version">) => ResumableRunOutcomeLookup {
	let cachedVersion: number | undefined;
	let cachedRuns: readonly RunSnapshot[] | undefined;
	let sourceRuns = new Map<string, RunSnapshot>();
	let answers = new Map<string, boolean>();

	return (snapshot: Pick<StoreSnapshot, "runs" | "version">): ResumableRunOutcomeLookup => {
		if (cachedVersion !== snapshot.version || cachedRuns !== snapshot.runs) {
			cachedVersion = snapshot.version;
			cachedRuns = snapshot.runs;
			sourceRuns = new Map(snapshot.runs.map((run) => [run.id, run]));
			answers = new Map();
		}
		return (run: RunSnapshot): boolean => {
			const cached = answers.get(run.id);
			if (cached !== undefined) return cached;
			const answer = isResumableRunOutcome(sourceRuns.get(run.id) ?? run, probe, backend);
			answers.set(run.id, answer);
			return answer;
		};
	};
}

/**
 * Eligibility per run id, for a payload that will be persisted and re-rendered
 * without a store. Mirrors `resolveRunIndicatorStatuses` in
 * `../shared/run-indicator-status.ts`, which solves the same problem for prompt
 * attribution: decide while the store is in hand, carry the answer.
 */
export function resolveResumeEligibility(
	runs: readonly RunSnapshot[],
	resumable: ResumableRunOutcomeLookup = (run) => isResumableRunOutcome(run),
): Readonly<Record<string, boolean>> {
	const eligibility: Record<string, boolean> = {};
	for (const run of runs) eligibility[run.id] = resumable(run);
	return eligibility;
}
