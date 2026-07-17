import { SessionSelectorComponent, type SessionInfo } from "@bastani/atomic";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import type { DurableWorkflowDeleteOutcome } from "../durable/retention-policy.js";
import type {
  PiCustomComponent,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
  PiKeybindings,
  PiTheme,
} from "../extension/wiring.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";

export type WorkflowResumeSelectorResult =
  | { kind: "live"; runId: string }
  | { kind: "durable"; workflowId: string }
  | { kind: "completed"; workflowId: string }
  | { kind: "close" };

export interface WorkflowResumeSelectorUiSurface {
  custom?: PiCustomOverlayFunction;
}

export interface WorkflowResumeSelectorOptions {
  readonly deleteWorkflow?: (workflowId: string) => Promise<DurableWorkflowDeleteOutcome>;
  /** Subscribe to local run-store changes; returns an unsubscribe function. */
  readonly watch?: (onChange: () => void) => () => void;
  /** Recompute every row: fresh live runs plus a re-hydrated catalog. */
  readonly refresh?: WorkflowResumeRefresh;
  /** Cross-session polling cadence while the picker is open. 0 disables. */
  readonly refreshIntervalMs?: number;
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

interface WorkflowStatusPresentation {
  readonly label: string;
  readonly color?: "success" | "warning" | "error";
}

/**
 * Semantic row presentation: green completed, yellow paused, red failed and
 * blocked. Durable `running` rows only reach the picker once their heartbeat
 * is stale (nothing is executing them), so they present as crashed.
 */
function workflowStatusPresentation(status: string, kind: "live" | "durable" | "completed"): WorkflowStatusPresentation {
  if (kind === "completed") return { label: "✓ completed", color: "success" };
  if (status === "paused") return { label: "paused", color: "warning" };
  if (status === "failed" || status === "blocked") return { label: status, color: "error" };
  if (kind === "durable" && status === "running") return { label: "crashed", color: "error" };
  return { label: status };
}

function liveRunSession(run: RunSnapshot): WorkflowResumeSelectorItem {
  const completed = completedStageCount(run);
  const total = run.stages.length;
  const modified = new Date(latestRunTimestamp(run));
  const presentation = workflowStatusPresentation(run.status, "live");
  const firstMessage = `${run.name}  ${presentation.label}  ${completed}/${total} stages`;
  return {
    result: { kind: "live", runId: run.id },
    session: {
      path: `workflow-live:${run.id}`,
      id: run.id,
      cwd: "Live workflow runs",
      created: new Date(run.startedAt),
      modified,
      messageCount: total,
      firstMessage,
      allMessagesText: `${run.id} ${run.name} ${presentation.label} ${completed}/${total} stages`,
      ...(presentation.color !== undefined ? { messageColor: presentation.color } : {}),
    },
  };
}

function durableWorkflowSession(
  entry: ResumableWorkflowEntry,
  kind: "durable" | "completed",
): WorkflowResumeSelectorItem {
  const checkpointText = `${entry.completedCheckpoints} checkpoints`;
  const promptText = `${entry.pendingPrompts} prompts`;
  const presentation = workflowStatusPresentation(entry.status, kind);
  return {
    result: { kind, workflowId: entry.workflowId },
    session: {
      path: `workflow-${kind}:${entry.workflowId}`,
      id: entry.workflowId,
      cwd: kind === "completed" ? "Completed workflow runs" : "Durable workflow runs",
      created: new Date(entry.createdAt),
      modified: new Date(entry.updatedAt),
      messageCount: entry.completedCheckpoints,
      firstMessage: `${entry.name}  ${presentation.label}  ${checkpointText}  ${promptText}`,
      allMessagesText: `${entry.workflowId} ${entry.name} ${presentation.label} ${checkpointText} ${promptText}`,
      ...(presentation.color !== undefined ? { messageColor: presentation.color } : {}),
    },
  };
}

function compareResumeItemsByRecency(
  left: WorkflowResumeSelectorItem,
  right: WorkflowResumeSelectorItem,
): number {
  const recencyDifference = right.session.modified.getTime() - left.session.modified.getTime();
  if (recencyDifference !== 0) return recencyDifference;
  const idDifference = left.session.id.localeCompare(right.session.id);
  return idDifference !== 0 ? idDifference : left.session.path.localeCompare(right.session.path);
}

export function workflowResumeSelectorItems(
  liveRuns: readonly RunSnapshot[],
  durableEntries: readonly ResumableWorkflowEntry[],
  completedEntries: readonly ResumableWorkflowEntry[] = [],
): WorkflowResumeSelectorItem[] {
  const liveIds = new Set(liveRuns.map((run) => run.id));
  const durableIds = new Set(durableEntries.map((entry) => entry.workflowId));
  return [
    ...liveRuns.map(liveRunSession),
    ...durableEntries
      .filter((entry) => !liveIds.has(entry.workflowId))
      .map((entry) => durableWorkflowSession(entry, "durable")),
    ...completedEntries
      .filter((entry) => !liveIds.has(entry.workflowId) && !durableIds.has(entry.workflowId))
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

export function openWorkflowResumeSelector(
  ui: WorkflowResumeSelectorUiSurface,
  liveRuns: readonly RunSnapshot[],
  hydrate: WorkflowResumeHydrate,
  options: WorkflowResumeSelectorOptions = {},
): Promise<OpenWorkflowResumeSelectorResult> {
  const custom = ui.custom;
  if (typeof custom !== "function") {
    return Promise.resolve({ result: { kind: "close" }, catalog: EMPTY_CATALOG });
  }

  // Frame-1 seed: cheap in-memory live rows only. Durable/completed rows merge in
  // once the async hydrate() resolves; errors keep the live rows on screen.
  let currentLiveRuns = liveRuns;
  const liveItems = workflowResumeSelectorItems(currentLiveRuns, [], []);
  let sessions = liveItems.map((item) => item.session);
  let resultByPath = new Map(liveItems.map((item) => [item.session.path, item.result]));
  let resolvedCatalog: WorkflowResumeCatalogRows = EMPTY_CATALOG;

  const applyRows = (catalog: WorkflowResumeCatalogRows): void => {
    resolvedCatalog = catalog;
    const items = workflowResumeSelectorItems(currentLiveRuns, catalog.durable, catalog.completed);
    sessions = items.map((item) => item.session);
    resultByPath = new Map(items.map((item) => [item.session.path, item.result]));
  };

  // Hydrate at most once even though both scope loaders point at it.
  let hydratePromise: Promise<WorkflowResumeCatalogRows> | undefined;
  const hydrateOnce = (): Promise<WorkflowResumeCatalogRows> => (hydratePromise ??= hydrate());

  const loadSessions = async (
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<SessionInfo[]> => {
    applyRows(await hydrateOnce());
    onProgress?.(sessions.length, sessions.length);
    return [...sessions];
  };

  return new Promise<OpenWorkflowResumeSelectorResult>((resolve) => {
    let settled = false;
    let activeSelector: SessionSelectorComponent | undefined;
    let stopWatching: (() => void) | undefined;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let requestPickerRender: (() => void) | undefined;
    const settle = (result: WorkflowResumeSelectorResult, done?: (result: undefined) => void): void => {
      if (settled) return;
      settled = true;
      stopWatching?.();
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      // Cancel any late hydration/render and clear status timeouts.
      activeSelector?.dispose();
      try {
        done?.(undefined);
      } finally {
        resolve({ result, catalog: resolvedCatalog });
      }
    };

    // Live updates: the picker re-lists rows on local run-store changes and on
    // a bounded cross-session poll, so a workflow that pauses, fails, or
    // completes appears (and a freshly running one disappears) while open.
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
        activeSelector?.getSessionList().setSessions([...sessions], true);
        requestPickerRender?.();
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

    const factory = (
      tui: PiCustomOverlayFactoryTui,
      _theme: PiTheme,
      _keys: PiKeybindings,
      done: (result: undefined) => void,
    ): PiCustomComponent => {
      const selector = new SessionSelectorComponent(
        loadSessions,
        loadSessions,
        (path) => settle(resultByPath.get(path) ?? { kind: "close" }, done),
        () => settle({ kind: "close" }, done),
        () => settle({ kind: "close" }, done),
        () => tui.requestRender?.(),
        {
          showRenameHint: false,
          initialSessions: sessions.length > 0 ? [...sessions] : undefined,
        },
      );
      activeSelector = selector;
      const sessionList = selector.getSessionList();
      sessionList.onDeleteSession = async (path) => {
        const target = resultByPath.get(path);
        if (target === undefined || target.kind === "live") {
          sessionList.onError?.("Cannot delete an in-flight workflow run");
          tui.requestRender?.();
          return;
        }
        if (options.deleteWorkflow === undefined) {
          sessionList.onError?.("Workflow history deletion is unavailable");
          tui.requestRender?.();
          return;
        }
        const outcome = await options.deleteWorkflow(target.workflowId);
        if (!outcome.ok) {
          sessionList.onError?.(outcome.message);
        } else {
          resultByPath.delete(path);
          sessions = sessions.filter((session) => session.path !== path);
          sessionList.setSessions(sessions, true);
        }
        tui.requestRender?.();
      };
      selector.focused = true;

      requestPickerRender = () => tui.requestRender?.();
      if (options.watch !== undefined && options.refresh !== undefined) {
        stopWatching = options.watch(scheduleRefresh);
      }
      const intervalMs = options.refreshIntervalMs ?? 5_000;
      if (options.refresh !== undefined && intervalMs > 0) {
        refreshTimer = setInterval(() => { void runRefresh(); }, intervalMs);
        refreshTimer.unref?.();
      }

      return {
        render: (width) => selector.render(width),
        handleInput: (data) => selector.handleInput(data),
        invalidate: () => {
          selector.invalidate?.();
          tui.requestRender?.();
        },
        dispose: () => settle({ kind: "close" }),
      };
    };

    try {
      void Promise.resolve(custom(factory, { overlay: false })).catch(() => {
        settle({ kind: "close" });
      });
    } catch {
      settle({ kind: "close" });
    }
  });
}
