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
}

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

function liveRunSession(run: RunSnapshot): WorkflowResumeSelectorItem {
  const completed = completedStageCount(run);
  const total = run.stages.length;
  const modified = new Date(latestRunTimestamp(run));
  const firstMessage = `${run.name}  ${run.status}  ${completed}/${total} stages`;
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
      allMessagesText: `${run.id} ${run.name} ${run.status} ${completed}/${total} stages`,
    },
  };
}

function durableWorkflowSession(
  entry: ResumableWorkflowEntry,
  kind: "durable" | "completed",
): WorkflowResumeSelectorItem {
  const checkpointText = `${entry.completedCheckpoints} checkpoints`;
  const promptText = `${entry.pendingPrompts} prompts`;
  const statusText = kind === "completed" ? "✓ completed" : entry.status;
  return {
    result: { kind, workflowId: entry.workflowId },
    session: {
      path: `workflow-${kind}:${entry.workflowId}`,
      id: entry.workflowId,
      cwd: kind === "completed" ? "Completed workflow runs" : "Durable workflow runs",
      created: new Date(entry.createdAt),
      modified: new Date(entry.updatedAt),
      messageCount: entry.completedCheckpoints,
      firstMessage: `${entry.name}  ${statusText}  ${checkpointText}  ${promptText}`,
      allMessagesText: `${entry.workflowId} ${entry.name} ${statusText} ${checkpointText} ${promptText}`,
      ...(kind === "completed" ? { messageColor: "success" as const } : {}),
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
  const liveItems = workflowResumeSelectorItems(liveRuns, [], []);
  let sessions = liveItems.map((item) => item.session);
  let resultByPath = new Map(liveItems.map((item) => [item.session.path, item.result]));
  let resolvedCatalog: WorkflowResumeCatalogRows = EMPTY_CATALOG;

  // Hydrate at most once even though both scope loaders point at it.
  let hydratePromise: Promise<WorkflowResumeCatalogRows> | undefined;
  const hydrateOnce = (): Promise<WorkflowResumeCatalogRows> => (hydratePromise ??= hydrate());

  const loadSessions = async (
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<SessionInfo[]> => {
    const catalog = await hydrateOnce();
    resolvedCatalog = catalog;
    const items = workflowResumeSelectorItems(liveRuns, catalog.durable, catalog.completed);
    sessions = items.map((item) => item.session);
    resultByPath = new Map(items.map((item) => [item.session.path, item.result]));
    onProgress?.(sessions.length, sessions.length);
    return [...sessions];
  };

  return new Promise<OpenWorkflowResumeSelectorResult>((resolve) => {
    let settled = false;
    let activeSelector: SessionSelectorComponent | undefined;
    const settle = (result: WorkflowResumeSelectorResult, done?: (result: undefined) => void): void => {
      if (settled) return;
      settled = true;
      // Cancel any late hydration/render and clear status timeouts.
      activeSelector?.dispose();
      try {
        done?.(undefined);
      } finally {
        resolve({ result, catalog: resolvedCatalog });
      }
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
