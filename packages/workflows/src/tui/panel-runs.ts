import type { AgentPanelActionResult, AgentPanelAnswerOptions, AgentPanelItem, AgentPanelState } from "@bastani/atomic";
import type { WorkflowOwnerResources } from "../extension/workflow-owner-resources.js";
import { workflowAnswerAction } from "../extension/workflow-tool-answer.js";
import { createWorkflowGraphExpander, settledStageCount } from "../shared/expanded-workflow-graph.js";
import { graphSnapshotLineage } from "../shared/graph-store-snapshot.js";
import {
	coercePrimitivePromptAnswer,
	isPrimitivePrompt,
	primitivePromptAnswerRejection,
} from "../shared/prompt-answer.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { createRunIndicatorStatusResolver } from "../shared/run-indicator-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { RunSnapshot, RunStatus, StageSnapshot, StoreSnapshot, WorkflowNotice } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { sanitizeToolDisplayText } from "../shared/tool-payload-bounds.js";
import { findSnapshotRun, findSnapshotStage, isPublishedSnapshotArray } from "../shared/workflow-run-ownership.js";
import {
	type PendingInputAffordance,
	pendingInputAffordance,
	stripTerminalControls,
} from "./pending-input-affordance.js";
import { markWorkflowRunViewed, resolveViewedWorkflowRuns, viewedWorkflowRuns } from "./viewed-runs.js";

export { markWorkflowRunViewed, viewedWorkflowRuns };

const REASON_WIDTH = 120;
export const PANEL_RUN_PREFIX = "run:";

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
const NEEDS_LINE_CHANGE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const EMPTY_NOTICES: readonly WorkflowNotice[] = Object.freeze([]);

