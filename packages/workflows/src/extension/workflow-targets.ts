import { getEnvValue, WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import {
	type ExpandedWorkflowStage,
	expandedStageLabel,
	expandWorkflowGraph,
	stageMatchesExpandedIdentifier,
} from "../shared/expanded-workflow-graph.js";
import {
	isFullRunId,
	isResolvedRunId,
	isRunIdPrefix,
	malformedRunIdMessage,
	RUN_ID_LENGTH,
	RUN_ID_PREFIX_LENGTH,
	resolveRunIdTarget,
} from "../shared/run-id.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { type Store, store } from "../shared/store.js";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import type { RunStatus } from "../shared/store-types.js";
import type { OverlayPiSurface } from "../tui/overlay-adapter.js";
import type { PiExecuteContext, WorkflowToolArgs } from "./public-types.js";
import type { PiUISurface } from "./wiring.js";

export function formatAlreadyEndedRetainedMessage(runId: string): string {
	return `Run ${runId} already ended; retained for inspection.`;
}

export function stageFailureMessage(runId: string, resultReason: string, action: "pause"): string {
	switch (resultReason) {
		case "not_found":
			return `Run not found: ${runId}`;
		case "already_ended":
			return `Run already ended: ${runId}`;
		case "stage_not_found":
			return `Stage not found for run: ${runId}`;
		default:
			return `No active stages to ${action} for run: ${runId}`;
	}
}

export function inFlightRunCount(): number {
	return topLevelWorkflowRuns(store.runs()).filter((run) => run.endedAt === undefined).length;
}

export function topLevelExpandedSnapshots() {
	const snapshot = store.snapshot();
	return topLevelWorkflowRuns(snapshot.runs).map((run) => {
		const graph = expandWorkflowGraph(snapshot, run.id);
		return {
			...structuredClone(run),
			stages: graph.stages.map((stage) => structuredClone(stage)),
			toolNodes: graph.tools.map((tool) => structuredClone(tool)),
		};
	});
}

export function allStageConflictMessage(action: "pause" | "quit"): string {
	return `Cannot ${action} --all with a stageId; omit stageId or target a single run.`;
}

export function reloadFailureMessage(error: unknown): string {
	return `Reload failed: ${error instanceof Error ? error.message : String(error)}`;
}

function hasWorkflowStageSubagentGuardEnv(): boolean {
	return getEnvValue(WORKFLOW_STAGE_SUBAGENT_GUARD_ENV) === "1";
}

export function isWorkflowStageToolContext(ctx: PiExecuteContext): boolean {
	return hasWorkflowStageSubagentGuardEnv() || ctx.orchestrationContext?.kind === "workflow-stage";
}

export function isRunStatus(value: string): value is RunStatus {
	switch (value) {
		case "pending":
		case "running":
		case "paused":
		case "completed":
		case "skipped":
		case "cancelled":
		case "blocked":
		case "failed":
		case "killed":
			return true;
		default:
			return false;
	}
}

export { isFullRunId, isResolvedRunId, malformedRunIdMessage, RUN_ID_LENGTH, RUN_ID_PREFIX_LENGTH };

export type RunIdResolution = ReturnType<typeof resolveRunIdTarget>;

export function resolveRunId(target: string, activeStore: Store = store): RunIdResolution {
	return resolveRunIdTarget(
		target,
		activeStore.runs().map((run) => run.id),
	);
}

export type ToolRunTarget =
	| { kind: "all" }
	| { kind: "run"; runId: string }
	| { kind: "malformed"; target: string; message: string }
	| { kind: "not_found"; target: string; message: string };

export function resolveToolRunTarget(
	args: WorkflowToolArgs,
	emptyMessage: string,
	activeStore: Store = store,
): ToolRunTarget {
	const rawTarget = args.runId?.trim() ?? "";
	if (args.all === true || rawTarget === "--all") return { kind: "all" };
	const target = rawTarget || activeStore.activeRunId() || "";
	if (!target) return { kind: "not_found", target: rawTarget, message: emptyMessage };
	const resolved = resolveRunId(target, activeStore);
	if (isResolvedRunId(resolved)) return { kind: "run", runId: resolved.runId };
	if (resolved.kind === "malformed" || resolved.kind === "ambiguous") {
		return { kind: "malformed", target, message: resolved.message };
	}
	return { kind: "not_found", target, message: `Run not found: ${target}` };
}

export type ToolStageTarget = { ok: true; runId?: string; stageId?: string } | { ok: false; message: string };

export function resolveStageTarget(runId: string, stageTarget?: string, activeStore: Store = store): ToolStageTarget {
	const target = stageTarget?.trim();
	if (!target) return { ok: true, runId };
	const graph = expandWorkflowGraph(readGraphStoreSnapshot(activeStore), runId);
	const exactVirtualIds = graph.stages.filter((stage) => stage.id === target);
	if (exactVirtualIds.length === 1) return resolvedStageTarget(exactVirtualIds[0]!);
	if (exactVirtualIds.length > 1) return ambiguousStageTarget(target, exactVirtualIds);
	const exactLocalIds = graph.stages.filter((stage) => stage.workflowGraphTarget.stageId === target);
	if (exactLocalIds.length === 1) return resolvedStageTarget(exactLocalIds[0]!);
	if (exactLocalIds.length > 1) return ambiguousStageTarget(target, exactLocalIds);
	const exactNames = graph.stages.filter((stage) => stage.name === target);
	if (exactNames.length === 1) return resolvedStageTarget(exactNames[0]!);
	if (exactNames.length > 1) return ambiguousStageTarget(target, exactNames);
	const uuidMatches = matchingUuidStages(graph.stages, target);
	if (uuidMatches.length === 1) return resolvedStageTarget(uuidMatches[0]!);
	if (uuidMatches.length > 1) return ambiguousUuidStageTarget(target, uuidMatches);
	const matches = graph.stages.filter((stage) => stageMatchesExpandedIdentifier(stage, target));
	if (matches.length === 0) return { ok: false, message: `Stage not found in run ${runId}: ${target}` };
	if (matches.length > 1) return ambiguousStageTarget(target, matches);
	return resolvedStageTarget(matches[0]!);
}

function resolvedStageTarget(stage: ExpandedWorkflowStage): ToolStageTarget {
	return {
		ok: true,
		runId: stage.workflowGraphTarget.runId,
		stageId: stage.workflowGraphTarget.stageId,
	};
}

function matchingUuidStages(stages: readonly ExpandedWorkflowStage[], target: string): ExpandedWorkflowStage[] {
	if (!isRunIdPrefix(target)) return [];
	return stages.filter((stage) => {
		const id = stage.workflowGraphTarget.stageId;
		return stage.nodeKind !== "tool" && isFullRunId(id) && id.slice(0, 8).toLowerCase() === target.toLowerCase();
	});
}

function ambiguousUuidStageTarget(
	target: string,
	stages: readonly ExpandedWorkflowStage[],
): { ok: false; message: string } {
	return {
		ok: false,
		message: `Ambiguous stage UUID prefix "${target}" matches: ${stages.map((stage) => stage.workflowGraphTarget.stageId).join(", ")}. Use the full 36-character UUID.`,
	};
}

function ambiguousStageTarget(target: string, stages: readonly ExpandedWorkflowStage[]): ToolStageTarget {
	return {
		ok: false,
		message: `Ambiguous stage identifier "${target}" matches: ${stages.map(expandedStageLabel).join(", ")}`,
	};
}

export function resolveToolStageTarget(
	runId: string,
	stageTarget?: string,
	activeStore: Store = store,
): ToolStageTarget {
	return resolveStageTarget(runId, stageTarget, activeStore);
}

/**
 * Control target resolved across stages *and* tool nodes.
 *
 * Tool nodes are abort-only control targets: `quit` and `pause` may name
 * them by expanded id, local `tool:<argsHash>` id, or tool name, with the same
 * ambiguity handling stages get. They are never chat/attach targets.
 */
export type ControlNodeTarget =
	| { ok: true; kind: "run" }
	| { ok: true; kind: "stage"; runId: string; stageId: string }
	| { ok: true; kind: "tool"; runId: string; nodeId: string; name: string }
	| { ok: false; message: string };

export function resolveControlNodeTarget(runId: string, stageTarget?: string): ControlNodeTarget {
	const target = stageTarget?.trim();
	if (!target) return { ok: true, kind: "run" };
	const graph = expandWorkflowGraph(readGraphStoreSnapshot(store), runId);
	const nodes = graph.renderStages;
	const candidates: Array<readonly ExpandedWorkflowStage[]> = [
		nodes.filter((node) => node.id === target),
		nodes.filter((node) => node.workflowGraphTarget.stageId === target),
		nodes.filter((node) => node.name === target),
		matchingUuidStages(nodes, target),
		nodes.filter((node) => stageMatchesExpandedIdentifier(node, target)),
	];
	for (const matches of candidates) {
		if (matches.length === 1) return resolvedControlNodeTarget(matches[0]!);
		if (matches.length > 1)
			return {
				ok: false,
				message: `Ambiguous stage identifier "${target}" matches: ${matches.map(expandedStageLabel).join(", ")}`,
			};
	}
	return { ok: false, message: `Stage not found in run ${runId}: ${target}` };
}

function resolvedControlNodeTarget(node: ExpandedWorkflowStage): ControlNodeTarget {
	const graphTarget = node.workflowGraphTarget;
	return node.nodeKind === "tool"
		? { ok: true, kind: "tool", runId: graphTarget.runId, nodeId: graphTarget.stageId, name: node.name }
		: { ok: true, kind: "stage", runId: graphTarget.runId, stageId: graphTarget.stageId };
}

export function overlaySurfaceFromContext(ctx?: { ui?: PiUISurface }): OverlayPiSurface | undefined {
	return typeof ctx?.ui?.custom === "function" ? { ui: ctx.ui } : undefined;
}
