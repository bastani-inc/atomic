import {
	type ExpandedWorkflowStage,
	expandedStageLabel,
	expandWorkflowGraph,
} from "../shared/expanded-workflow-graph.js";
import {
	coercePrimitivePromptAnswer,
	isPrimitivePrompt,
	primitivePromptAnswerRejection,
} from "../shared/prompt-answer.js";
import { coerceStageInputAnswer, hasStageInputAnswerContent, type StageInputAnswer } from "../shared/stage-prompt.js";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import { store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import { reciprocalWorkflowRootRunId } from "../shared/workflow-run-ownership.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import { resolveToolRunTarget, resolveToolStageTarget, type ToolStageTarget } from "./workflow-targets.js";

type WorkflowAnswerToolResult = Extract<WorkflowToolResult, { action: "answer" }>;

function answerResult(
	runId: string,
	stageId: string,
	status: "ok" | "noop",
	message: string,
): WorkflowAnswerToolResult {
	return { action: "answer", runId, stageId, status, message };
}

function terminalAnswerResult(
	runId: string,
	stageId: string,
	workflowStatus: Parameters<typeof isTerminalRunStatus>[0],
): WorkflowAnswerToolResult {
	const message = `Cannot answer a prompt because workflow ${runId} has terminated with status ${workflowStatus}. If work remains, start a new workflow to address it.`;
	return {
		action: "answer",
		runId,
		stageId,
		status: "failed",
		code: "WORKFLOW_TERMINAL",
		workflowStatus,
		error: message,
		message,
	};
}

function hasPayloadProperty(args: WorkflowToolArgs): boolean {
	return args.text !== undefined || args.response !== undefined || args.message !== undefined;
}

function promptPayloadFromArgs(args: WorkflowToolArgs): unknown {
	if (args.response !== undefined) return args.response;
	if (args.text !== undefined) return args.text;
	return args.message;
}

function textPayloadFromArgs(args: WorkflowToolArgs): string | undefined {
	if (args.text !== undefined) return args.text;
	if (typeof args.response === "string") return args.response;
	return args.message;
}

function brokerAnswerFromArgs(args: WorkflowToolArgs): StageInputAnswer {
	if (args.response !== undefined) {
		const coerced = coerceStageInputAnswer(args.response);
		if (hasStageInputAnswerContent(coerced)) return coerced;
	}
	const text = textPayloadFromArgs(args);
	return text !== undefined ? { text } : {};
}

function answerablePromptIds(stage: ExpandedWorkflowStage): string[] {
	const target = stage.workflowGraphTarget;
	const ids: string[] = [];
	const brokered = stageUiBroker.peekStagePrompt(target.runId, target.stageId);
	if (brokered !== undefined) ids.push(brokered.id);
	if (stage.pendingPrompt !== undefined) ids.push(stage.pendingPrompt.id);
	if (stage.status === "awaiting_input" && stage.promptFootprint?.kind === "custom")
		ids.push(stage.promptFootprint.id);
	return ids;
}

function inferPromptStageTarget(runId: string, promptId: string | undefined): ToolStageTarget {
	const pending = expandWorkflowGraph(readGraphStoreSnapshot(store), runId).stages.filter((stage) => {
		const ids = answerablePromptIds(stage);
		return promptId === undefined ? ids.length > 0 : ids.includes(promptId);
	});
	const only = pending[0];
	if (pending.length === 1 && only !== undefined) {
		return { ok: true, runId: only.workflowGraphTarget.runId, stageId: only.workflowGraphTarget.stageId };
	}
	if (pending.length === 0) {
		return promptId === undefined
			? { ok: true, runId }
			: { ok: false, message: `No pending prompt ${promptId} in run ${runId}.` };
	}
	return {
		ok: false,
		message: `${pending.length} prompts pending; pass stageId: ${pending.map(expandedStageLabel).join(", ")}`,
	};
}

/**
 * Answer a pending workflow prompt without providing a stage-message path.
 */
export async function workflowAnswerAction(args: WorkflowToolArgs): Promise<WorkflowAnswerToolResult> {
	const target = resolveToolRunTarget(args, "No active run with a pending prompt.");
	if (target.kind === "all") return answerResult("--all", "", "noop", "Answer requires a single run.");
	if (target.kind === "malformed" || target.kind === "not_found") {
		return answerResult(target.target, "", "noop", target.message);
	}
	const runs = store.runs();
	const runById = new Map(runs.map((run) => [run.id, run]));
	const rootRunId = reciprocalWorkflowRootRunId(runById, target.runId) ?? target.runId;
	const rootRun = runById.get(rootRunId);
	if (rootRun !== undefined && isTerminalRunStatus(rootRun.status)) {
		return terminalAnswerResult(rootRun.id, args.stageId?.trim() ?? "", rootRun.status);
	}
	const requested = resolveToolStageTarget(target.runId, args.stageId);
	const stage =
		requested.ok && requested.stageId === undefined ? inferPromptStageTarget(target.runId, args.promptId) : requested;
	if (!stage.ok || stage.stageId === undefined) {
		return answerResult(target.runId, "", "noop", stage.ok ? "Stage id or name is required." : stage.message);
	}
	const stageRunId = stage.runId ?? target.runId;
	const snapshot = store
		.runs()
		.find((run) => run.id === stageRunId)
		?.stages.find((item) => item.id === stage.stageId);
	const brokerPrompt = stageUiBroker.peekStagePrompt(stageRunId, stage.stageId);
	if (brokerPrompt !== undefined && (args.promptId === undefined || args.promptId === brokerPrompt.id)) {
		if (!hasPayloadProperty(args))
			return answerResult(stageRunId, stage.stageId, "noop", "Answer requires text, response, or message.");
		const ok = stageUiBroker.answerStagePrompt(stageRunId, stage.stageId, brokerAnswerFromArgs(args), {
			answerSource: "workflow_tool",
		});
		return answerResult(
			stageRunId,
			stage.stageId,
			ok ? "ok" : "noop",
			ok ? `Answered input request ${brokerPrompt.id}.` : `No matching pending input request ${brokerPrompt.id}.`,
		);
	}
	const customPrompt =
		snapshot?.status === "awaiting_input" && snapshot.promptFootprint?.kind === "custom"
			? snapshot.promptFootprint
			: undefined;
	if (customPrompt !== undefined && (args.promptId === undefined || args.promptId === customPrompt.id)) {
		return answerResult(
			stageRunId,
			stage.stageId,
			"noop",
			`Custom UI prompt ${customPrompt.id} requires the interactive workflow graph; arbitrary ctx.ui.custom<T> results cannot be answered through workflow answer.`,
		);
	}
	const promptId = args.promptId ?? snapshot?.pendingPrompt?.id;
	if (promptId === undefined) {
		return answerResult(stageRunId, stage.stageId, "noop", "No pending prompt to answer.");
	}
	if (!hasPayloadProperty(args))
		return answerResult(stageRunId, stage.stageId, "noop", "Answer requires text, response, or message.");
	if (stageUiBroker.wasStagePromptResolved(stageRunId, stage.stageId, promptId)) {
		return answerResult(stageRunId, stage.stageId, "ok", `Input request ${promptId} was already answered.`);
	}
	const rawPayload = promptPayloadFromArgs(args);
	const pendingPrompt = snapshot?.pendingPrompt;
	const primitivePrompt =
		pendingPrompt?.id === promptId && isPrimitivePrompt(pendingPrompt) ? pendingPrompt : undefined;
	if (primitivePrompt !== undefined) {
		const coerced = coercePrimitivePromptAnswer(primitivePrompt, rawPayload);
		if (!coerced.ok)
			return answerResult(
				stageRunId,
				stage.stageId,
				"noop",
				primitivePromptAnswerRejection(promptId, primitivePrompt),
			);
		const ok = store.resolveStagePendingPrompt(stageRunId, stage.stageId, promptId, coerced.value, {
			answerSource: "workflow_tool",
		});
		return answerResult(
			stageRunId,
			stage.stageId,
			ok ? "ok" : "noop",
			ok ? `Answered prompt ${promptId}.` : `No matching pending prompt ${promptId}.`,
		);
	}
	const ok = store.resolveStagePendingPrompt(stageRunId, stage.stageId, promptId, rawPayload, {
		answerSource: "workflow_tool",
	});
	return answerResult(
		stageRunId,
		stage.stageId,
		ok ? "ok" : "noop",
		ok ? `Answered prompt ${promptId}.` : `No matching pending prompt ${promptId}.`,
	);
}
