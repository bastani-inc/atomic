/**
 * Durable terminal-status finalization for workflow runs.
 *
 * Extracted from `run()` to keep the engine entrypoint under the file-length
 * gate. Persists the final durable status (cancelled/blocked/skipped/failed/
 * killed) for cross-session resume discovery when the run did not complete
 * normally. Normal completion is committed in the run try-block; this covers it
 * only when that commit did not land (#3811), so a journal that failed once
 * never keeps a completed run `running`.
 *
 * cross-ref: issue #1498.
 */

import { checkpointAttempt, durableWorkflowAttempt } from "../durable/attempt-identity.js";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { recordRunResultCheckpointAsync } from "../durable/run-result.js";
import { recordRunTimingCheckpointAsync } from "../durable/run-timing.js";
import type { DurableWorkflowStatus } from "../durable/types.js";
import { describeErrorWithCauses } from "../shared/error-with-causes.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { infrastructureFaultOf } from "../shared/workflow-infrastructure-error.js";

export interface DurableTerminalFinalizeInput {
	readonly runId: string;
	readonly runSnapshot: RunSnapshot;
	readonly isRoot: boolean;
	readonly durableBackend: DurableWorkflowBackend;
	/**
	 * Whether the run's own completion path committed the terminal status durably. `false` makes a completed
	 * run commit it here; leaving it out trusts the caller, as before.
	 */
	readonly terminalStatusCommitted?: boolean;
	/** Where a failure to record the ending is reported, as a notice, before it is rethrown. */
	readonly store?: Store;
}

export async function finalizeDurableTerminalStatus(input: DurableTerminalFinalizeInput): Promise<void> {
	try {
		await commitDurableTerminalStatus(input);
	} catch (error) {
		if (input.store !== undefined) recordDurableEndingFailure(input.store, input.runSnapshot, error);
		if (infrastructureFaultOf(error) === "storage_unavailable") retryDurableTerminalStatus(input);
		throw error;
	}
}

/** Waits before each later write of a terminal status the store refused (#5133). */
const TERMINAL_STATUS_RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

/**
 * Write a terminal status the store refused again, later, while the process lives (#5133). The run's records already
 * say how it ended where they can (a completed run reads as completed); this brings its handle in line for every reader
 * of the journal. A write the store still refuses, or that another writer now owns, is left as it is.
 */
function retryDurableTerminalStatus(
	input: DurableTerminalFinalizeInput,
	attempt = 0,
	runAttempt = input.durableBackend.workflowAttempt?.(input.runId) ?? 0,
): void {
	const delay = TERMINAL_STATUS_RETRY_DELAYS_MS[attempt];
	if (delay === undefined) return;
	const timer = setTimeout(() => {
		// Not once the run has gone on: a resume has begun another attempt, or another writer ended it.
		const current = input.durableBackend.getWorkflow(input.runId);
		if (
			current === undefined ||
			(input.durableBackend.workflowAttempt?.(input.runId) ?? 0) !== runAttempt ||
			(current.status !== "running" && current.status !== toDurableStatus(input.runSnapshot.status))
		)
			return;
		commitDurableTerminalStatus({ ...input, terminalStatusCommitted: false }).catch((error: unknown) => {
			if (infrastructureFaultOf(error) === "storage_unavailable")
				retryDurableTerminalStatus(input, attempt + 1, runAttempt);
		});
	}, delay);
	timer.unref?.();
}

