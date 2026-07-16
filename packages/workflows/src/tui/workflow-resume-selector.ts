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

export function openWorkflowResumeSelector(
  ui: WorkflowResumeSelectorUiSurface,
  liveRuns: readonly RunSnapshot[],
  durableEntries: readonly ResumableWorkflowEntry[],
  completedEntries: readonly ResumableWorkflowEntry[] = [],
  options: WorkflowResumeSelectorOptions = {},
): Promise<WorkflowResumeSelectorResult> {
  const custom = ui.custom;
  if (typeof custom !== "function") return Promise.resolve({ kind: "close" });

  const items = workflowResumeSelectorItems(liveRuns, durableEntries, completedEntries);

  const resultByPath = new Map(items.map((item) => [item.session.path, item.result]));
  let sessions = items.map((item) => item.session);
  const loadSessions = async (onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> => {
    onProgress?.(sessions.length, sessions.length);
    return [...sessions];
  };

  return new Promise<WorkflowResumeSelectorResult>((resolve) => {
    let settled = false;
    const settle = (result: WorkflowResumeSelectorResult, done?: (result: undefined) => void): void => {
      if (settled) return;
      settled = true;
      try {
        done?.(undefined);
      } finally {
        resolve(result);
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
        { showRenameHint: false },
      );
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
