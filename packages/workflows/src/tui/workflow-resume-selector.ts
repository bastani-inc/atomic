import { type SessionInfo, sliceHead } from "@bastani/atomic";
import * as bundledManifest from "../../builtin/index.js";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { durableWorkflowRunSnapshots } from "../durable/completed-catalog.js";
import { isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import type { DurableWorkflowDeleteOutcome } from "../durable/retention-policy.js";
import { priorRunAccounting, priorRunElapsedMs, recordedRunTotals } from "../durable/run-timing.js";
import { availableStoreDurableBackend } from "../durable/store-backend.js";
import type {
	DurableCheckpoint,
	DurableStageCheckpoint,
	DurableWorkflowHandle,
	ResumableWorkflowEntry,
} from "../durable/types.js";
import type { PiHostSessionPickerFunction, PiHostSessionPickerRow } from "../extension/wiring.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { store as defaultStore } from "../shared/store.js";
import type { RunSnapshot, StageSnapshot, StageStatus } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import type { WorkflowDefinition } from "../shared/types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import { workflowIdentity } from "../shared/workflow-identity.js";
import { normalizeWorkflowName } from "../workflows/identity.js";

export type WorkflowResumeSelectorResult =
	| { kind: "live"; runId: string }
	| { kind: "durable"; workflowId: string }
	| { kind: "completed"; workflowId: string }
	| { kind: "close" };

export interface WorkflowResumeSelectorUiSurface {
	hostSessionPicker?: PiHostSessionPickerFunction;
}

export interface WorkflowResumeSelectorOptions {
	readonly deleteWorkflow?: (workflowId: string) => Promise<DurableWorkflowDeleteOutcome>;
	readonly watch?: (onChange: () => void) => () => void;
	readonly refresh?: WorkflowResumeRefresh;
	readonly refreshIntervalMs?: number;
	readonly sessionRuns?: () => readonly RunSnapshot[];
	readonly durableBackend?: () => DurableWorkflowBackend | undefined;
	readonly resolveDescription?: (name: string, cwd?: string) => string | undefined;
}

export type WorkflowResumeRefresh = () => Promise<{
	readonly liveRuns: readonly RunSnapshot[];
	readonly catalog: WorkflowResumeCatalogRows;
}>;

export interface WorkflowResumeSelectorItem {
	readonly result: Exclude<WorkflowResumeSelectorResult, { kind: "close" }>;
	readonly session: SessionInfo;
}

export interface WorkflowResumeSelectorItemsOptions {
	readonly includeCompletedWithoutResumable?: boolean;
	readonly resolveDescription?: (name: string, cwd?: string) => string | undefined;
	readonly overviewCheckpoints?: ReadonlyMap<string, readonly DurableCheckpoint[]>;
}

function latestStageTimestamp(stage: StageSnapshot): number {
	return stage.endedAt ?? stage.startedAt ?? 0;
}

function latestRunTimestamp(run: RunSnapshot): number {
	const stageTimes = run.stages.map(latestStageTimestamp);
	return Math.max(run.endedAt ?? 0, run.resumedAt ?? 0, run.pausedAt ?? 0, run.startedAt, ...stageTimes);
}

function completedStageCount(run: RunSnapshot): number {
	return run.stages.filter((stage) => stage.status === "completed" || stage.status === "failed").length;
}

function isResumePickerLiveRun(
	run: RunSnapshot,
	sessionRuns: readonly RunSnapshot[] | undefined,
	backend?: DurableWorkflowBackend,
): boolean {
	return isWorkflowRunResumable(workflowRunResumeCandidate(run, sessionRuns, backend));
}

interface WorkflowStatusPresentation {
	readonly label: string;
	readonly color?: "success" | "warning" | "error";
}

function liveRunStatus(run: RunSnapshot): string {
	const effective = effectiveRunStatus(run);
	if (
		effective === "blocked" ||
		run.stages.some((stage) => stage.status === "blocked") ||
		(effective === "running" && run.failureRecoverability === "recoverable" && run.exitReason !== "quit")
	) {
		return "blocked";
	}
	if (
		effective === "paused" ||
		run.exitReason === "quit" ||
		run.quitAt !== undefined ||
		run.stages.some((stage) => stage.status === "paused") ||
		effective === "running"
	) {
		return "paused";
	}
	return effective;
}

function workflowStatusPresentation(
	status: string,
	kind: "live" | "durable" | "completed",
	exitReason?: string,
): WorkflowStatusPresentation {
	if (kind === "completed") return { label: "✓ completed", color: "success" };
	if (status === "paused" || exitReason === "quit") return { label: "paused", color: "warning" };
	if (status === "failed" || status === "blocked") return { label: status, color: "error" };
	if (kind === "durable" && status === "running") return { label: "crashed", color: "error" };
	return { label: status };
}

function shortDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function shortAgo(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "yesterday" : `${days}d ago`;
}

function shortReason(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const first =
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0 && !/^at\s+\S.*(?::\d+:\d+\)?|\((?:native|<anonymous>)\))$/.test(line)) ?? "";
	const clean = first.replace(/^(Error|[A-Z][A-Za-z]*Error):\s*/, "");
	if (!clean) return undefined;
	return clean.length > 60 ? `${sliceHead(clean, 59)}…` : clean;
}

