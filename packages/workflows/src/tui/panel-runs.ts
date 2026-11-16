import { stripVTControlCharacters } from "node:util";
import type { AgentPanelItem, AgentPanelState } from "@bastani/atomic";
import { createWorkflowGraphExpander, settledStageCount } from "../shared/expanded-workflow-graph.js";
import { graphSnapshotLineage } from "../shared/graph-store-snapshot.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { createRunIndicatorStatusResolver } from "../shared/run-indicator-status.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { RunSnapshot, RunStatus, StageSnapshot, StoreSnapshot, WorkflowNotice } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { sanitizeToolDisplayText } from "../shared/tool-payload-bounds.js";
import { findSnapshotRun, findSnapshotStage } from "../shared/workflow-run-ownership.js";
import { pendingInputAffordance } from "./pending-input-affordance.js";

const REASON_WIDTH = 120;
export const PANEL_RUN_PREFIX = "run:";

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
const NEEDS_LINE_CHANGE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const EMPTY_NOTICES: readonly WorkflowNotice[] = Object.freeze([]);

function inertLine(text: string): string {
	if (!NEEDS_LINE_CHANGE.test(text)) return text;
	return sanitizeToolDisplayText(stripVTControlCharacters(text))
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

export function panelRunId(id: string): string | undefined {
	return id.startsWith(PANEL_RUN_PREFIX) ? id.slice(PANEL_RUN_PREFIX.length) : undefined;
}

interface CachedPanelRun {
	readonly run: RunSnapshot;
	readonly item: AgentPanelItem;
}

const snapshotItems = new WeakMap<StoreSnapshot, readonly CachedPanelRun[]>();

function toStoreSnapshot(runsOrSnapshot: readonly RunSnapshot[] | StoreSnapshot): {
	readonly snapshot: StoreSnapshot;
	readonly cacheable: boolean;
} {
	const snapshot = Array.isArray(runsOrSnapshot)
		? { runs: runsOrSnapshot as readonly RunSnapshot[], notices: EMPTY_NOTICES, version: 0 }
		: (runsOrSnapshot as StoreSnapshot);
	if (graphSnapshotLineage(snapshot) !== undefined) return { snapshot, cacheable: true };
	return { snapshot: { ...snapshot, runs: snapshot.runs.map((run) => ({ ...run })) }, cacheable: false };
}

export function panelItemsFromSnapshot(
	runsOrSnapshot: readonly RunSnapshot[] | StoreSnapshot,
	now = Date.now(),
): AgentPanelItem[] {
	const { snapshot, cacheable } = toStoreSnapshot(runsOrSnapshot);
	if (cacheable) {
		const cached = snapshotItems.get(snapshot);
		if (cached !== undefined) {
			return cached.map(({ run, item }) => {
				const elapsedMs = elapsedRunMs(run, run.endedAt ?? now);
				return elapsedMs === item.elapsedMs ? item : { ...item, elapsedMs };
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
			...(reason === undefined ? {} : { reason }),
			...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
		};
		return { run, item };
	});

	if (cacheable) {
		snapshotItems.set(snapshot, built);
	}
	return built.map(({ item }) => item);
}
