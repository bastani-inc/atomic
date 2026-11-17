import { sliceHead } from "@bastani/atomic";
import {
	actionableReturnedStatusText,
	effectiveRunStatus,
	isReturnedBlockedWorkflowStatus,
	normalizeReturnedWorkflowStatus,
	structuredRecoverableWorkflowFailure,
} from "../shared/returned-run-status.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { TOOL_PAYLOAD_VALUE_LIMIT } from "../shared/tool-payload-bounds.js";
import {
	authoritativeWorkflowChildRunId,
	type RunsById,
	reciprocalWorkflowRootRunId,
} from "../shared/workflow-run-ownership.js";
import { inertDisplayLine } from "./display-text.js";

function firstLineOf(text: string): string {
	const trimmed = text.trimStart();
	const nl = trimmed.indexOf("\n");
	const cr = trimmed.indexOf("\r");
	const end = nl < 0 ? cr : cr < 0 ? nl : Math.min(nl, cr);
	return end < 0 ? trimmed : trimmed.slice(0, end);
}

export function isTerminalOrBlockedRun(run: RunSnapshot): boolean {
	const status = effectiveRunStatus(run);
	return (
		status === "completed" ||
		status === "skipped" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "killed" ||
		status === "blocked" ||
		run.quitAt !== undefined
	);
}

export function isWaitingStage(stage: StageSnapshot): boolean {
	return stage.status === "awaiting_input" || stage.pendingPrompt !== undefined || stage.inputRequest !== undefined;
}

export function validChildRunForStage(
	stage: StageSnapshot,
	parentRun: RunSnapshot,
	rootRunId: string,
	runsById: RunsById,
	visited: Set<string>,
): RunSnapshot | undefined {
	const childId = authoritativeWorkflowChildRunId(stage);
	if (childId === undefined || visited.has(childId)) return undefined;
	const child = runsById.get(childId);
	if (
		child === undefined ||
		child.parentRunId !== parentRun.id ||
		child.parentStageId !== stage.id ||
		reciprocalWorkflowRootRunId(runsById, child.id) !== rootRunId
	) {
		return undefined;
	}
	return child;
}

export interface WaitingRunTarget {
	readonly stageName?: string;
	readonly question?: string;
}

export function findWaitingInTree(
	run: RunSnapshot,
	runsById: RunsById = { get: (id) => (id === run.id ? run : undefined) },
	rootRunId = run.id,
	visited = new Set<string>(),
): WaitingRunTarget | undefined {
	if (visited.has(run.id) || isTerminalOrBlockedRun(run)) return undefined;
	visited.add(run.id);
	if (run.pendingPrompt !== undefined) {
		const question = inertDisplayLine(firstLineOf(sliceHead(run.pendingPrompt.message, TOOL_PAYLOAD_VALUE_LIMIT)));
		return question.length > 0 ? { question } : {};
	}
	for (const stage of run.stages) {
		const child = validChildRunForStage(stage, run, rootRunId, runsById, visited);
		if (child !== undefined) {
			const nested = findWaitingInTree(child, runsById, rootRunId, visited);
			if (nested !== undefined) {
				return nested.stageName === undefined ? { stageName: inertDisplayLine(stage.name), ...nested } : nested;
			}
		}
		if (isWaitingStage(stage)) {
			const rawQuestion = stage.pendingPrompt?.message ?? stage.inputRequest?.questions[0]?.question;
			const question =
				rawQuestion === undefined
					? undefined
					: inertDisplayLine(firstLineOf(sliceHead(rawQuestion, TOOL_PAYLOAD_VALUE_LIMIT)));
			return {
				stageName: inertDisplayLine(stage.name),
				...(question !== undefined && question.length > 0 ? { question } : {}),
			};
		}
	}
	return undefined;
}

export type RunFailureSource = Partial<RunSnapshot>;

export function runFailureText(run: RunFailureSource): string | undefined {
	const stages = run.stages ?? [];
	const failedStage =
		(run.failedStageId === undefined ? undefined : stages.find((stage) => stage.id === run.failedStageId)) ??
		stages.find((stage) => stage.status === "failed") ??
		stages.find((stage) => stage.status === "blocked");
	const returnedStatus = normalizeReturnedWorkflowStatus(run.result?.status);
	const returnedFailure =
		returnedStatus === "failed" || (returnedStatus !== undefined && isReturnedBlockedWorkflowStatus(returnedStatus));
	return (
		(returnedFailure ? actionableReturnedStatusText(run.result) : undefined) ??
		run.error ??
		run.failureMessage ??
		failedStage?.error ??
		failedStage?.failureMessage ??
		structuredRecoverableWorkflowFailure({ ...run, stages })?.error ??
		actionableReturnedStatusText(run.result)
	);
}
