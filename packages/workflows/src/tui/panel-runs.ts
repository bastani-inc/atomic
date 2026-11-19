import {
	type AgentPanelActionResult,
	type AgentPanelAnswerOptions,
	type AgentPanelItem,
	type AgentPanelState,
	sliceHead,
} from "@bastani/atomic";
import type { WorkflowOwnerResources } from "../extension/workflow-owner-resources.js";
import { workflowAnswerAction } from "../extension/workflow-tool-answer.js";
import { createWorkflowGraphExpander, settledStageCount } from "../shared/expanded-workflow-graph.js";
import { graphSnapshotLineage, settledPrefixEpochOf } from "../shared/graph-store-snapshot.js";
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
import { currentWorkflowStore } from "../shared/store-factory.js";
import type { Store } from "../shared/store-public-types.js";
import type {
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	StoreSnapshot,
	ToolNodeSnapshot,
	WorkflowNotice,
} from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { sanitizeToolDisplayText } from "../shared/tool-payload-bounds.js";
import type { WorkflowModelUsage } from "../shared/types.js";
import {
	authoritativeWorkflowChildRunId,
	findSnapshotRun,
	findSnapshotStage,
	isPublishedSnapshotArray,
	reciprocalWorkflowRootRunId,
} from "../shared/workflow-run-ownership.js";
import {
	type PendingInputAffordance,
	pendingInputAffordance,
	sanitizePromptDisplay,
	stripTerminalControls,
} from "./pending-input-affordance.js";
import {
	viewedWorkflowRuns as baseViewedWorkflowRuns,
	markWorkflowRunViewed,
	resolveViewedWorkflowRuns,
} from "./viewed-runs.js";

export { markWorkflowRunViewed };

const storesByViewed = new WeakMap<Set<string>, Store>();

export function viewedWorkflowRuns(store: object = defaultStore): Set<string> {
	const set = baseViewedWorkflowRuns(store);
	const resolved = store === defaultStore ? currentWorkflowStore() : store;
	if (typeof (resolved as Store).run === "function") storesByViewed.set(set, resolved as Store);
	return set;
}

function resolveStore(scope?: Set<string> | object): Store | undefined {
	if (scope instanceof Set) return storesByViewed.get(scope);
	if (scope !== undefined && typeof (scope as Store).run === "function") return scope as Store;
	return currentWorkflowStore();
}

export type PendingStageTokenReader = (runId: string, stageId: string) => number;

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
	if (text === undefined) return undefined;
	const line = text
		.split("\n")
		.map((part) => sanitizePromptDisplay(part))
		.find((part) => part.length > 0);
	if (line === undefined) return undefined;
	return line.length > REASON_WIDTH ? `${sliceHead(line, REASON_WIDTH - 1)}…` : line;
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

function latestRunningTool(tools: readonly ToolNodeSnapshot[]): ToolNodeSnapshot | undefined {
	for (let index = tools.length - 1; index >= 0; index--) {
		const candidate = tools[index]!;
		if (candidate.status === "running") return candidate;
	}
	return undefined;
}

function panelState(status: RunStatus, awaiting: boolean, live: boolean): AgentPanelState {
	if (awaiting) return "input";
	if (status === "completed" || status === "skipped") return "done";
	if (status === "failed" || status === "killed") return "failed";
	if (status === "cancelled") return "stopped";
	if (live && (status === "paused" || status === "blocked")) return "paused";
	return live ? "running" : "stopped";
}

function rawChoicesOf(
	runs: readonly RunSnapshot[],
	[ownerRunId, stageId, promptId]: readonly [string, string | null, string],
): readonly string[] | undefined {
	const owner = findSnapshotRun(runs, ownerRunId);
	if (owner === undefined) return undefined;
	if (stageId === null) {
		const prompt = owner.pendingPrompt;
		return prompt?.id === promptId && prompt.kind !== "custom" && prompt.choices?.length ? prompt.choices : undefined;
	}
	const stage = findSnapshotStage(owner.stages, stageId);
	if (stage === undefined || stage.promptFootprint?.kind === "custom") return undefined;
	const request = stage.inputRequest?.id === promptId ? stage.inputRequest : undefined;
	if (request !== undefined) {
		if (request.questions.length !== 1) return undefined;
		const single = request.questions[0];
		if (single === undefined || single.multiSelect === true) return undefined;
		if (single.options.length > 0) return single.options.map((option) => option.label);
	}
	const prompt = stage.pendingPrompt?.id === promptId ? stage.pendingPrompt : undefined;
	return prompt !== undefined && prompt.kind !== "custom" && prompt.choices?.length ? prompt.choices : undefined;
}