function runStageText(
	run: Pick<RunSnapshot, "status" | "failedStageId" | "stages">,
	possibleStages?: readonly string[],
): string | undefined {
	const recordedTotal = run.stages.length;
	if (recordedTotal === 0) return undefined;
	const topLevelPossible = (possibleStages ?? []).filter(
		(entry) => entry.length > 0 && !entry.includes("/") && !entry.includes("*"),
	);
	const total =
		run.status !== "completed" &&
		topLevelPossible.length > recordedTotal &&
		run.stages.every((stage) => topLevelPossible.includes(stage.name))
			? topLevelPossible.length
			: recordedTotal;
	const current =
		(run.failedStageId ? run.stages.find((stage) => stage.id === run.failedStageId) : undefined) ??
		run.stages.find((stage) => stage.status === "failed" || stage.status === "blocked") ??
		run.stages.find(
			(stage) =>
				stage.status === "running" ||
				stage.status === "paused" ||
				stage.status === "awaiting_input" ||
				stage.status === "suspended",
		);
	const settledStages = run.stages.filter((stage) => stage.status !== "pending" && stage.status !== "running");
	const index = current ? run.stages.indexOf(current) + 1 : Math.min(total, settledStages.length);
	if (index <= 0) return undefined;
	const stageName = (current ?? settledStages.at(-1))?.name;
	return `stage ${index}/${total}${stageName ? ` ${stageName}` : ""}`;
}

function formatRunCost(cost: number | undefined): string | undefined {
	if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return undefined;
	if (cost >= 0.01) return `$${cost.toFixed(2)}`;
	if (cost >= 0.001) return `$${cost.toFixed(3)}`;
	return `$${cost.toPrecision(2)}`;
}

function stageAttemptsCost(stages: readonly StageSnapshot[]): number {
	let total = 0;
	for (const stage of stages) {
		for (const attempt of stage.modelAttempts ?? []) {
			total += attempt.usage?.cost ?? 0;
		}
	}
	return total;
}

type RecordedRunTotals = ReturnType<typeof recordedRunTotals>;

function runCost(
	run: RunSnapshot | undefined,
	backend: DurableWorkflowBackend | undefined,
	workflowId: string,
	recorded?: RecordedRunTotals,
): number | undefined {
	const accountingCost = run?.budgetState?.accounting?.cost;
	if (accountingCost !== undefined && accountingCost > 0) return accountingCost;
	const durableCost =
		(backend !== undefined ? priorRunAccounting(backend, workflowId)?.cost : undefined) ?? recorded?.accounting?.cost;
	if (durableCost !== undefined && durableCost > 0) return durableCost;
	const attemptsCost = run !== undefined ? stageAttemptsCost(run.stages) : 0;
	return attemptsCost > 0 ? attemptsCost : undefined;
}

function resolveRunBranch(
	run: RunSnapshot | undefined,
	entry: ResumableWorkflowEntry | undefined,
	handle: DurableWorkflowHandle | undefined,
): string | undefined {
	const branch =
		handle?.workspace?.branch ??
		handle?.branch ??
		(entry as { readonly workspace?: { readonly branch?: string } } | undefined)?.workspace?.branch ??
		entry?.branch ??
		(run as { readonly workspace?: { readonly branch?: string }; readonly branch?: string } | undefined)?.workspace
			?.branch ??
		run?.branch;
	return branch?.trim() || undefined;
}