function inertLine(text: string): string {
	if (!NEEDS_LINE_CHANGE.test(text)) return text;
	return sanitizeToolDisplayText(stripTerminalControls(text, true))
		.replace(BIDI_CONTROLS, (char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase()}>`)
		.replace(/\r?\n/g, " ");
}

function oneLine(text: string | undefined): string | undefined {
	const raw = text
		?.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (raw === undefined) return undefined;
	const line = inertLine(raw);
	if (line.length === 0) return undefined;
	return line.length > REASON_WIDTH ? `${line.slice(0, REASON_WIDTH - 1)}…` : line;
}

function currentStage(stages: readonly StageSnapshot[]): StageSnapshot | undefined {
	let running: StageSnapshot | undefined;
	let paused: StageSnapshot | undefined;
	for (const stage of stages) {
		if (stage.status === "awaiting_input") return stage;
		if (running === undefined && stage.status === "running") running = stage;
		else if (paused === undefined && (stage.status === "paused" || stage.status === "blocked")) paused = stage;
	}
	return running ?? paused;
}

function panelState(status: RunStatus, awaiting: boolean, live: boolean): AgentPanelState {
	if (awaiting) return "input";
	if (status === "completed" || status === "skipped") return "done";
	if (status === "failed" || status === "killed") return "failed";
	if (status === "cancelled") return "stopped";
	if (status === "paused" || status === "blocked") return "paused";
	return live ? "running" : "stopped";
}

function choicesOf(
	runs: readonly RunSnapshot[],
	[ownerRunId, stageId, promptId]: readonly [string, string | null, string],
): string[] | undefined {
	const owner = findSnapshotRun(runs, ownerRunId);
	if (owner === undefined) return undefined;
	if (stageId === null) {
		const prompt = owner.pendingPrompt;
		return prompt?.id === promptId && prompt.choices?.length ? prompt.choices.map(inertLine) : undefined;
	}
	const stage = findSnapshotStage(owner.stages, stageId);
	if (stage === undefined) return undefined;
	const request = stage.inputRequest?.id === promptId ? stage.inputRequest : undefined;
	if (request !== undefined) {
		if (request.questions.length !== 1) return undefined;
		const single = request.questions[0];
		if (single === undefined || single.multiSelect === true) return undefined;
		if (single.options.length > 0) return single.options.map((option) => inertLine(option.label));
	}
	const prompt = stage.pendingPrompt?.id === promptId ? stage.pendingPrompt : undefined;
	return prompt?.choices?.length ? prompt.choices.map(inertLine) : undefined;
}

type PromptIdentity = PendingInputAffordance["identity"];

/** The id an item gives its question, so an answer typed for it is refused once the run asks something else. */
function serializePromptIdentity(identity: PromptIdentity): string {
	return JSON.stringify(identity);
}

export function panelRunId(id: string): string | undefined {
	return id.startsWith(PANEL_RUN_PREFIX) ? id.slice(PANEL_RUN_PREFIX.length) : undefined;
}

interface CachedPanelRun {
	readonly run: RunSnapshot;
	readonly item: AgentPanelItem;
}

const snapshotItems = new WeakMap<object, readonly CachedPanelRun[]>();

function isPublishedGraphRuns(runs: readonly RunSnapshot[]): boolean {
	if (runs.length === 0 || !Object.isFrozen(runs)) return false;
	for (const run of runs) {
		if (!Object.isFrozen(run) || !isPublishedSnapshotArray(run.stages) || !isPublishedSnapshotArray(run.toolNodes)) {
			return false;
		}
	}
	return true;
}

function toStoreSnapshot(runsOrSnapshot: readonly RunSnapshot[] | StoreSnapshot): {
	readonly snapshot: StoreSnapshot;
	readonly cacheKey: object | undefined;
} {
	if (Array.isArray(runsOrSnapshot)) {
		const runs = runsOrSnapshot as readonly RunSnapshot[];
		if (isPublishedGraphRuns(runs)) {
			return {
				snapshot: { runs, notices: EMPTY_NOTICES, version: 0 },
				cacheKey: runs,
			};
		}
		return {
			snapshot: { runs: runs.map((run) => ({ ...run })), notices: EMPTY_NOTICES, version: 0 },
			cacheKey: undefined,
		};
	}
	const snapshot = runsOrSnapshot as StoreSnapshot;
	if (graphSnapshotLineage(snapshot) !== undefined) return { snapshot, cacheKey: snapshot.runs };
	return { snapshot: { ...snapshot, runs: snapshot.runs.map((run) => ({ ...run })) }, cacheKey: undefined };
}

/**
 * One item per top-level run, in launch order. A run opened from the panel (in `scope`'s viewed runs) is marked viewed,
 * so a finished one can leave the panel.
 */
export function panelItemsFromSnapshot(
	runsOrSnapshot: readonly RunSnapshot[] | StoreSnapshot,
	now = Date.now(),
	scope?: Set<string> | object,
): AgentPanelItem[] {
	const { snapshot, cacheKey } = toStoreSnapshot(runsOrSnapshot);
	const viewed = resolveViewedWorkflowRuns(scope);
	if (viewed.size > 0) {
		const liveRunIds = new Set(snapshot.runs.map((run) => run.id));
		for (const id of viewed) if (!liveRunIds.has(id)) viewed.delete(id);
	}
	const withViewed = (run: RunSnapshot, item: AgentPanelItem): AgentPanelItem =>
		viewed.has(run.id) === (item.viewed === true) ? item : { ...item, viewed: viewed.has(run.id) };
	if (cacheKey !== undefined) {
		const cached = snapshotItems.get(cacheKey);
		if (cached !== undefined) {
			return cached.map(({ run, item }) => {
				const elapsedMs = elapsedRunMs(run, run.endedAt ?? now);
				return withViewed(run, elapsedMs === item.elapsedMs ? item : { ...item, elapsedMs });
			});
		}
	}

	const runs = snapshot.runs;
	const indicator = createRunIndicatorStatusResolver(runs);
	const expand = createWorkflowGraphExpander(snapshot);

	const built: CachedPanelRun[] = topLevelWorkflowRuns(runs).map((run): CachedPanelRun => {
		const stages = expand(run.id).stages;
		const stage = currentStage(stages);
		const status = effectiveRunStatus(run);
		const quit = run.exitReason === "quit" || run.quitAt !== undefined;
		const state = panelState(status, !quit && indicator(run) === "awaiting_input", run.endedAt === undefined);
		const affordance = state === "input" ? pendingInputAffordance(run, runs) : undefined;
		const question = affordance?.message;
		const promptId = affordance === undefined ? undefined : serializePromptIdentity(affordance.identity);
		const choices = affordance === undefined ? undefined : choicesOf(runs, affordance.identity);
		const reason =
			state === "failed"
				? oneLine(
						run.error ??
							stages.find((candidate) => candidate.status === "failed")?.error ??
							run.stages.find((candidate) => candidate.status === "failed")?.error ??
							run.exitReason,
					)
				: undefined;
		const stageLabel = stage === undefined ? undefined : `stage ${inertLine(stage.name)}`;
		const task =
			state === "input"
				? (question ?? stageLabel ?? "waiting for input")
				: state === "failed"
					? (reason ?? "failed")
					: (stageLabel ?? "");
		const total = stages.length;
		const showProgress = (state === "running" || state === "paused" || state === "done") && total > 0;
		const item: AgentPanelItem = {
			id: `${PANEL_RUN_PREFIX}${run.id}`,
			kind: "workflow",
			state,
			name: inertLine(run.name),
			task,
			elapsedMs: elapsedRunMs(run, run.endedAt ?? now),
			...(showProgress ? { progress: { done: settledStageCount(stages), total } } : {}),
			...(question === undefined ? {} : { question }),
			...(state === "input" && choices?.length ? { choices } : {}),
			...(promptId === undefined ? {} : { promptId }),
			...(reason === undefined ? {} : { reason }),
			...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
		};
		return { run, item };
	});

	if (cacheKey !== undefined) {
		snapshotItems.set(cacheKey, built);
	}
	return built.map(({ run, item }) => withViewed(run, item));
}

function sameChoices(expected: readonly string[] | undefined, actual: readonly string[] | undefined): boolean {
	if (expected === undefined) return true;
	const current = actual ?? [];
	return expected.length === current.length && expected.every((choice, index) => choice === current[index]);
}

/**
 * Answers a run's item with `text`, only when the run still asks the question `options` names: its prompt id, and the
 * question and choices shown. An answer typed for an earlier question is refused, never sent to a later one.
 */
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
	const affordance = pendingInputAffordance(run, runs);
	if (options?.promptId === undefined) {
		return {
			ok: false,
			reason:
				affordance === undefined
					? "This workflow run does not have a single answerable prompt."
					: "This answer does not say which question it answers.",
		};
	}
	const currentChoices = affordance === undefined ? undefined : choicesOf(runs, affordance.identity);
	if (
		affordance === undefined ||
		options.promptId !== serializePromptIdentity(affordance.identity) ||
		(options.question !== undefined && options.question !== affordance.message) ||
		!sameChoices(options.choices, currentChoices)
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
			if (!coerced.ok) return { ok: false, reason: primitivePromptAnswerRejection(promptId, pending) };
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