function choicesOf(
	runs: readonly RunSnapshot[],
	identity: readonly [string, string | null, string],
): string[] | undefined {
	const raw = rawChoicesOf(runs, identity);
	if (raw === undefined) return undefined;
	return raw.map((choice, index) => sanitizePromptDisplay(choice) || `Option ${index + 1}`);
}

type PromptIdentity = PendingInputAffordance["identity"];

function serializePromptIdentity(identity: PromptIdentity): string {
	return JSON.stringify(identity);
}

export function panelRunId(id: string): string | undefined {
	return id.startsWith(PANEL_RUN_PREFIX) ? id.slice(PANEL_RUN_PREFIX.length) : undefined;
}

function isSettledStage(stage: StageSnapshot): boolean {
	return stage.status === "completed" || stage.status === "failed" || stage.status === "skipped";
}

export function usageTokens(usage: WorkflowModelUsage | undefined): number {
	if (usage === undefined) return 0;
	const input = typeof usage.input === "number" && Number.isFinite(usage.input) && usage.input > 0 ? usage.input : 0;
	const output =
		typeof usage.output === "number" && Number.isFinite(usage.output) && usage.output > 0 ? usage.output : 0;
	return Math.round(input + output);
}

export function stageTokens(stage: StageSnapshot): number {
	if (stage.replayed === true || stage.modelAttempts === undefined) return 0;
	let total = 0;
	for (const attempt of stage.modelAttempts) {
		total += usageTokens(attempt.usage);
	}
	return total;
}

interface SettledTokenPrefix {
	scannedCount: number;
	settledTokens: number;
}

const settledTokenPrefixes = new WeakMap<object, SettledTokenPrefix>();

function runDirectTokens(
	run: RunSnapshot,
	rawRun: RunSnapshot | undefined,
	delegatedStageIds: ReadonlySet<string> | undefined,
	pendingStageTokens: PendingStageTokenReader | undefined,
): number {
	let total = 0;
	const target = rawRun !== undefined && !isPublishedSnapshotArray(rawRun.stages) ? rawRun : run;
	const epochKey =
		settledPrefixEpochOf(run) ??
		(rawRun !== undefined ? settledPrefixEpochOf(rawRun) : undefined) ??
		(Object.isFrozen(target) && Object.isFrozen(target.stages) ? target : undefined);
	if ((delegatedStageIds === undefined || delegatedStageIds.size === 0) && epochKey !== undefined) {
		let prefix = settledTokenPrefixes.get(epochKey);
		if (prefix === undefined || prefix.scannedCount > target.stages.length) {
			prefix = { scannedCount: 0, settledTokens: 0 };
			settledTokenPrefixes.set(epochKey, prefix);
		}
		while (prefix.scannedCount < target.stages.length) {
			const candidate = target.stages[prefix.scannedCount]!;
			if (!isSettledStage(candidate) || authoritativeWorkflowChildRunId(candidate) !== undefined) break;
			prefix.settledTokens += stageTokens(candidate);
			prefix.scannedCount++;
		}
		total = prefix.settledTokens;
		for (let index = prefix.scannedCount; index < target.stages.length; index++) {
			const candidate = target.stages[index]!;
			if (authoritativeWorkflowChildRunId(candidate) !== undefined) continue;
			total += stageTokens(candidate);
			if (!isSettledStage(candidate) && pendingStageTokens !== undefined) {
				total += pendingStageTokens(run.id, candidate.id);
			}
		}
	} else {
		const stages =
			delegatedStageIds !== undefined && isPublishedSnapshotArray(target.stages)
				? runStageIndex(target).unfinished
				: target.stages;
		for (const stage of stages) {
			if (delegatedStageIds?.has(stage.id)) continue;
			total += stageTokens(stage);
			if (!isSettledStage(stage) && pendingStageTokens !== undefined) {
				total += pendingStageTokens(run.id, stage.id);
			}
		}
	}
	total += usageTokens(target.budgetState?.wrapUpUsage);
	return total;
}