let bundledDescriptions: ReadonlyMap<string, string> | undefined;

function getBundledDescriptions(): ReadonlyMap<string, string> {
	if (bundledDescriptions !== undefined) return bundledDescriptions;
	const map = new Map<string, string>();
	for (const value of Object.values(bundledManifest)) {
		const def = value as Partial<Pick<WorkflowDefinition, "name" | "normalizedName" | "description">> | undefined;
		if (def && typeof def.name === "string" && typeof def.description === "string" && def.description.trim()) {
			const clean = def.description.replace(/\s+/g, " ").trim();
			map.set(normalizeWorkflowName(def.name), clean);
			if (typeof def.normalizedName === "string") map.set(def.normalizedName, clean);
		}
	}
	bundledDescriptions = map;
	return map;
}

function resolveWorkflowDescription(
	name: string,
	cwd: string | undefined,
	customResolver?: (name: string, cwd?: string) => string | undefined,
): string | undefined {
	const fromCustom = customResolver?.(name, cwd)?.replace(/\s+/g, " ").trim();
	if (fromCustom) return fromCustom;
	return getBundledDescriptions().get(normalizeWorkflowName(name));
}

const durableSnapshotCache = new WeakMap<
	DurableWorkflowBackend,
	Map<
		string,
		{
			readonly key: string;
			readonly overview: readonly DurableCheckpoint[] | undefined;
			readonly snapshot: RunSnapshot | undefined;
		}
	>
>();

function fallbackStagesFromCheckpoints(
	checkpoints: readonly DurableCheckpoint[],
	workflowId: string,
): readonly StageSnapshot[] {
	const groups = new Map<string, StageSnapshot>();
	for (const checkpoint of checkpoints) {
		if (checkpoint.kind !== "stage") continue;
		const stageCheckpoint = checkpoint as DurableStageCheckpoint;
		if (stageCheckpoint.topology?.boundary !== undefined) continue;
		if (stageCheckpoint.topology?.run !== undefined && stageCheckpoint.topology.run.runId !== workflowId) continue;
		const key = stageCheckpoint.replayKey || stageCheckpoint.topology?.stageId || stageCheckpoint.checkpointId;
		const previous = groups.get(key);
		const rawStatus = stageCheckpoint.topology?.status;
		let status: StageStatus =
			stageCheckpoint.output !== undefined || rawStatus === "completed"
				? "completed"
				: rawStatus === "failed"
					? "failed"
					: rawStatus === "skipped"
						? "skipped"
						: rawStatus === "paused"
							? "paused"
							: "running";
		if (previous?.status === "completed" || previous?.status === "failed" || previous?.status === "skipped") {
			status = previous.status;
		}
		const startedAt = previous?.startedAt ?? stageCheckpoint.startedAt ?? stageCheckpoint.completedAt;
		const endedAt =
			status === "running" || status === "paused"
				? undefined
				: (stageCheckpoint.endedAt ?? stageCheckpoint.completedAt ?? previous?.endedAt);
		groups.set(key, {
			id: stageCheckpoint.topology?.stageId ?? key,
			name: stageCheckpoint.name,
			status,
			parentIds: stageCheckpoint.topology?.parentIds ?? previous?.parentIds ?? [],
			...(startedAt !== undefined ? { startedAt } : {}),
			...(endedAt !== undefined ? { endedAt } : {}),
			...(stageCheckpoint.durationMs !== undefined
				? { durationMs: stageCheckpoint.durationMs }
				: previous?.durationMs !== undefined
					? { durationMs: previous.durationMs }
					: {}),
			...(stageCheckpoint.modelAttempts !== undefined
				? { modelAttempts: stageCheckpoint.modelAttempts }
				: previous?.modelAttempts !== undefined
					? { modelAttempts: previous.modelAttempts }
					: {}),
			toolEvents: [],
		});
	}
	return [...groups.values()];
}

