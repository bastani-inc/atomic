import {
	type AgentPanelActionResult,
	type AgentPanelAnswerOptions,
	type AgentPanelItem,
	type AgentPanelState,
	sliceHead,
} from "@bastani/atomic";
import type { WorkflowOwnerResources } from "../extension/workflow-owner-resources.js";
import { workflowAnswerAction } from "../extension/workflow-tool-answer.js";
import {
	coercePrimitivePromptAnswer,
	isPrimitivePrompt,
	primitivePromptAnswerRejection,
} from "../shared/prompt-answer.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { createRunIndicatorStatusResolver } from "../shared/run-indicator-status.js";
import { runStageIndex } from "../shared/run-stage-index.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { store as defaultStore } from "../shared/store.js";
import type { RunSnapshot, RunStatus, StageSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import {
	authoritativeWorkflowChildRunId,
	findSnapshotRun,
	findSnapshotStage,
	reciprocalWorkflowRootRunId,
} from "../shared/workflow-run-ownership.js";
import {
	type PendingInputAffordance,
	sanitizePromptDisplay,
	visibleRootPendingInput,
} from "./pending-input-affordance.js";
import { markWorkflowRunViewed, resolveViewedWorkflowRuns, viewedWorkflowRuns } from "./viewed-runs.js";

export { markWorkflowRunViewed, viewedWorkflowRuns };

const REASON_WIDTH = 120;
export const PANEL_RUN_PREFIX = "run:";

type PromptIdentity = readonly [ownerRunId: string, stageId: string | null, promptId: string];

const frozenProgressByRuns = new WeakMap<
	readonly RunSnapshot[],
	Map<string, { readonly done: number; readonly total: number }>
>();

function serializePromptIdentity(identity: PromptIdentity): string {
	return JSON.stringify(identity);
}

function oneLine(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const line = text
		.split("\n")
		.map((part) => sanitizePromptDisplay(part))
		.find((part) => part.length > 0);
	if (line === undefined) return undefined;
	return line.length > REASON_WIDTH ? `${sliceHead(line, REASON_WIDTH - 1)}…` : line;
}

function currentStage(stages: readonly StageSnapshot[]): StageSnapshot | undefined {
	return (
		stages.find((stage) => stage.status === "awaiting_input") ??
		stages.find((stage) => stage.status === "running") ??
		stages.find((stage) => stage.status === "paused" || stage.status === "blocked")
	);
}

function panelState(status: RunStatus, awaiting: boolean, live: boolean): AgentPanelState {
	if (awaiting) return "input";
	if (status === "completed" || status === "skipped") return "done";
	if (status === "failed" || status === "killed") return "failed";
	if (status === "cancelled") return "stopped";
	if (live && (status === "paused" || status === "blocked")) return "paused";
	return live ? "running" : "stopped";
}

function affordanceChoices(
	runs: readonly RunSnapshot[],
	affordance: PendingInputAffordance | undefined,
): string[] | undefined {
	if (affordance === undefined) return undefined;
	const [ownerRunId, stageId, promptId] = affordance.identity;
	const ownerRun = findSnapshotRun(runs, ownerRunId);
	if (ownerRun === undefined) return undefined;
	if (stageId === null) {
		const prompt = ownerRun.pendingPrompt;
		if (prompt?.id !== promptId || prompt.kind === "custom" || !prompt.choices?.length) return undefined;
		const sanitized = prompt.choices
			.map((choice) => sanitizePromptDisplay(choice))
			.filter((choice) => choice.length > 0);
		return sanitized.length > 0 ? sanitized : undefined;
	}
	const stage =
		runStageIndex(ownerRun).waiting.find((candidate) => candidate.id === stageId) ??
		findSnapshotStage(ownerRun.stages, stageId);
	if (stage === undefined || stage.promptFootprint?.kind === "custom") return undefined;
	if (
		stage.pendingPrompt?.id === promptId &&
		stage.pendingPrompt.kind !== "custom" &&
		stage.pendingPrompt.choices?.length
	) {
		const sanitized = stage.pendingPrompt.choices
			.map((choice) => sanitizePromptDisplay(choice))
			.filter((choice) => choice.length > 0);
		return sanitized.length > 0 ? sanitized : undefined;
	}
	if (stage.inputRequest?.id === promptId && stage.inputRequest.questions.length === 1) {
		const options = stage.inputRequest.questions[0]?.options;
		if (!options?.length) return undefined;
		const sanitized = options
			.map((option) => sanitizePromptDisplay(option.label))
			.filter((choice) => choice.length > 0);
		return sanitized.length > 0 ? sanitized : undefined;
	}
	return undefined;
}

function expandedRunProgress(
	root: RunSnapshot,
	runs: readonly RunSnapshot[],
	childrenByParent: ReadonlyMap<string, readonly RunSnapshot[]> | undefined,
	runById: ReadonlyMap<string, RunSnapshot> | undefined,
): { readonly done: number; readonly total: number } {
	const frozen = Object.isFrozen(runs);
	let memo = frozen ? frozenProgressByRuns.get(runs) : undefined;
	const cached = memo?.get(root.id);
	if (cached !== undefined) return cached;

	if (childrenByParent === undefined || !childrenByParent.has(root.id) || runById === undefined) {
		const index = runStageIndex(root);
		const progress = { done: index.settled, total: root.stages.length };
		if (frozen) {
			if (memo === undefined) {
				memo = new Map();
				frozenProgressByRuns.set(runs, memo);
			}
			memo.set(root.id, progress);
		}
		return progress;
	}

	const visiting = new Set<string>();
	const expandedChildren = new Set<string>();
	const rootOwnerByRunId = new Map<string, string | undefined>();
	const rootOwnerFor = (runId: string): string | undefined => {
		if (rootOwnerByRunId.has(runId)) return rootOwnerByRunId.get(runId);
		const owner = reciprocalWorkflowRootRunId(runById, runId);
		rootOwnerByRunId.set(runId, owner);
		return owner;
	};

	const visit = (run: RunSnapshot): { done: number; total: number; expandedNodes: number } => {
		if (visiting.has(run.id)) return { done: 0, total: 0, expandedNodes: 0 };
		visiting.add(run.id);
		const index = runStageIndex(run);
		let done = index.settled;
		let total = run.stages.length;
		let expandedNodes = run.stages.length + (run.toolNodes?.length ?? 0);
		const children = childrenByParent.get(run.id);
		if (children !== undefined) {
			const runRoot = rootOwnerFor(run.id);
			for (const childRun of children) {
				if (expandedChildren.has(childRun.id) || childRun.parentStageId === undefined) continue;
				if (childRun.stages.length + (childRun.toolNodes?.length ?? 0) === 0) continue;
				if (runRoot === undefined || rootOwnerFor(childRun.id) !== runRoot) continue;
				const parentStage =
					index.unfinished.find((stage) => stage.id === childRun.parentStageId) ??
					findSnapshotStage(run.stages, childRun.parentStageId);
				if (parentStage === undefined || authoritativeWorkflowChildRunId(parentStage) !== childRun.id) continue;
				expandedChildren.add(childRun.id);
				const childProgress = visit(childRun);
				if (childProgress.expandedNodes === 0) continue;
				const parentSettled =
					parentStage.status === "completed" ||
					parentStage.status === "failed" ||
					parentStage.status === "skipped";
				done += childProgress.done - (parentSettled ? 1 : 0);
				total += childProgress.total - 1;
				expandedNodes += childProgress.expandedNodes - 1;
			}
		}
		visiting.delete(run.id);
		return { done, total, expandedNodes };
	};

	const { done, total } = visit(root);
	const progress = { done, total };
	if (frozen) {
		if (memo === undefined) {
			memo = new Map();
			frozenProgressByRuns.set(runs, memo);
		}
		memo.set(root.id, progress);
	}
	return progress;
}

export function panelRunId(id: string): string | undefined {
	return id.startsWith(PANEL_RUN_PREFIX) ? id.slice(PANEL_RUN_PREFIX.length) : undefined;
}

export function panelItemsFromSnapshot(
	runs: readonly RunSnapshot[],
	now = Date.now(),
	scope: Set<string> | object = defaultStore,
): AgentPanelItem[] {
	const viewed = resolveViewedWorkflowRuns(scope);
	const liveRunIds = new Set(runs.map((run) => run.id));
	for (const id of viewed) {
		if (!liveRunIds.has(id)) viewed.delete(id);
	}

	let childrenByParent: Map<string, RunSnapshot[]> | undefined;
	let runById: Map<string, RunSnapshot> | undefined;
	for (const candidate of runs) {
		if (candidate.parentRunId === undefined) continue;
		childrenByParent ??= new Map();
		const list = childrenByParent.get(candidate.parentRunId);
		if (list === undefined) childrenByParent.set(candidate.parentRunId, [candidate]);
		else list.push(candidate);
	}
	if (childrenByParent !== undefined) {
		runById = new Map(runs.map((run) => [run.id, run]));
	}

	const indicator = createRunIndicatorStatusResolver(runs);
	return topLevelWorkflowRuns(runs).map((run): AgentPanelItem => {
		const index = runStageIndex(run);
		const stage = currentStage(index.unfinished);
		const status = effectiveRunStatus(run);
		const state = panelState(status, indicator(run) === "awaiting_input", run.endedAt === undefined);
		const affordance = state === "input" ? visibleRootPendingInput(run, runs).affordance : undefined;
		const promptId = affordance === undefined ? undefined : serializePromptIdentity(affordance.identity);
		const question = affordance?.message;
		const choices = affordanceChoices(runs, affordance);
		const failedStageError =
			run.failedStageId === undefined ? undefined : findSnapshotStage(run.stages, run.failedStageId)?.error;
		const reason =
			state === "failed"
				? oneLine(
						run.error ??
							failedStageError ??
							run.stages.find((candidate) => candidate.status === "failed")?.error ??
							run.exitReason,
					)
				: undefined;
		const stageLabel = stage === undefined ? undefined : `stage ${sanitizePromptDisplay(stage.name)}`;
		const task =
			state === "input"
				? (question ?? stageLabel ?? "waiting for input")
				: state === "failed"
					? (reason ?? "failed")
					: (stageLabel ?? "");
		const showProgress = state === "running" || state === "paused" || state === "done";
		const isViewed = viewed.has(run.id);
		return {
			id: `${PANEL_RUN_PREFIX}${run.id}`,
			kind: "workflow",
			state,
			name: sanitizePromptDisplay(run.name) || "workflow",
			task,
			elapsedMs: elapsedRunMs(run, run.endedAt ?? now),
			...(showProgress ? { progress: expandedRunProgress(run, runs, childrenByParent, runById) } : {}),
			...(question === undefined ? {} : { question }),
			...(choices === undefined ? {} : { choices }),
			...(promptId === undefined ? {} : { promptId }),
			...(reason === undefined ? {} : { reason }),
			...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
			...(isViewed ? { viewed: true } : {}),
		};
	});
}

function sameChoices(expected: readonly string[] | undefined, actual: readonly string[] | undefined): boolean {
	if (expected === undefined) return true;
	const current = actual ?? [];
	return expected.length === current.length && expected.every((choice, index) => choice === current[index]);
}

export async function answerPanelRun(
	id: string,
	text: string,
	owner: WorkflowOwnerResources,
	options?: AgentPanelAnswerOptions,
): Promise<AgentPanelActionResult> {
	const runId = panelRunId(id);
	if (runId === undefined) return { ok: false, reason: "not a workflow run" };
	const runs = owner.store.graphSnapshot().runs;
	const run = findSnapshotRun(runs, runId);
	if (run === undefined) return { ok: false, reason: `Run ${runId} not found.` };
	const affordance = visibleRootPendingInput(run, runs).affordance;
	const currentChoices = affordanceChoices(runs, affordance);
	if (options?.promptId === undefined) {
		return {
			ok: false,
			reason:
				affordance === undefined
					? "This workflow run does not have a single answerable prompt."
					: "This answer does not say which question it answers.",
		};
	}
	const currentPromptId = affordance === undefined ? undefined : serializePromptIdentity(affordance.identity);
	if (
		affordance === undefined ||
		options.promptId !== currentPromptId ||
		(options?.question !== undefined && options.question !== affordance.message) ||
		!sameChoices(options?.choices, currentChoices)
	) {
		return {
			ok: false,
			reason:
				affordance === undefined
					? "No unique pending prompt matches the displayed question."
					: "The pending prompt changed before the answer was sent.",
		};
	}
	const [ownerRunId, stageId, promptId] = affordance.identity;
	if (stageId === null) {
		const pending = owner.store.run(ownerRunId)?.pendingPrompt;
		if (pending === undefined || pending.id !== promptId) {
			return { ok: false, reason: `No matching pending prompt ${promptId}.` };
		}
		if (isPrimitivePrompt(pending)) {
			const coerced = coercePrimitivePromptAnswer(pending, text);
			if (!coerced.ok) {
				return { ok: false, reason: primitivePromptAnswerRejection(promptId, pending) };
			}
			const ok = owner.store.resolvePendingPrompt(ownerRunId, promptId, coerced.value);
			return ok ? { ok: true } : { ok: false, reason: `No matching pending prompt ${promptId}.` };
		}
		const ok = owner.store.resolvePendingPrompt(ownerRunId, promptId, text);
		return ok ? { ok: true } : { ok: false, reason: `No matching pending prompt ${promptId}.` };
	}
	const stageTarget = ownerRunId === runId ? stageId : `${ownerRunId}:${stageId}`;
	const result = await workflowAnswerAction({ action: "answer", runId, stageId: stageTarget, promptId, text }, owner);
	return result.status === "ok" ? { ok: true } : { ok: false, reason: result.message ?? result.status };
}