async function commitDurableTerminalStatus(input: DurableTerminalFinalizeInput): Promise<void> {
	if (!input.isRoot) return;
	const status = effectiveRunStatus(input.runSnapshot);
	const isExitTerminal = input.runSnapshot.exited === true && status !== "running";
	const isBlocked =
		status === "blocked" && (input.runSnapshot.endedAt !== undefined || input.runSnapshot.blockedAt !== undefined);
	const isUncommittedCompletion = status === "completed" && input.terminalStatusCommitted === false;
	if (status !== "failed" && status !== "killed" && !isExitTerminal && !isBlocked && !isUncommittedCompletion) return;

	const durableStatus = toDurableStatus(status);
	if (durableStatus !== undefined) {
		try {
			await recordRunResultCheckpointAsync(input.durableBackend, input.runSnapshot);
		} catch (error) {
			// Clearing an earlier attempt's outputs is best-effort; a journal that cannot be read
			// must not stop the run from reaching its terminal status.
			if (input.runSnapshot.result !== undefined) throw error;
		}
		// Failed/blocked runs may be resumed cross-session by workflow id; persist
		// the exact accumulated elapsed so the resumed dashboard total continues
		// from the prior sessions instead of restarting at zero.
		if (durableStatus === "failed" || durableStatus === "blocked" || isUncommittedCompletion) {
			await recordRunTimingCheckpointAsync(input.durableBackend, input.runSnapshot);
		}
		const failure =
			durableStatus === "failed"
				? {
						...(input.runSnapshot.error !== undefined ? { error: input.runSnapshot.error } : {}),
						...(input.runSnapshot.exited === true
							? {
									exited: true,
									...(input.runSnapshot.exitReason !== undefined
										? { exitReason: input.runSnapshot.exitReason }
										: {}),
								}
							: {}),
						...(input.runSnapshot.failureKind !== undefined
							? { failureKind: input.runSnapshot.failureKind }
							: {}),
						...(input.runSnapshot.failureCode !== undefined
							? { failureCode: input.runSnapshot.failureCode }
							: {}),
						...(input.runSnapshot.failureRecoverability !== undefined
							? { failureRecoverability: input.runSnapshot.failureRecoverability }
							: {}),
						...(input.runSnapshot.failureDisposition !== undefined
							? { failureDisposition: input.runSnapshot.failureDisposition }
							: {}),
						...(input.runSnapshot.failedToolNodeId !== undefined
							? { failedToolNodeId: input.runSnapshot.failedToolNodeId }
							: {}),
						...(failedToolUnrecorded(input) ? { failedToolUnrecorded: true as const } : {}),
					}
				: undefined;
		await input.durableBackend.commitWorkflowStatus(
			input.runId,
			durableStatus,
			undefined,
			input.runSnapshot.resumable,
			failure,
		);
	}
}

/**
 * Whether the failed tool the run ends naming has no record of its failure from this attempt: the store refused it, and
 * its rewrite as the run ended (#5027). The run's own failure says so, in the same write, so a resume runs the tool again
 * rather than finding no frontier.
 */
function failedToolUnrecorded(input: DurableTerminalFinalizeInput): boolean {
	const nodeId = input.runSnapshot.failedToolNodeId;
	if (nodeId === undefined) return false;
	const attempt = durableWorkflowAttempt(input.durableBackend, input.runId) ?? 0;
	return !input.durableBackend
		.listCheckpoints(input.runId)
		.some(
			(checkpoint) =>
				checkpoint.kind === "tool" &&
				checkpoint.topology?.nodeId === nodeId &&
				checkpointAttempt(checkpoint) === attempt,
		);
}

/**
 * The run's memory already says it ended, so a durable ending that could not be recorded leaves the journal
 * saying `running` with nobody holding the lease. Say so where the host can see it.
 */
function recordDurableEndingFailure(store: Store, runSnapshot: RunSnapshot, error: unknown): void {
	const detail = describeErrorWithCauses(error);
	store.recordNotice({
		id: `workflow-durable-ending-failed:${runSnapshot.id}`,
		runId: runSnapshot.id,
		level: "error",
		message: `Workflow "${runSnapshot.name}" ended ${runSnapshot.status}, but its final state could not be saved to the workflow journal: ${detail}. Readers of the journal may report it as crashed.`,
		createdAt: Date.now(),
	});
}

function toDurableStatus(status: RunSnapshot["status"]): DurableWorkflowStatus | undefined {
	switch (status) {
		case "completed":
		case "skipped":
			return "completed";
		case "cancelled":
		case "killed":
			return "cancelled";
		case "failed":
			return "failed";
		case "blocked":
			return "blocked";
		default:
			return undefined;
	}
}
