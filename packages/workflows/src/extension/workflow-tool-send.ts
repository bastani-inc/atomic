import {
	acquirePostMortemStageHandle,
	type PostMortemStageChatDeps,
} from "../runs/foreground/postmortem-stage-chat.js";
import type { DetachedStageHandleLease, StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import {
	type ExpandedWorkflowStage,
	expandedStageLabel,
	expandWorkflowGraph,
} from "../shared/expanded-workflow-graph.js";
import { coerceStageInputAnswer, hasStageInputAnswerContent, type StageInputAnswer } from "../shared/stage-prompt.js";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import { store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import { reciprocalWorkflowRootRunId } from "../shared/workflow-run-ownership.js";
import type { WorkflowToolArgs } from "./public-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import { resolveToolRunTarget, resolveToolStageTarget, type ToolStageTarget } from "./workflow-targets.js";

/**
 * Optional dependencies enabling `workflow send` to revive an eligible
 * completed agent stage while its authoritative root is still nonterminal.
 */
export interface WorkflowSendDeps {
	readonly resolvePostMortemDeps?: (runId: string) => PostMortemStageChatDeps;
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
	if (args.message !== undefined) return args.message;
	return undefined;
}

function brokerAnswerFromArgs(args: WorkflowToolArgs): StageInputAnswer {
	if (args.response !== undefined) {
		const coerced = coerceStageInputAnswer(args.response);
		if (hasStageInputAnswerContent(coerced)) return coerced;
	}
	const text = textPayloadFromArgs(args);
	return text !== undefined ? { text } : {};
}

/**
 * Whether this delivery is one whose destination a pending prompt determines.
 *
 * `answer` and `auto` are both documented as answering pending prompts first,
 * and an explicit `promptId` names a prompt without naming its stage. Steering
 * deliveries are excluded: a live stage is a destination in its own right, so
 * there is nothing for a prompt to disambiguate.
 */
function answersPendingPrompt(delivery: string, promptId: string | undefined): boolean {
	return delivery === "answer" || delivery === "auto" || promptId !== undefined;
}

/**
 * Ids of the prompts an `answer` delivery could resolve on this stage.
 *
 * Covers the same three prompt kinds the delivery path dispatches on —
 * brokered, custom-footprint, and plain pending prompts — so a stage counted
 * here is one the send would actually act on rather than merely mention.
 */
function answerablePromptIds(stage: ExpandedWorkflowStage): string[] {
	const target = stage.workflowGraphTarget;
	const ids: string[] = [];
	const brokered = stageUiBroker.peekStagePrompt(target.runId, target.stageId);
	if (brokered !== undefined) ids.push(brokered.id);
	if (stage.pendingPrompt !== undefined) ids.push(stage.pendingPrompt.id);
	if (stage.status === "awaiting_input" && stage.promptFootprint?.kind === "custom") {
		ids.push(stage.promptFootprint.id);
	}
	return ids;
}

/**
 * Resolve the stage an answer is for when the caller named a prompt but no stage.
 *
 * A named `promptId` already identifies its stage, so it narrows the candidates
 * before uniqueness is decided — otherwise naming one of two pending prompts
 * would be rejected as ambiguous, and naming an unknown one would target the
 * unrelated stage that happened to be the only one waiting.
 *
 * Returns the target unchanged when nothing is pending, so a run with no prompt
 * still reports that a stage is required rather than inventing a destination.
 */
function inferPromptStageTarget(runId: string, delivery: string, promptId: string | undefined): ToolStageTarget {
	if (!answersPendingPrompt(delivery, promptId)) return { ok: true, runId };
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

type WorkflowSendToolResult = Extract<WorkflowToolResult, { action: "send" }>;

function workflowSendResult(
	runId: string,
	stageId: string,
	delivery: WorkflowSendToolResult["delivery"],
	status: "ok" | "noop",
	message: string,
): WorkflowSendToolResult {
	return { action: "send", runId, stageId, delivery, status, message };
}

function terminalWorkflowSendResult(
	runId: string,
	stageId: string,
	workflowStatus: Parameters<typeof isTerminalRunStatus>[0],
): WorkflowSendToolResult {
	const message = `Cannot send a message because workflow ${runId} has terminated with status ${workflowStatus}. If work remains, start a new workflow to address it. Complete it inline only when the remaining task is small, deterministic, and low risk.`;
	return {
		action: "send",
		runId,
		stageId,
		delivery: "rejected",
		status: "failed",
		code: "WORKFLOW_TERMINAL",
		workflowStatus,
		error: message,
		message,
	};
}

class WorkflowSendAdmissionError extends Error {
	constructor(readonly result: WorkflowSendToolResult) {
		super(result.message);
	}
}

function terminalWorkflowSendResultForRoot(rootRunId: string, stageId: string): WorkflowSendToolResult | undefined {
	const rootRun = store.runs().find((run) => run.id === rootRunId);
	return rootRun !== undefined && isTerminalRunStatus(rootRun.status)
		? terminalWorkflowSendResult(rootRun.id, stageId, rootRun.status)
		: undefined;
}

async function deliverStageUserMessage(
	handle: StageControlHandle,
	text: string,
	deliverAs: "steer" | "followUp" | undefined,
	beforeDelivery: () => void,
): Promise<StageUserMessageDeliveryAction> {
	if (handle.sendUserMessage === undefined) {
		throw new Error("atomic-workflows: stage handle does not support admission-aware message delivery");
	}
	return handle.sendUserMessage(text, { deliverAs }, beforeDelivery);
}

function deliveryMessage(delivery: StageUserMessageDeliveryAction): string {
	if (delivery === "prompt") return "Prompt started for stage.";
	if (delivery === "steer") return "Steered live stage.";
	if (delivery === "followUp") return "Follow-up queued for stage.";
	return "Message handled by stage extension.";
}

export async function workflowSendAction(
	args: WorkflowToolArgs,
	deps: WorkflowSendDeps = {},
): Promise<WorkflowSendToolResult> {
	const target = resolveToolRunTarget(args, "No active run to message.");
	const requestedDelivery = args.delivery ?? "auto";
	if (target.kind === "all") {
		return workflowSendResult("--all", "", requestedDelivery, "noop", "Send requires a single run.");
	}
	if (target.kind === "malformed" || target.kind === "not_found") {
		return workflowSendResult(target.target, "", requestedDelivery, "noop", target.message);
	}
	const runs = store.runs();
	const runById = new Map(runs.map((run) => [run.id, run]));
	const rootRunId = reciprocalWorkflowRootRunId(runById, target.runId) ?? target.runId;
	const rootRun = runById.get(rootRunId);
	if (rootRun !== undefined && isTerminalRunStatus(rootRun.status)) {
		return terminalWorkflowSendResult(rootRun.id, args.stageId?.trim() ?? "", rootRun.status);
	}
	const requested = resolveToolStageTarget(target.runId, args.stageId);
	const stage =
		requested.ok && requested.stageId === undefined
			? inferPromptStageTarget(target.runId, requestedDelivery, args.promptId)
			: requested;
	if (!stage.ok || stage.stageId === undefined) {
		return workflowSendResult(
			target.runId,
			"",
			requestedDelivery,
			"noop",
			stage.ok ? "Stage id or name is required." : stage.message,
		);
	}
	const resolvedStageId = stage.stageId;
	const stageRunId = stage.runId ?? target.runId;
	const run = store.runs().find((r) => r.id === stageRunId);
	const snapshot = run?.stages.find((s) => s.id === stage.stageId);
	const brokerPrompt = stageUiBroker.peekStagePrompt(stageRunId, stage.stageId);
	const targetsBrokerPrompt =
		brokerPrompt !== undefined &&
		(args.promptId === undefined || args.promptId === brokerPrompt.id) &&
		(requestedDelivery === "answer" || args.promptId !== undefined || requestedDelivery === "auto");
	if (targetsBrokerPrompt && brokerPrompt !== undefined) {
		if (!hasPayloadProperty(args)) {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				"answer",
				"noop",
				"Send requires text, response, or message.",
			);
		}
		const ok = stageUiBroker.answerStagePrompt(stageRunId, stage.stageId, brokerAnswerFromArgs(args), {
			answerSource: "workflow_tool",
		});
		return workflowSendResult(
			stageRunId,
			stage.stageId,
			"answer",
			ok ? "ok" : "noop",
			ok ? `Answered input request ${brokerPrompt.id}.` : `No matching pending input request ${brokerPrompt.id}.`,
		);
	}
	const customPrompt =
		snapshot?.status === "awaiting_input" && snapshot.promptFootprint?.kind === "custom"
			? snapshot.promptFootprint
			: undefined;
	const targetsCustomPrompt =
		customPrompt !== undefined &&
		(args.promptId === undefined || args.promptId === customPrompt.id) &&
		(requestedDelivery === "answer" || args.promptId !== undefined || requestedDelivery === "auto");
	if (targetsCustomPrompt && customPrompt !== undefined) {
		return workflowSendResult(
			stageRunId,
			stage.stageId,
			"answer",
			"noop",
			`Custom UI prompt ${customPrompt.id} requires the interactive workflow graph; arbitrary ctx.ui.custom<T> results cannot be answered through workflow send.`,
		);
	}
	const targetsPrompt =
		requestedDelivery === "answer" ||
		args.promptId !== undefined ||
		(requestedDelivery === "auto" && snapshot?.pendingPrompt !== undefined);
	if (targetsPrompt) {
		const promptId = args.promptId ?? snapshot?.pendingPrompt?.id;
		if (promptId === undefined) {
			return workflowSendResult(stageRunId, stage.stageId, "answer", "noop", "No pending prompt to answer.");
		}
		if (!hasPayloadProperty(args)) {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				"answer",
				"noop",
				"Send requires text, response, or message.",
			);
		}
		if (stageUiBroker.wasStagePromptResolved(stageRunId, stage.stageId, promptId)) {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				"answer",
				"ok",
				`Input request ${promptId} was already answered.`,
			);
		}
		const ok = store.resolveStagePendingPrompt(stageRunId, stage.stageId, promptId, promptPayloadFromArgs(args), {
			answerSource: "workflow_tool",
		});
		return workflowSendResult(
			stageRunId,
			stage.stageId,
			"answer",
			ok ? "ok" : "noop",
			ok ? `Answered prompt ${promptId}.` : `No matching pending prompt ${promptId}.`,
		);
	}
	const text = textPayloadFromArgs(args);
	if (text === undefined) {
		return workflowSendResult(
			stageRunId,
			stage.stageId,
			requestedDelivery,
			"noop",
			"Send requires text, response, or message.",
		);
	}
	let lease: DetachedStageHandleLease | undefined;
	let handle: StageControlHandle | undefined;
	const existingHandle = stageControlRegistry.peek(stageRunId, stage.stageId);
	if (existingHandle !== undefined) {
		lease = stageControlRegistry.acquireDetached(stageRunId, stage.stageId, () => existingHandle);
		handle = lease.handle;
	} else if (deps.resolvePostMortemDeps !== undefined && snapshot !== undefined) {
		const acquired = acquirePostMortemStageHandle(stageRunId, snapshot, deps.resolvePostMortemDeps(stageRunId));
		if (acquired.ok) {
			lease = acquired.lease;
			handle = lease.handle;
		}
	}
	if (handle === undefined) {
		return workflowSendResult(stageRunId, stage.stageId, requestedDelivery, "noop", "No live handle for stage.");
	}
	let admitted = false;
	// Store terminal publication and this final SDK admission check are both
	// synchronous; no await occurs between this callback and SDK mutation.
	const admitDelivery = (): void => {
		const terminal = terminalWorkflowSendResultForRoot(rootRunId, args.stageId?.trim() ?? resolvedStageId);
		if (terminal !== undefined) throw new WorkflowSendAdmissionError(terminal);
		if (lease !== undefined && !lease.commit()) {
			throw new WorkflowSendAdmissionError(
				workflowSendResult(
					stageRunId,
					resolvedStageId,
					requestedDelivery,
					"noop",
					"Stage handle changed before message admission; retry against the current live stage.",
				),
			);
		}
		admitted = true;
	};
	const terminalPending = Promise.withResolvers<never>();
	const unsubscribeTerminal = subscribeStoreInvalidation(store, () => {
		if (admitted) return;
		const terminal = terminalWorkflowSendResultForRoot(rootRunId, args.stageId?.trim() ?? resolvedStageId);
		if (terminal !== undefined) terminalPending.reject(new WorkflowSendAdmissionError(terminal));
	});
	const awaitAdmission = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, terminalPending.promise]);
	try {
		// A completed post-mortem handle is not live execution: its handle-level
		// resume()/pause() reject by contract. Return a structured noop with guidance
		// instead of letting that rejection cross the tool boundary. Failed handles
		// remain eligible for their existing recoverable execution-resume semantics.
		const isTerminalPostMortemStage = handle.status === "completed";
		if (requestedDelivery === "resume" && handle.status !== "paused" && !isTerminalPostMortemStage) {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				"resume",
				"noop",
				"Stage is not paused; no resume message was delivered.",
			);
		}
		if (handle.status === "paused" && requestedDelivery !== "resume" && requestedDelivery !== "auto") {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				requestedDelivery,
				"noop",
				"Stage is paused; resume it before sending a new message.",
			);
		}
		const resumesStage =
			requestedDelivery === "resume" || (requestedDelivery === "auto" && handle.status === "paused");
		if (!resumesStage && handle.sendUserMessage === undefined) {
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				requestedDelivery,
				"noop",
				"Stage handle does not support admission-aware message delivery.",
			);
		}
		if (resumesStage) {
			if (isTerminalPostMortemStage) {
				return workflowSendResult(
					stageRunId,
					stage.stageId,
					"resume",
					"noop",
					'Cannot resume a terminal post-mortem stage; use delivery "followUp" or "prompt" to continue its retained conversation.',
				);
			}
			const resumedDelivery = await awaitAdmission(handle.resume(text, admitDelivery));
			if (resumedDelivery !== undefined && resumedDelivery !== "prompt") {
				return workflowSendResult(
					stageRunId,
					stage.stageId,
					resumedDelivery,
					"ok",
					deliveryMessage(resumedDelivery),
				);
			}
			if (resumedDelivery === "prompt") {
				return workflowSendResult(stageRunId, stage.stageId, "prompt", "ok", "Resumed stage and started prompt.");
			}
			const hasResumeMessage = text.trim().length > 0;
			return workflowSendResult(
				stageRunId,
				stage.stageId,
				"resume",
				"ok",
				hasResumeMessage ? "Resumed interrupted stage with message." : "Resumed stage.",
			);
		}
		if (requestedDelivery === "steer") {
			if (isTerminalPostMortemStage) {
				return workflowSendResult(
					stageRunId,
					stage.stageId,
					"steer",
					"noop",
					'Cannot steer a terminal post-mortem stage; use delivery "followUp" or "prompt" to continue its retained conversation.',
				);
			}
			const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, "steer", admitDelivery));
			return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
		}
		if (requestedDelivery === "auto" && handle.isStreaming && !isTerminalPostMortemStage) {
			const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, "steer", admitDelivery));
			return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
		}
		if (requestedDelivery === "prompt") {
			const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, undefined, admitDelivery));
			const message = delivery === "prompt" ? "Prompt sent to stage." : deliveryMessage(delivery);
			return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", message);
		}
		const delivery = await awaitAdmission(deliverStageUserMessage(handle, text, "followUp", admitDelivery));
		return workflowSendResult(stageRunId, stage.stageId, delivery, "ok", deliveryMessage(delivery));
	} catch (error) {
		if (error instanceof WorkflowSendAdmissionError) return error.result;
		throw error;
	} finally {
		unsubscribeTerminal();
		if (!admitted) {
			try {
				await lease?.release();
			} catch (error) {
				console.warn("atomic-workflows: provisional workflow-send handle cleanup failed", error);
			}
		}
	}
}