function cachedDurableRunSnapshot(
	backend: DurableWorkflowBackend | undefined,
	handle: DurableWorkflowHandle | undefined,
	entry: ResumableWorkflowEntry,
	overview?: readonly DurableCheckpoint[],
	recorded?: RecordedRunTotals,
): RunSnapshot | undefined {
	if (backend === undefined || handle === undefined) return undefined;
	const key = `${handle.status}:${handle.updatedAt}:${handle.completedCheckpoints}`;
	let byWorkflow = durableSnapshotCache.get(backend);
	if (byWorkflow === undefined) {
		byWorkflow = new Map();
		durableSnapshotCache.set(backend, byWorkflow);
	}
	const cached = byWorkflow.get(entry.workflowId);
	if (cached !== undefined && cached.key === key && cached.overview === overview) return cached.snapshot;

	let snapshot = durableWorkflowRunSnapshots(backend, handle)[0];
	if (snapshot === undefined || snapshot.stages.length === 0) {
		const stages = fallbackStagesFromCheckpoints(
			overview ?? backend.listCheckpoints(entry.workflowId),
			entry.workflowId,
		);
		if (stages.length > 0) {
			const priorDurationMs = priorRunElapsedMs(backend, entry.workflowId) ?? recorded?.elapsedMs;
			const terminal = handle.status === "completed" || handle.status === "failed" || handle.status === "cancelled";
			snapshot = {
				id: handle.workflowId,
				name: handle.name,
				inputs: { ...handle.inputs },
				status: handle.status,
				stages: [...stages],
				toolNodes: [],
				startedAt: handle.createdAt,
				...(terminal
					? {
							endedAt: handle.updatedAt,
							durationMs: priorDurationMs ?? Math.max(0, handle.updatedAt - handle.createdAt),
						}
					: priorDurationMs !== undefined
						? { accumulatedDurationMs: priorDurationMs }
						: {}),
				...(handle.branch !== undefined
					? { branch: handle.branch }
					: entry.branch !== undefined
						? { branch: entry.branch }
						: {}),
				resumable: entry.resumable ?? true,
			};
		}
	}
	byWorkflow.set(entry.workflowId, { key, overview, snapshot });
	return snapshot;
}

function durableRunElapsedMs(
	entry: ResumableWorkflowEntry,
	reconstructed: RunSnapshot | undefined,
	sessionRun: RunSnapshot | undefined,
	backend: DurableWorkflowBackend | undefined,
	handle: DurableWorkflowHandle | undefined,
	overview?: readonly DurableCheckpoint[],
	recordedTotals?: RecordedRunTotals,
): number | undefined {
	const recorded =
		(backend !== undefined ? priorRunElapsedMs(backend, entry.workflowId) : undefined) ?? recordedTotals?.elapsedMs;
	if (recorded !== undefined && recorded > 0) return recorded;
	if (sessionRun !== undefined && sessionRun.stages.length > 0) {
		const liveElapsed = elapsedRunMs(sessionRun, sessionRun.endedAt ?? entry.updatedAt);
		if (liveElapsed > 0) return liveElapsed;
	}
	if (reconstructed !== undefined && reconstructed.stages.length > 0) {
		const snapElapsed =
			reconstructed.durationMs ??
			reconstructed.accumulatedDurationMs ??
			(entry.updatedAt > entry.createdAt ? entry.updatedAt - entry.createdAt : 0);
		if (snapElapsed > 0) return snapElapsed;
	}
	if (
		handle !== undefined &&
		backend !== undefined &&
		(backend.listCheckpoints(entry.workflowId).length > 0 || (overview?.length ?? 0) > 0) &&
		entry.updatedAt > entry.createdAt
	) {
		return entry.updatedAt - entry.createdAt;
	}
	return undefined;
}

function isInFlightStoreRun(run: RunSnapshot | undefined): boolean {
	return (
		run !== undefined &&
		run.status !== "completed" &&
		(run.endedAt === undefined || run.status === "paused" || run.exitReason === "quit")
	);
}

function isDeletableLiveRun(run: RunSnapshot, handle: DurableWorkflowHandle | undefined): boolean {
	return !isInFlightStoreRun(run) && liveRunStatus(run) !== "paused" && handle?.status !== "running";
}

