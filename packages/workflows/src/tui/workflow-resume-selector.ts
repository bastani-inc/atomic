import type { SessionInfo } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import type { DurableWorkflowDeleteOutcome } from "../durable/retention-policy.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import type { PiHostSessionPickerFunction, PiHostSessionPickerRow } from "../extension/wiring.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import { workflowIdentity } from "../shared/workflow-identity.js";

export type WorkflowResumeSelectorResult =
	| { kind: "live"; runId: string }
	| { kind: "durable"; workflowId: string }
	| { kind: "completed"; workflowId: string }
	| { kind: "close" };

/**
 * UI surface required by the resume picker. The host session-picker
 * capability is REQUIRED: both isolated (engine-child) and non-isolated
 * interactive hosts expose the identical `hostSessionPicker` API, so the
 * picker always mounts natively in the terminal process. There is no
 * remote-rendered fallback; `openWorkflowResumeSelector` rejects with an
 * actionable error when the capability is absent (e.g. a mismatched host).
 */
export interface WorkflowResumeSelectorUiSurface {
	hostSessionPicker?: PiHostSessionPickerFunction;
}

export interface WorkflowResumeSelectorOptions {
	readonly deleteWorkflow?: (workflowId: string) => Promise<DurableWorkflowDeleteOutcome>;
	/** Subscribe to local run-store changes; returns an unsubscribe function. */
	readonly watch?: (onChange: () => void) => () => void;
	/** Recompute every row: fresh live runs plus a re-hydrated catalog. */
	readonly refresh?: WorkflowResumeRefresh;
	/** Cross-session polling cadence while the picker is open. 0 disables. */
	readonly refreshIntervalMs?: number;
	/** The owning session's runs, used to follow resume sources of live rows. */
	readonly sessionRuns?: () => readonly RunSnapshot[];
	readonly durableBackend?: () => DurableWorkflowBackend | undefined;
}

export type WorkflowResumeRefresh = () => Promise<{
	readonly liveRuns: readonly RunSnapshot[];
	readonly catalog: WorkflowResumeCatalogRows;
}>;

