import {
	appendRunEndWhenRecorded,
	reconcileTerminalRunResult,
	type SelectedRunFailureMetadata,
} from "../runs/foreground/executor-lifecycle.js";
import type { RunOpts, RunResult } from "../runs/foreground/executor-types.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowPersistencePort } from "../shared/types.js";

/** Record, persist, and return one ordinary terminal workflow failure. */
export function finalizeTerminalFailure(input: {
	readonly runId: string;
	readonly runSnapshot: RunSnapshot;
	readonly store: Store;
	readonly persistence?: WorkflowPersistencePort;
	readonly metadata: SelectedRunFailureMetadata & { readonly failedToolNodeId?: string };
	readonly onRunEnd: RunOpts["onRunEnd"];
}): RunResult {
	const { runId, runSnapshot, store, persistence, metadata, onRunEnd } = input;
	const failedToolNode =
		metadata.failedToolNodeId === undefined
			? undefined
			: runSnapshot.toolNodes?.find((node) => node.id === metadata.failedToolNodeId);
	const recorded = store.recordRunEnd(runId, "failed", undefined, metadata.errorMessage, metadata);
	appendRunEndWhenRecorded(persistence, recorded, {
		runId,
		status: "failed",
		error: metadata.errorMessage,
		failureKind: metadata.failureKind,
		...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
		...(metadata.failureRecoverability !== undefined
			? { failureRecoverability: metadata.failureRecoverability }
			: {}),
		...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
		failureMessage: metadata.failureMessage,
		...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
		...(metadata.failedToolNodeId !== undefined ? { failedToolNodeId: metadata.failedToolNodeId } : {}),
		...(failedToolNode !== undefined ? { failedToolNode } : {}),
		resumable: metadata.resumable,
		...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
		...(runSnapshot.endedAt !== undefined ? { endedAt: runSnapshot.endedAt } : {}),
		...(runSnapshot.durationMs !== undefined ? { durationMs: runSnapshot.durationMs } : {}),
		ts: Date.now(),
	});
	return reconcileTerminalRunResult(
		runId,
		runSnapshot,
		store,
		{ status: "failed", error: metadata.errorMessage },
		onRunEnd,
	);
}
