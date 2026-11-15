/**
 * Durable run-level elapsed-time checkpoints.
 *
 * Persists the total accumulated elapsed time of a top-level workflow run so a
 * durable `/workflow resume` can seed the new `RunSnapshot` with the prior
 * elapsed time — the main-chat dashboard total then reports prior + current
 * elapsed instead of restarting at zero.
 *
 * Storage shape: a reserved tool-kind checkpoint (name/argsHash
 * `workflow-run-timing`). Tool checkpoints are ignored by stage-graph
 * reconstruction, so no
 * phantom stages appear in durable inspection. Repeated updates use distinct
 * checkpoint ids; the latest record (by `completedAt`) wins on hydration
 * because the in-memory mirror replays checkpoints in completion order.
 *
 * cross-ref: packages/workflows/src/shared/timing.ts elapsedRunMs
 */

import { restoreBudgetState } from "../shared/persistence-restore-helpers.js";
import type { RunBudgetAccountingState, RunSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./durable-hash.js";
import type { DurableToolCheckpoint } from "./types.js";

/** Reserved checkpoint names AND args-hashes for run-level meter records. */
export const RUN_TIMING_CHECKPOINT_NAME = "workflow-run-timing";
export const RUN_USAGE_CHECKPOINT_NAME = "workflow-run-usage";

/**
 * Debounce granularity for run-timing updates, matching the stage-session
 * duration bucket so piggybacked writes never outpace stage checkpoints.
 */
export const RUN_TIMING_DURATION_BUCKET_MS = 30_000;

function timingBucket(elapsedMs: number): number {
	return Math.floor(elapsedMs / RUN_TIMING_DURATION_BUCKET_MS);
}

/** Prior accumulated run elapsed recorded durably, or undefined when absent. */
export function priorRunElapsedMs(backend: DurableWorkflowBackend, workflowId: string): number | undefined {
	const output = backend.getToolOutput(workflowId, RUN_TIMING_CHECKPOINT_NAME);
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	const elapsedMs = (output as Record<string, unknown>).elapsedMs;
	if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
	return elapsedMs;
}

/** Prior token/cost accounting recorded durably, or undefined when absent/malformed. */
export function priorRunAccounting(
	backend: DurableWorkflowBackend,
	workflowId: string,
): RunBudgetAccountingState | undefined {
	let latest = accountingOf(backend.getToolOutput(workflowId, RUN_USAGE_CHECKPOINT_NAME));
	// A child records its root's accounting with its own, in one write, so a crash between them loses neither (#5053).
	// Charges only grow, so the largest record is the latest.
	for (const checkpoint of backend.listCheckpoints(workflowId)) {
		if (checkpoint.kind !== "tool" || !isChildRunUsageCheckpointName(checkpoint.argsHash)) continue;
		const output = checkpoint.output as { readonly rootAccounting?: unknown } | undefined;
		const root = accountingOf({ accounting: output?.rootAccounting });
		if (root !== undefined && (latest === undefined || chargedMore(root, latest))) latest = root;
	}
	return latest;
}

function chargedMore(left: RunBudgetAccountingState, right: RunBudgetAccountingState): boolean {
	return left.tokens > right.tokens || (left.tokens === right.tokens && left.cost > right.cost);
}

function accountingOf(output: unknown): RunBudgetAccountingState | undefined {
	if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
	return restoreBudgetState({ accounting: (output as Record<string, unknown>).accounting })?.accounting;
}
/**
 * Record the run's current total elapsed time (prior + this session) durably.
 *
 * Skipped when the workflow has no durable progress yet (a timing record with
 * nothing to resume would only manufacture resumability), when the elapsed
 * value did not grow past the last record, or — with `debounce` — while the
 * value stays inside the last 30 s bucket. Usage shares only the progress guard.
 */
export async function recordRunTimingCheckpointAsync(
	backend: DurableWorkflowBackend,
	run: RunSnapshot,
	options?: { readonly debounce?: boolean; readonly now?: number },
): Promise<boolean> {
	const checkpoints = [runTimingCheckpoint(backend, run, options), runUsageCheckpoint(backend, run, options?.now)];
	if (checkpoints.every((checkpoint) => checkpoint === undefined)) return false;
	for (const checkpoint of checkpoints) if (checkpoint !== undefined) await backend.commitCheckpoint(checkpoint);
	return true;
}

/** Record only the run's budget accounting durably, when it changed. */
export async function recordRunUsageCheckpointAsync(backend: DurableWorkflowBackend, run: RunSnapshot): Promise<void> {
	const checkpoint = runUsageCheckpoint(backend, run);
	if (checkpoint !== undefined) await backend.commitCheckpoint(checkpoint);
}

/** Prefix of the root-level record of one child workflow's own budget accounting (#5053). */
const CHILD_RUN_USAGE_PREFIX = `${RUN_USAGE_CHECKPOINT_NAME}:child:`;

/** Whether a reserved run-level tool checkpoint records a child workflow's accounting. */
export function isChildRunUsageCheckpointName(name: string): boolean {
	return name.startsWith(CHILD_RUN_USAGE_PREFIX);
}

/** A child workflow's own accounting, recorded on its root run, or undefined when absent/malformed. */
export function priorChildRunAccounting(
	rootBackend: DurableWorkflowBackend,
	rootRunId: string,
	childRunId: string,
): RunBudgetAccountingState | undefined {
	return accountingOf(rootBackend.getToolOutput(rootRunId, CHILD_RUN_USAGE_PREFIX + childRunId));
}

/**
 * Record a child workflow's own budget accounting, and its root's, on the root run when either changed. The root
 * records its own only at its own stages, so this keeps both durable while the child runs. The record lives in the root's
 * scope as a run-level record, so the child's own checkpoints, and the completed subtree a resume replays, are
 * unchanged by it; a resume after any crash continues the child's budget from it (#5053).
 */
export async function recordChildRunUsageCheckpointAsync(
	rootBackend: DurableWorkflowBackend,
	root: RunSnapshot,
	child: RunSnapshot,
): Promise<void> {
	const accounting = child.budgetState?.accounting;
	const rootRunId = root.id;
	if (accounting === undefined || rootBackend.listCheckpoints(rootRunId).length === 0) return;
	const rootAccounting = root.budgetState?.accounting;
	const name = CHILD_RUN_USAGE_PREFIX + child.id;
	const checkpointId = `run-usage:child:${durableHash({ child: child.id, accounting, rootAccounting: rootAccounting ?? null })}`;
	if (rootBackend.getToolCheckpoint(rootRunId, name)?.checkpointId === checkpointId) return;
	await rootBackend.commitCheckpoint({
		kind: "tool",
		workflowId: rootRunId,
		checkpointId,
		name,
		argsHash: name,
		output: rootAccounting === undefined ? { accounting } : { accounting, rootAccounting },
		completedAt: Date.now(),
	});
}

function runTimingCheckpoint(
	backend: DurableWorkflowBackend,
	run: RunSnapshot,
	options?: { readonly debounce?: boolean; readonly now?: number },
): DurableToolCheckpoint | undefined {
	const now = options?.now ?? Date.now();
	const elapsedMs = elapsedRunMs(run, now);
	if (elapsedMs <= 0) return undefined;
	if (backend.listCheckpoints(run.id).length === 0) return undefined;
	const recorded = priorRunElapsedMs(backend, run.id);
	if (recorded !== undefined) {
		if (elapsedMs <= recorded) return undefined;
		if (options?.debounce === true && timingBucket(elapsedMs) === timingBucket(recorded)) return undefined;
	}
	return {
		kind: "tool",
		workflowId: run.id,
		checkpointId: `run-timing:${elapsedMs}`,
		name: RUN_TIMING_CHECKPOINT_NAME,
		argsHash: RUN_TIMING_CHECKPOINT_NAME,
		output: { elapsedMs },
		completedAt: now,
	};
}
function runUsageCheckpoint(
	backend: DurableWorkflowBackend,
	run: RunSnapshot,
	now = Date.now(),
): DurableToolCheckpoint | undefined {
	const accounting = run.budgetState?.accounting;
	if (accounting === undefined || backend.listCheckpoints(run.id).length === 0) return undefined;
	const checkpointId = `run-usage:${durableHash({ accounting })}`;
	if (backend.getToolCheckpoint(run.id, RUN_USAGE_CHECKPOINT_NAME)?.checkpointId === checkpointId) return undefined;
	return {
		kind: "tool",
		workflowId: run.id,
		checkpointId,
		name: RUN_USAGE_CHECKPOINT_NAME,
		argsHash: RUN_USAGE_CHECKPOINT_NAME,
		output: { accounting },
		completedAt: now,
	};
}

/**
 * Elapsed time a freshly-created run inherits from its predecessor:
 * continuation resumes measure the live source snapshot; durable re-dispatch
 * resumes (same run id, no continuation) read the persisted timing record.
 */
export function inheritedRunElapsedMs(input: {
	readonly backend: DurableWorkflowBackend;
	readonly runId: string;
	readonly continuationSource?: RunSnapshot;
	readonly now?: number;
}): number | undefined {
	const now = input.now ?? Date.now();
	const source = input.continuationSource;
	const inherited =
		source !== undefined
			? elapsedRunMs(source, source.endedAt ?? now)
			: priorRunElapsedMs(input.backend, input.runId);
	return inherited !== undefined && inherited > 0 ? inherited : undefined;
}