interface WorkflowResumeSelectorItem {
	readonly result: Exclude<WorkflowResumeSelectorResult, { kind: "close" }>;
	readonly session: SessionInfo;
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

/**
 * Semantic row presentation: green completed, yellow paused, red failed and
 * blocked. Durable `running` rows only reach the picker once their heartbeat
 * is stale (nothing is executing them), so they present as crashed.
 */
function workflowStatusPresentation(
	status: string,
	kind: "live" | "durable" | "completed",
): WorkflowStatusPresentation {
	if (kind === "completed") return { label: "✓ completed", color: "success" };
	if (status === "paused") return { label: "paused", color: "warning" };
	if (status === "failed" || status === "blocked") return { label: status, color: "error" };
	if (kind === "durable" && status === "running") return { label: "crashed", color: "error" };
	return { label: status };
}

function liveRunSession(run: RunSnapshot, saved?: ResumableWorkflowEntry): WorkflowResumeSelectorItem {
	const completed = completedStageCount(run);
	const total = run.stages.length;
	const modified = new Date(latestRunTimestamp(run));
	const presentation = workflowStatusPresentation(run.status, "live");
	const stageText = `${completed}/${total} stages`;
	const identity = workflowIdentity(run.id, run.label ?? saved?.label, run.inputs);
	const summary = run.summary ?? saved?.summary;
	return {
		result: { kind: "live", runId: run.id },
		session: {
			path: `workflow-live:${run.id}`,
			id: run.id,
			cwd: "Live",
			created: new Date(run.startedAt),
			modified,
			messageCount: total,
			firstMessage: summary ? `${presentation.label} ${completed}/${total} ${run.name}  ${identity}` : identity,
			summary: summary || `${presentation.label}  ${stageText}  ${run.name}`,
			allMessagesText: `${run.id} ${identity} ${summary ?? ""} ${run.name} ${presentation.label} ${stageText}`,
			...(presentation.color !== undefined ? { messageColor: presentation.color } : {}),
		},
	};
}

function durableWorkflowSession(
	entry: ResumableWorkflowEntry,
	kind: "durable" | "completed",
): WorkflowResumeSelectorItem {
	const presentation = workflowStatusPresentation(entry.status, kind);
	const identity = workflowIdentity(entry.workflowId, entry.label, entry.inputs);
	return {
		result: { kind, workflowId: entry.workflowId },
		session: {
			path: `workflow-${kind}:${entry.workflowId}`,
			id: entry.workflowId,
			cwd: kind === "completed" ? "Completed" : "Durable",
			created: new Date(entry.createdAt),
			modified: new Date(entry.updatedAt),
			messageCount: entry.completedCheckpoints,
			firstMessage: entry.summary ? `${presentation.label} ${entry.name}  ${identity}` : identity,
			summary: entry.summary || `${presentation.label}  ${entry.name}`,
			allMessagesText: `${entry.workflowId} ${identity} ${entry.summary ?? ""} ${entry.name} ${presentation.label}`,
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
): WorkflowResumeSelectorItem[] {
	const classifiedLiveRuns = liveRuns.map((run) => ({
		run,
		resumable: isResumePickerLiveRun(run, sessionRuns, backend),
	}));
	const eligibleLiveRuns = classifiedLiveRuns.filter(({ resumable }) => resumable).map(({ run }) => run);
	const visibleLiveIds = new Set(eligibleLiveRuns.map((run) => run.id));
	// An actively executing live snapshot is intentionally not resumable here, but its durable
	// row remains the existing fallback. Other predicate-rejected snapshots must disappear from
	// the resumable row kinds, or a missing-artifact live run would reappear as a durable duplicate.
	const suppressedLiveIds = new Set(
		classifiedLiveRuns
			.filter(({ run, resumable }) => resumable || !(run.status === "running" && run.endedAt === undefined))
			.map(({ run }) => run.id),
	);
	const visibleDurableEntries = durableEntries.filter((entry) => !suppressedLiveIds.has(entry.workflowId));
	const durableIds = new Set(visibleDurableEntries.map((entry) => entry.workflowId));
	const savedEntries = new Map(completedEntries.map((entry) => [entry.workflowId, entry]));
	for (const entry of durableEntries) savedEntries.set(entry.workflowId, entry);
	return [
		...eligibleLiveRuns.map((run) => liveRunSession(run, savedEntries.get(run.id))),
		...visibleDurableEntries.map((entry) => durableWorkflowSession(entry, "durable")),
		...completedEntries
			.filter((entry) => !visibleLiveIds.has(entry.workflowId) && !durableIds.has(entry.workflowId))
			.map((entry) => durableWorkflowSession(entry, "completed")),
	].sort(compareResumeItemsByRecency);
}
export interface WorkflowResumeCatalogRows {
	readonly durable: readonly ResumableWorkflowEntry[];
	readonly completed: readonly ResumableWorkflowEntry[];
}

/**
 * Lazily produces the durable/completed catalog. Invoked at most once, after the
 * selector has already mounted with live rows, so resource/catalog loading stays
 * off the command's synchronous mount path.
 */
export type WorkflowResumeHydrate = () => Promise<WorkflowResumeCatalogRows>;

export interface OpenWorkflowResumeSelectorResult {
	readonly result: WorkflowResumeSelectorResult;
	/** The catalog resolved by hydrate(), for follow-on resume without a rescan. */
	readonly catalog: WorkflowResumeCatalogRows;
}

const EMPTY_CATALOG: WorkflowResumeCatalogRows = { durable: [], completed: [] };

export const WORKFLOW_RESUME_PICKER_UNAVAILABLE =
	"The workflow resume picker requires the host session-picker capability (ctx.ui.hostSessionPicker), " +
	"which this host does not expose. Update @bastani/atomic, or resume directly with: /workflow resume <id>";

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
	};
}

/**
 * Open the `/workflow resume` picker through the host session-picker
 * capability: the terminal host mounts the real `SessionSelectorComponent`,
 * so arrow-key navigation and search never cross the host⇄extension boundary
 * and stay instant even while this process hydrates the catalog or refreshes
 * the run store.
 *
 * Semantics: live rows seed the first frame, `hydrate()` runs once and merges
 * via a row update (errors keep the seeded rows and surface in-picker), watch
 * refreshes are debounced (250 ms) and polling defaults to 5 s, a failed
 * refresh keeps the previous rows, live rows cannot be deleted, and the
 * resolved catalog is returned with the result for follow-on resume.
 *
 * Rejects with `WORKFLOW_RESUME_PICKER_UNAVAILABLE` when the host does not
 * expose the capability — there is no remote-rendered fallback.
 */
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
	const liveItems = workflowResumeSelectorItems(
		currentLiveRuns,
		[],
		[],
		options.sessionRuns?.(),
		options.durableBackend?.(),
	);
	let sessions = liveItems.map((item) => item.session);
	let resultByPath = new Map(liveItems.map((item) => [item.session.path, item.result]));
	let settled = false;
	let stopWatching: (() => void) | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	const applyRows = (catalog: WorkflowResumeCatalogRows): void => {
		resolvedCatalog = catalog;
		const items = workflowResumeSelectorItems(
			currentLiveRuns,
			catalog.durable,
			catalog.completed,
			options.sessionRuns?.(),
			options.durableBackend?.(),
		);
		sessions = items.map((item) => item.session);
		resultByPath = new Map(items.map((item) => [item.session.path, item.result]));
	};

	// Deletion is extension-owned: the host keeps the row until update()/error().
	const handle = hostSessionPicker({
		sessions: sessions.map(toPickerRow),
		showRenameHint: false,
		onDelete: async (path) => {
			if (settled) return;
			const target = resultByPath.get(path);
			if (target === undefined || target.kind === "live") {
				handle.error("Cannot delete an in-flight workflow run");
				return;
			}
			if (options.deleteWorkflow === undefined) {
				handle.error("Workflow history deletion is unavailable");
				return;
			}
			const outcome = await options.deleteWorkflow(target.workflowId);
			if (settled) return;
			if (!outcome.ok) {
				handle.error(outcome.message);
				return;
			}
			resultByPath.delete(path);
			sessions = sessions.filter((session) => session.path !== path);
			handle.update(sessions.map(toPickerRow));
		},
	});

	// Frame-1 seed is the cheap in-memory live rows; the durable/completed
	// catalog hydrates once, asynchronously, and merges via a row update.
	// Hydrate errors keep the live rows on screen (error surfaces in-header).
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

	// Live updates: re-list rows on local run-store changes and on a bounded
	// cross-session poll; a failed refresh keeps the previous rows.
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
			// Keep the previous rows on a failed refresh; the next tick retries.
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
		stopWatching = options.watch(scheduleRefresh);
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
