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

import type { DurableWorkflowBackend } from "../durable/backend.js";
import { recordRunResultCheckpointAsync } from "../durable/run-result.js";
import { recordRunTimingCheckpointAsync } from "../durable/run-timing.js";
import type { DurableWorkflowStatus } from "../durable/types.js";
import { describeErrorWithCauses } from "../shared/error-with-causes.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";

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
		throw error;
	}
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