function runTreeTokens(
	root: RunSnapshot,
	childrenByParent: ReadonlyMap<string, readonly RunSnapshot[]> | undefined,
	runById: ReadonlyMap<string, RunSnapshot> | undefined,
	store: Store | undefined,
	pendingStageTokens: PendingStageTokenReader | undefined,
): number {
	const lookupRaw = (candidate: RunSnapshot): RunSnapshot | undefined =>
		isPublishedSnapshotArray(candidate.stages) ? store?.run(candidate.id) : candidate;
	let total = 0;
	if (childrenByParent === undefined || !childrenByParent.has(root.id) || runById === undefined) {
		total = runDirectTokens(root, lookupRaw(root), undefined, pendingStageTokens);
	} else {
		const visiting = new Set<string>();
		const expandedChildren = new Set<string>();
		const rootOwnerByRunId = new Map<string, string | undefined>();
		const rootOwnerFor = (runId: string): string | undefined => {
			if (rootOwnerByRunId.has(runId)) return rootOwnerByRunId.get(runId);
			const owner = reciprocalWorkflowRootRunId(runById, runId);
			rootOwnerByRunId.set(runId, owner);
			return owner;
		};
		const visit = (run: RunSnapshot): number => {
			if (visiting.has(run.id)) return 0;
			visiting.add(run.id);
			const children = childrenByParent.get(run.id);
			let delegatedStageIds: Set<string> | undefined;
			let childTokens = 0;
			if (children !== undefined) {
				const runRoot = rootOwnerFor(run.id);
				const index = runStageIndex(run);
				for (const childRun of children) {
					if (expandedChildren.has(childRun.id) || childRun.parentStageId === undefined) continue;
					if (childRun.stages.length + childRun.toolNodes.length === 0) continue;
					if (runRoot === undefined || rootOwnerFor(childRun.id) !== runRoot) continue;
					const parentStage =
						index.unfinished.find((stage) => stage.id === childRun.parentStageId) ??
						findSnapshotStage(run.stages, childRun.parentStageId);
					if (parentStage === undefined || authoritativeWorkflowChildRunId(parentStage) !== childRun.id) continue;
					expandedChildren.add(childRun.id);
					delegatedStageIds ??= new Set();
					delegatedStageIds.add(parentStage.id);
					childTokens += visit(childRun);
				}
			}
			const ownTokens = runDirectTokens(run, lookupRaw(run), delegatedStageIds, pendingStageTokens);
			visiting.delete(run.id);
			return ownTokens + childTokens;
		};
		total = visit(root);
	}
	const rootSource = lookupRaw(root) ?? root;
	const accounted = rootSource.budgetState?.accounting?.tokens ?? rootSource.budgetState?.tokens?.reading;
	if (typeof accounted === "number" && Number.isFinite(accounted) && accounted > total) {
		return Math.round(accounted);
	}
	return total;
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

type RunMarkerSamples = Map<RunSnapshot, Pick<RunSnapshot, "blockedAt">>;

function toStoreSnapshot(
	runsOrSnapshot: readonly RunSnapshot[] | StoreSnapshot,
	markerSamples?: RunMarkerSamples,
): {
	readonly snapshot: StoreSnapshot;
	readonly cacheKey: object | undefined;
} {
	function snapshotRun(run: RunSnapshot): RunSnapshot {
		const sampled = { ...run };
		if (markerSamples !== undefined && "blockedAt" in sampled)
			markerSamples.set(run, { blockedAt: sampled.blockedAt });
		return sampled;
	}
	if (Array.isArray(runsOrSnapshot)) {
		const runs = runsOrSnapshot as readonly RunSnapshot[];
		if (isPublishedGraphRuns(runs)) {
			return {
				snapshot: { runs, notices: EMPTY_NOTICES, version: 0 },
				cacheKey: runs,
			};
		}
		return {
			snapshot: { runs: runs.map(snapshotRun), notices: EMPTY_NOTICES, version: 0 },
			cacheKey: undefined,
		};
	}
	const snapshot = runsOrSnapshot as StoreSnapshot;
	if (graphSnapshotLineage(snapshot) !== undefined) return { snapshot, cacheKey: snapshot.runs };
	return { snapshot: { ...snapshot, runs: snapshot.runs.map(snapshotRun) }, cacheKey: undefined };
}

export function panelItemsFromSnapshot(
	runsOrSnapshot: readonly RunSnapshot[] | StoreSnapshot,
	now = Date.now(),
	scope?: Set<string> | object,
	pendingStageTokens?: PendingStageTokenReader,
	markerSamples?: RunMarkerSamples,
): AgentPanelItem[] {
	const { snapshot, cacheKey } = toStoreSnapshot(runsOrSnapshot, markerSamples);
	const viewed = resolveViewedWorkflowRuns(scope);
	const store = resolveStore(scope);
	if (viewed.size > 0) {
		const liveRunIds = new Set(snapshot.runs.map((run) => run.id));
		for (const id of viewed) if (!liveRunIds.has(id)) viewed.delete(id);
	}
	const runs = snapshot.runs;
	let childrenByParent: Map<string, RunSnapshot[]> | undefined;
	for (const candidate of runs) {
		if (candidate.parentRunId === undefined) continue;
		childrenByParent ??= new Map();
		const list = childrenByParent.get(candidate.parentRunId);
		if (list === undefined) childrenByParent.set(candidate.parentRunId, [candidate]);
		else list.push(candidate);
	}
	const runById = childrenByParent === undefined ? undefined : new Map(runs.map((run) => [run.id, run]));

	const withViewed = (run: RunSnapshot, item: AgentPanelItem): AgentPanelItem =>
		viewed.has(run.id) === (item.viewed === true) ? item : { ...item, viewed: viewed.has(run.id) };
	if (cacheKey !== undefined) {
		const cached = snapshotItems.get(cacheKey);
		if (cached !== undefined) {
			return cached.map(({ run, item }) => {
				const elapsedMs = elapsedRunMs(run, run.endedAt ?? now);
				const tokens =
					pendingStageTokens === undefined
						? item.tokens
						: runTreeTokens(run, childrenByParent, runById, store, pendingStageTokens) || undefined;
				const updated =
					elapsedMs === item.elapsedMs && tokens === item.tokens
						? item
						: {
								...item,
								elapsedMs,
								...(tokens === undefined ? {} : { tokens }),
							};
				return withViewed(run, updated);
			});
		}
	}

	const indicator = createRunIndicatorStatusResolver(runs);
	const expand = createWorkflowGraphExpander(snapshot);

	const built: CachedPanelRun[] = topLevelWorkflowRuns(runs).map((run): CachedPanelRun => {
		const isLeaf = !childrenByParent?.has(run.id);
		const index = isLeaf ? runStageIndex(run) : undefined;
		const graph = isLeaf ? undefined : expand(run.id);
		const stages = graph?.stages ?? run.stages;
		const settled = index?.settled ?? settledStageCount(stages);
		const effective = effectiveRunStatus(run);
		// A live run blocked on a failed stage keeps `running` with `blockedAt` set when its failure is not one the
		// effective status reads as blocked, such as a stage whose session store stayed unreachable when it woke.
		const status = effective === "running" && run.blockedAt !== undefined ? "blocked" : effective;
		const quit = run.exitReason === "quit" || run.quitAt !== undefined;
		const live = !quit && (run.endedAt === undefined || run.resumable === true || run.blockedAt !== undefined);
		const state = quit ? "stopped" : panelState(status, indicator(run) === "awaiting_input", live);
		const stage =
			currentStage(index?.unfinished ?? stages) ??
			(status === "blocked" ? stages.find((candidate) => candidate.status === "failed") : undefined);
		const tools = graph?.tools ?? run.toolNodes;
		const runningTool = state === "running" || state === "input" ? latestRunningTool(tools) : undefined;
		const tool =
			runningTool ??
			(stage === undefined && (quit || state === "stopped" || state === "paused") ? tools.at(-1) : undefined);
		const endedAt = run.endedAt ?? (quit ? (run.quitAt ?? run.pausedAt) : undefined);
		const affordance = state === "input" ? pendingInputAffordance(run, runs) : undefined;
		const question = affordance?.message;
		const promptId = affordance === undefined ? undefined : serializePromptIdentity(affordance.identity);
		const choices = affordance === undefined ? undefined : choicesOf(runs, affordance.identity);
		const reason =
			state === "failed" || status === "blocked"
				? oneLine(
						run.error ??
							stages.find((candidate) => candidate.status === "failed")?.error ??
							run.stages.find((candidate) => candidate.status === "failed")?.error ??
							run.exitReason,
					)
				: undefined;
		const stageLabel =
			stage !== undefined
				? `stage ${inertLine(stage.name)}`
				: tool === undefined
					? undefined
					: `tool ${inertLine(tool.name)}`;
		const task =
			state === "input"
				? (question ?? stageLabel ?? "waiting for input")
				: state === "failed"
					? (reason ?? "failed")
					: status === "blocked"
						? [stageLabel, reason].filter(Boolean).join(" · ")
						: (stageLabel ?? "");
		const progressStages =
			runningTool !== undefined && settled === stages.length && runStageIndex(run).settled < run.stages.length
				? run.stages
				: stages;
		const done = progressStages === stages ? settled : runStageIndex(run).settled;
		const total = progressStages.length;
		const showProgress =
			status !== "blocked" &&
			(state === "running" || state === "paused" || state === "done") &&
			total > 0 &&
			!(runningTool !== undefined && done >= total);
		const tokens = runTreeTokens(run, childrenByParent, runById, store, pendingStageTokens);
		const item: AgentPanelItem = {
			id: `${PANEL_RUN_PREFIX}${run.id}`,
			kind: "workflow",
			state,
			name: sanitizePromptDisplay(run.name) ? inertLine(run.name) : "workflow",
			task,
			elapsedMs: elapsedRunMs(run, run.endedAt ?? now),
			...(tokens > 0 ? { tokens } : {}),
			...(showProgress ? { progress: { done, total } } : {}),
			...(question === undefined ? {} : { question }),
			...(state === "input" && choices?.length ? { choices } : {}),
			...(promptId === undefined ? {} : { promptId }),
			...(reason === undefined ? {} : { reason }),
			...(endedAt === undefined ? {} : { endedAt }),
			...(state === "paused" ? { runGeneration: String(run.runGeneration ?? 0) } : {}),
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

function resolveRawChoiceText(
	text: string,
	rawChoices: readonly string[] | undefined,
	displayChoices: readonly string[] | undefined,
): string {
	if (rawChoices === undefined || displayChoices === undefined || rawChoices.length !== displayChoices.length) {
		return text;
	}
	if (rawChoices.includes(text)) return text;
	const trimmed = text.trim();
	const exactRaw = rawChoices.find((choice) => choice.trim() === trimmed);
	if (exactRaw !== undefined) return exactRaw;
	const exactDisplay = displayChoices.findIndex((choice) => choice.trim() === trimmed);
	if (exactDisplay >= 0) return rawChoices[exactDisplay]!;
	const normalized = trimmed.toLowerCase();
	if (rawChoices.some((choice) => choice.trim().toLowerCase() === normalized)) return text;
	const index = displayChoices.findIndex((choice) => choice.trim().toLowerCase() === normalized);
	return index >= 0 ? rawChoices[index]! : text;
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
	const rawChoices = affordance === undefined ? undefined : rawChoicesOf(runs, affordance.identity);
	if (
		affordance === undefined ||
		options.promptId !== serializePromptIdentity(affordance.identity) ||
		(options.question !== undefined && options.question !== affordance.message) ||
		(!sameChoices(options.choices, currentChoices) && !sameChoices(options.choices, rawChoices))
	) {
		return {
			ok: false,
			reason:
				affordance === undefined
					? "No unique pending prompt matches the displayed question."
					: "The pending prompt changed before the answer was sent.",
		};
	}
	const choiceIndex = options.choiceIndex;
	if (
		choiceIndex !== undefined &&
		(!Number.isSafeInteger(choiceIndex) ||
			rawChoices === undefined ||
			choiceIndex < 0 ||
			choiceIndex >= rawChoices.length)
	) {
		return { ok: false, reason: "The selected choice is no longer available." };
	}
	const resolvedText =
		choiceIndex === undefined ? resolveRawChoiceText(text, rawChoices, currentChoices) : rawChoices![choiceIndex]!;
	const [ownerRunId, stageId, promptId] = affordance.identity;
	if (stageId === null) {
		const pending = owner.store.run(ownerRunId)?.pendingPrompt;
		if (pending === undefined || pending.id !== promptId) {
			return { ok: false, reason: `No matching pending prompt ${promptId}.` };
		}
		if (isPrimitivePrompt(pending)) {
			const coerced = coercePrimitivePromptAnswer(pending, resolvedText);
			if (!coerced.ok) return { ok: false, reason: primitivePromptAnswerRejection(promptId, pending) };
			const ok = owner.store.resolvePendingPrompt(ownerRunId, promptId, coerced.value);
			return ok ? { ok: true } : { ok: false, reason: `No matching pending prompt ${promptId}.` };
		}
		const ok = owner.store.resolvePendingPrompt(ownerRunId, promptId, resolvedText);
		return ok ? { ok: true } : { ok: false, reason: `No matching pending prompt ${promptId}.` };
	}
	const stageTarget = ownerRunId === runId ? stageId : `${ownerRunId}:${stageId}`;
	const result = await workflowAnswerAction(
		{ action: "answer", runId, stageId: stageTarget, promptId, text: resolvedText },
		owner,
	);
	return result.status === "ok" ? { ok: true } : { ok: false, reason: result.message ?? result.status };
}