function isDeletableDurableEntry(
	entry: ResumableWorkflowEntry,
	kind: "durable" | "completed",
	sessionRun: RunSnapshot | undefined,
	handle: DurableWorkflowHandle | undefined,
): boolean {
	if (isInFlightStoreRun(sessionRun)) return false;
	if (kind === "completed") return true;
	return entry.status !== "running" && handle?.status !== "running";
}

function workflowRowTitle(
	name: string,
	id: string,
	identity: string,
	cwd: string | undefined,
	options?: WorkflowResumeSelectorItemsOptions,
): string {
	const description = identity === id ? resolveWorkflowDescription(name, cwd, options?.resolveDescription) : identity;
	return description ? `${name} · ${description}` : name;
}

function joinDetail(parts: readonly (string | undefined)[]): string {
	return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

function liveRunSession(
	run: RunSnapshot,
	now: number,
	saved?: ResumableWorkflowEntry,
	backend?: DurableWorkflowBackend,
	options?: WorkflowResumeSelectorItemsOptions,
): WorkflowResumeSelectorItem {
	const handle = backend?.getWorkflow(run.id);
	const completed = completedStageCount(run);
	const total = run.stages.length;
	const modified = new Date(latestRunTimestamp(run));
	const status = liveRunStatus(run);
	const presentation = workflowStatusPresentation(status, "live", run.exitReason);
	const stageText = `${completed}/${total} stages`;
	const identity = workflowIdentity(run.id, run.label ?? saved?.label, run.inputs);
	const cwd =
		saved?.gitWorktreeRoot ??
		saved?.workflowCwd ??
		saved?.invocationCwd ??
		handle?.gitWorktreeRoot ??
		handle?.workflowCwd ??
		handle?.invocationCwd;
	const summary = run.summary ?? saved?.summary;
	const cost = formatRunCost(runCost(run, backend, run.id));
	const branch = resolveRunBranch(run, saved, handle);
	const failed = status === "failed" || status === "blocked";
	const reason = shortReason(
		run.error ?? run.stages.find((stage) => stage.status === "failed")?.error ?? run.exitReason,
	);
	const detail = joinDetail([
		presentation.label,
		runStageText(run, run.possibleStages ?? handle?.possibleStages),
		shortAgo(now - modified.getTime()),
		shortDuration(elapsedRunMs(run, now)),
		cost,
		branch,
		failed && reason ? `✗ ${reason}` : undefined,
		summary?.replace(/\s+/g, " ").trim(),
	]);
	const canDelete = isDeletableLiveRun(run, handle);
	return {
		result: { kind: "live", runId: run.id },
		session: {
			title: workflowRowTitle(run.name, run.id, identity, cwd, options),
			detail,
			...(handle === undefined ? {} : { resumeSelection: { updatedAt: saved?.updatedAt ?? handle.updatedAt } }),
			path: `workflow-live:${run.id}`,
			id: run.id,
			cwd: "Live",
			created: new Date(run.startedAt),
			modified,
			messageCount: total,
			firstMessage: summary ? `${presentation.label} ${completed}/${total} ${run.name}  ${identity}` : identity,
			summary: summary || `${presentation.label}  ${stageText}  ${run.name}`,
			allMessagesText: `${run.id} ${identity} ${summary ?? ""} ${run.name} ${presentation.label} ${stageText}`,
			canDelete,
			...(presentation.color !== undefined ? { messageColor: presentation.color } : {}),
		},
	};
}

export function durableWorkflowSession(
	entry: ResumableWorkflowEntry,
	kind: "durable" | "completed",
	now: number,
	sessionRun?: RunSnapshot,
	backend?: DurableWorkflowBackend,
	options?: WorkflowResumeSelectorItemsOptions,
): WorkflowResumeSelectorItem {
	const handle = backend?.getWorkflow(entry.workflowId);
	const overview = options?.overviewCheckpoints?.get(entry.workflowId);
	const recorded = overview === undefined ? undefined : recordedRunTotals(overview);
	const reconstructed =
		sessionRun !== undefined && sessionRun.stages.length > 0
			? sessionRun
			: cachedDurableRunSnapshot(backend, handle, entry, overview, recorded);
	const presentation = workflowStatusPresentation(entry.status, kind, entry.exitReason);
	const identity = workflowIdentity(
		entry.workflowId,
		entry.label ?? sessionRun?.label,
		entry.inputs ?? sessionRun?.inputs,
	);
	const cwd =
		entry.gitWorktreeRoot ??
		entry.workflowCwd ??
		entry.invocationCwd ??
		handle?.gitWorktreeRoot ??
		handle?.workflowCwd ??
		handle?.invocationCwd;
	const possibleStages = sessionRun?.possibleStages ?? handle?.possibleStages;
	const stageDetail = reconstructed !== undefined ? runStageText(reconstructed, possibleStages) : undefined;
	const elapsedMs = durableRunElapsedMs(entry, reconstructed, sessionRun, backend, handle, overview, recorded);
	const cost = formatRunCost(runCost(reconstructed ?? sessionRun, backend, entry.workflowId, recorded));
	const branch = resolveRunBranch(reconstructed ?? sessionRun, entry, handle);
	const reason =
		entry.status === "failed" || entry.status === "blocked"
			? shortReason(entry.error ?? entry.exitReason)
			: undefined;
	const summary = entry.summary ?? sessionRun?.summary;
	const canDelete = isDeletableDurableEntry(entry, kind, sessionRun, handle);
	return {
		result: { kind, workflowId: entry.workflowId },
		session: {
			title: workflowRowTitle(entry.name, entry.workflowId, identity, cwd, options),
			detail: joinDetail([
				presentation.label,
				stageDetail,
				entry.pendingPrompts > 0
					? `waiting on ${entry.pendingPrompts} ${entry.pendingPrompts === 1 ? "answer" : "answers"}`
					: undefined,
				shortAgo(now - entry.updatedAt),
				elapsedMs !== undefined ? shortDuration(elapsedMs) : undefined,
				cost,
				branch,
				reason ? `✗ ${reason}` : undefined,
				summary?.replace(/\s+/g, " ").trim(),
			]),
			resumeSelection: { updatedAt: entry.updatedAt },
			path: `workflow-${kind}:${entry.workflowId}`,
			id: entry.workflowId,
			cwd: kind === "completed" ? "Completed" : "Durable",
			created: new Date(entry.createdAt),
			modified: new Date(entry.updatedAt),
			messageCount: entry.completedCheckpoints,
			firstMessage: summary ? `${presentation.label} ${entry.name}  ${identity}` : identity,
			summary: summary || `${presentation.label}  ${entry.name}`,
			allMessagesText: `${entry.workflowId} ${identity} ${summary ?? ""} ${entry.name} ${presentation.label}`,
			canDelete,
			...(presentation.color !== undefined ? { messageColor: presentation.color } : {}),
		},
	};
}

function compareResumeItemsByRecency(left: WorkflowResumeSelectorItem, right: WorkflowResumeSelectorItem): number {
	const recencyDifference = right.session.modified.getTime() - left.session.modified.getTime();
	if (recencyDifference !== 0) return recencyDifference;
	const idDifference = left.session.id.localeCompare(right.session.id);
	return idDifference !== 0 ? idDifference : left.session.path.localeCompare(right.session.path);
}

export function workflowResumeSelectorItems(
	liveRuns: readonly RunSnapshot[],
	durableEntries: readonly ResumableWorkflowEntry[],
	completedEntries: readonly ResumableWorkflowEntry[] = [],
	sessionRuns?: readonly RunSnapshot[],
	backend?: DurableWorkflowBackend,
	now = Date.now(),
	options?: WorkflowResumeSelectorItemsOptions,
): WorkflowResumeSelectorItem[] {
	const effectiveBackend = backend ?? availableStoreDurableBackend(defaultStore);
	const classifiedLiveRuns = liveRuns.map((run) => ({
		run,
		resumable: isResumePickerLiveRun(run, sessionRuns, backend),
	}));
	const eligibleLiveRuns = classifiedLiveRuns.filter(({ resumable }) => resumable).map(({ run }) => run);
	const visibleLiveIds = new Set(eligibleLiveRuns.map((run) => run.id));
	const suppressedLiveIds = new Set(
		classifiedLiveRuns
			.filter(({ run, resumable }) => resumable || !(run.status === "running" && run.endedAt === undefined))
			.map(({ run }) => run.id),
	);
	const visibleDurableEntries = durableEntries.filter((entry) => !suppressedLiveIds.has(entry.workflowId));
	if (
		eligibleLiveRuns.length === 0 &&
		visibleDurableEntries.length === 0 &&
		options?.includeCompletedWithoutResumable !== true
	) {
		return [];
	}
	const durableIds = new Set(visibleDurableEntries.map((entry) => entry.workflowId));
	const savedEntries = new Map(completedEntries.map((entry) => [entry.workflowId, entry]));
	for (const entry of durableEntries) savedEntries.set(entry.workflowId, entry);
	const sessionRunsById = new Map((sessionRuns ?? []).map((run) => [run.id, run]));
	for (const run of liveRuns) if (!sessionRunsById.has(run.id)) sessionRunsById.set(run.id, run);
	return [
		...eligibleLiveRuns.map((run) => liveRunSession(run, now, savedEntries.get(run.id), effectiveBackend, options)),
		...visibleDurableEntries.map((entry) =>
			durableWorkflowSession(
				entry,
				"durable",
				now,
				sessionRunsById.get(entry.workflowId),
				effectiveBackend,
				options,
			),
		),
		...completedEntries
			.filter((entry) => !visibleLiveIds.has(entry.workflowId) && !durableIds.has(entry.workflowId))
			.map((entry) =>
				durableWorkflowSession(
					entry,
					"completed",
					now,
					sessionRunsById.get(entry.workflowId),
					effectiveBackend,
					options,
				),
			),
	].sort(compareResumeItemsByRecency);
}

export interface WorkflowResumeCatalogRows {
	readonly durable: readonly ResumableWorkflowEntry[];
	readonly completed: readonly ResumableWorkflowEntry[];
}

export type WorkflowResumeHydrate = () => Promise<WorkflowResumeCatalogRows>;

export interface OpenWorkflowResumeSelectorResult {
	readonly result: WorkflowResumeSelectorResult;
	readonly catalog: WorkflowResumeCatalogRows;
}

const EMPTY_CATALOG: WorkflowResumeCatalogRows = { durable: [], completed: [] };

export const WORKFLOW_RESUME_PICKER_UNAVAILABLE =
	"The workflow resume picker requires the host session-picker capability (ctx.ui.hostSessionPicker), " +
	'which this host does not expose. Update @bastani/atomic, or ask the agent to resume the run with workflow({ action: "resume", runId: "<id>" }).';

export function toWorkflowPickerRow(item: WorkflowResumeSelectorItem): PiHostSessionPickerRow {
	return {
		...toPickerRow(item.session),
		...(item.session.resumeSelection === undefined ? {} : { resumeSelection: item.session.resumeSelection }),
		canDelete: item.session.canDelete ?? item.result.kind !== "live",
	};
}

function toPickerRow(session: SessionInfo): PiHostSessionPickerRow {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		createdAt: session.created.getTime(),
		modifiedAt: session.modified.getTime(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		...(session.summary !== undefined ? { summary: session.summary } : {}),
		allMessagesText: session.allMessagesText,
		...(session.name !== undefined ? { name: session.name } : {}),
		...(session.messageColor !== undefined ? { messageColor: session.messageColor } : {}),
		...(session.title !== undefined ? { title: session.title } : {}),
		...(session.detail !== undefined ? { detail: session.detail } : {}),
	};
}

export function openWorkflowResumeSelector(
	ui: WorkflowResumeSelectorUiSurface,
	liveRuns: readonly RunSnapshot[],
	hydrate: WorkflowResumeHydrate,
	options: WorkflowResumeSelectorOptions = {},
): Promise<OpenWorkflowResumeSelectorResult> {
	const hostSessionPicker = ui.hostSessionPicker;
	if (typeof hostSessionPicker !== "function") {
		return Promise.reject(new Error(WORKFLOW_RESUME_PICKER_UNAVAILABLE));
	}

	let currentLiveRuns = liveRuns;
	let resolvedCatalog: WorkflowResumeCatalogRows = EMPTY_CATALOG;
	const deletedWorkflowIds = new Set<string>();
	const itemOptions: WorkflowResumeSelectorItemsOptions | undefined =
		options.resolveDescription === undefined ? undefined : { resolveDescription: options.resolveDescription };
	const liveItems = workflowResumeSelectorItems(
		currentLiveRuns,
		[],
		[],
		options.sessionRuns?.(),
		options.durableBackend?.(),
		undefined,
		itemOptions,
	);
	let sessions = liveItems.map((item) => item.session);
	let resultByPath = new Map(liveItems.map((item) => [item.session.path, item.result]));
	let canDeleteByPath = new Map(liveItems.map((item) => [item.session.path, toWorkflowPickerRow(item).canDelete]));
	let settled = false;
	let stopWatching: (() => void) | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	const applyRows = (catalog: WorkflowResumeCatalogRows): void => {
		resolvedCatalog =
			deletedWorkflowIds.size === 0
				? catalog
				: {
						durable: catalog.durable.filter((entry) => !deletedWorkflowIds.has(entry.workflowId)),
						completed: catalog.completed.filter((entry) => !deletedWorkflowIds.has(entry.workflowId)),
					};
		const items = workflowResumeSelectorItems(
			currentLiveRuns.filter((run) => !deletedWorkflowIds.has(run.id)),
			resolvedCatalog.durable,
			resolvedCatalog.completed,
			options.sessionRuns?.(),
			options.durableBackend?.(),
			undefined,
			itemOptions,
		);
		sessions = items.map((item) => item.session);
		resultByPath = new Map(items.map((item) => [item.session.path, item.result]));
		canDeleteByPath = new Map(items.map((item) => [item.session.path, toWorkflowPickerRow(item).canDelete]));
	};

	const handle = hostSessionPicker({
		sessions: sessions.map(toPickerRow),
		showRenameHint: false,
		title: "Resume workflow run",
		variant: "runs",
		onDelete: async (path) => {
			if (settled) return;
			const target = resultByPath.get(path);
			if (target === undefined || canDeleteByPath.get(path) !== true) {
				handle.error("Cannot delete an in-flight workflow run");
				return;
			}
			if (options.deleteWorkflow === undefined) {
				handle.error("Workflow history deletion is unavailable");
				return;
			}
			const workflowId = target.kind === "live" ? target.runId : target.workflowId;
			const outcome = await options.deleteWorkflow(workflowId);
			if (settled) return;
			if (!outcome.ok) {
				handle.error(outcome.message);
				return;
			}
			deletedWorkflowIds.add(workflowId);
			applyRows(resolvedCatalog);
			handle.update(sessions.map(toPickerRow));
		},
	});

	void hydrate()
		.then((catalog) => {
			if (settled) return;
			applyRows(catalog);
			handle.update(sessions.map(toPickerRow));
		})
		.catch((error: unknown) => {
			if (settled) return;
			const message = error instanceof Error ? error.message : String(error);
			handle.error(`Failed to load sessions: ${message}`);
		});

	let refreshing = false;
	const runRefresh = async (): Promise<void> => {
		const refresh = options.refresh;
		if (refresh === undefined || settled || refreshing) return;
		refreshing = true;
		try {
			const next = await refresh();
			if (settled) return;
			currentLiveRuns = next.liveRuns;
			applyRows(next.catalog);
			handle.update(sessions.map(toPickerRow));
		} catch {
		} finally {
			refreshing = false;
		}
	};
	const scheduleRefresh = (): void => {
		if (settled || debounceTimer !== undefined) return;
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			void runRefresh();
		}, 250);
		debounceTimer.unref?.();
	};
	if (options.watch !== undefined && options.refresh !== undefined) {
		const unsubscribe = options.watch(scheduleRefresh);
		if (typeof unsubscribe === "function") stopWatching = unsubscribe;
	}
	const intervalMs = options.refreshIntervalMs ?? 5_000;
	if (options.refresh !== undefined && intervalMs > 0) {
		refreshTimer = setInterval(() => {
			void runRefresh();
		}, intervalMs);
		refreshTimer.unref?.();
	}

	return handle.result.then((path): OpenWorkflowResumeSelectorResult => {
		settled = true;
		stopWatching?.();
		if (refreshTimer !== undefined) clearInterval(refreshTimer);
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		const result: WorkflowResumeSelectorResult =
			path === undefined ? { kind: "close" } : (resultByPath.get(path) ?? { kind: "close" });
		return { result, catalog: resolvedCatalog };
	});
}
