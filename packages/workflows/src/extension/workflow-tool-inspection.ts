import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { expandWorkflowGraph } from "../shared/expanded-workflow-graph.js";
import { type Store, store } from "../shared/store.js";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import {
	cloneStage,
	type MessageLike,
	shapeTranscriptResult,
	shouldIncludeSnapshotToolOutput,
	snapshotTranscriptEntries,
	snapshotTranscriptEntryCount,
	summarizeStage,
	transcriptEntryFromMessage,
} from "./workflow-stage-results.js";
import { resolveToolRunTarget, resolveToolStageTarget } from "./workflow-targets.js";

export interface WorkflowInspectionSource {
	readonly store?: Store;
	readonly allowLiveHandles?: boolean;
}

export function workflowStagesResult(args: WorkflowToolArgs, source?: WorkflowInspectionSource): WorkflowToolResult {
	const activeStore = source?.store ?? store;
	const target = resolveToolRunTarget(args, "No active run to inspect.", activeStore);
	const filter = args.statusFilter ?? "all";
	if (target.kind === "all") {
		return {
			action: "stages",
			runId: "--all",
			filter,
			stages: [],
			error: "Stage listing requires a single run.",
		};
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		return {
			action: "stages",
			runId: target.target,
			filter,
			stages: [],
			error: target.message,
		};
	}
	const stageSnapshots =
		source?.store === undefined
			? (activeStore.runs().find((run) => run.id === target.runId)?.stages ?? [])
			: expandWorkflowGraph(readGraphStoreSnapshot(activeStore), target.runId).stages;
	const stages = stageSnapshots.filter((stage) => filter === "all" || stage.status === filter).map(summarizeStage);
	return { action: "stages", runId: target.runId, filter, stages };
}

export function workflowStageResult(args: WorkflowToolArgs, source?: WorkflowInspectionSource): WorkflowToolResult {
	const activeStore = source?.store ?? store;
	const target = resolveToolRunTarget(args, "No active run to inspect.", activeStore);
	if (target.kind === "all") {
		return { action: "stage", runId: "--all", error: "Stage inspection requires a single run." };
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		return { action: "stage", runId: target.target, error: target.message };
	}
	const stage = resolveToolStageTarget(target.runId, args.stageId, activeStore);
	if (!stage.ok || stage.stageId === undefined) {
		return {
			action: "stage",
			runId: target.runId,
			error: stage.ok ? "Stage id or name is required." : stage.message,
		};
	}
	const stageRunId = stage.runId ?? target.runId;
	const run = activeStore.runs().find((r) => r.id === stageRunId);
	const snapshot = run?.stages.find((s) => s.id === stage.stageId);
	return snapshot
		? { action: "stage", runId: stageRunId, stage: cloneStage(snapshot) }
		: {
				action: "stage",
				runId: stageRunId,
				error: `Stage not found in run ${stageRunId}: ${stage.stageId}`,
			};
}

export function workflowTranscriptResult(
	args: WorkflowToolArgs,
	source?: WorkflowInspectionSource,
): WorkflowToolResult {
	const activeStore = source?.store ?? store;
	const target = resolveToolRunTarget(args, "No active run to inspect.", activeStore);
	if (target.kind === "all") {
		return {
			action: "transcript",
			runId: "--all",
			stageId: "",
			source: "error",
			entries: [],
			truncated: false,
		};
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		return {
			action: "transcript",
			runId: target.target,
			stageId: "",
			source: "error",
			entries: [{ role: "notice", text: target.message }],
			truncated: false,
		};
	}
	const stage = resolveToolStageTarget(target.runId, args.stageId, activeStore);
	if (!stage.ok || stage.stageId === undefined) {
		return {
			action: "transcript",
			runId: target.runId,
			stageId: "",
			source: "error",
			entries: [{ role: "notice", text: stage.ok ? "Stage id or name is required." : stage.message }],
			truncated: false,
		};
	}
	const stageRunId = stage.runId ?? target.runId;
	const run = activeStore.runs().find((r) => r.id === stageRunId);
	const snapshot = run?.stages.find((s) => s.id === stage.stageId);
	const liveHandle =
		source?.allowLiveHandles === false ? undefined : stageControlRegistry.get(stageRunId, stage.stageId);
	if (liveHandle !== undefined) {
		const sessionFile = liveHandle.sessionFile ?? snapshot?.sessionFile;
		const sessionId = liveHandle.sessionId ?? snapshot?.sessionId;
		return shapeTranscriptResult({
			runId: stageRunId,
			stageId: stage.stageId,
			source: "live",
			entryCount: liveHandle.messages.length,
			buildEntries: () => liveHandle.messages.map((m) => transcriptEntryFromMessage(m as MessageLike)),
			args,
			sessionId,
			sessionFile,
			transcriptPath: sessionFile,
		});
	}
	const snapshotSessionFile = snapshot?.sessionFile;
	const includeSnapshotOutput = shouldIncludeSnapshotToolOutput(args, snapshotSessionFile);
	return shapeTranscriptResult({
		runId: stageRunId,
		stageId: stage.stageId,
		source: "snapshot",
		entryCount: snapshotTranscriptEntryCount(snapshot),
		buildEntries: () => snapshotTranscriptEntries(snapshot, includeSnapshotOutput),
		args,
		sessionId: snapshot?.sessionId,
		sessionFile: snapshotSessionFile,
		transcriptPath: snapshotSessionFile,
	});
}
