import { SessionSelectorComponent, type SessionInfo } from "@bastani/atomic";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import type {
  PiCustomComponent,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
} from "../extension/wiring.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";

export type WorkflowResumeSelectorResult =
  | { kind: "live"; runId: string }
  | { kind: "durable"; workflowId: string }
  | { kind: "close" };

export interface WorkflowResumeSelectorUiSurface {
  custom?: PiCustomOverlayFunction;
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

function durableWorkflowSession(entry: ResumableWorkflowEntry): WorkflowResumeSelectorItem {
  const checkpointText = `${entry.completedCheckpoints} checkpoints`;
  const promptText = `${entry.pendingPrompts} prompts`;
  const firstMessage = `${entry.name}  ${entry.status}  ${checkpointText}  ${promptText}`;
  return {
    result: { kind: "durable", workflowId: entry.workflowId },
    session: {
      path: `workflow-durable:${entry.workflowId}`,
      id: entry.workflowId,
      cwd: "Durable workflow runs",
      created: new Date(entry.createdAt),
      modified: new Date(entry.updatedAt),
      messageCount: entry.completedCheckpoints,
      firstMessage,
      allMessagesText: `${entry.workflowId} ${entry.name} ${entry.status} ${checkpointText} ${promptText}`,
    },
  };
}

export function workflowResumeSelectorItems(
  liveRuns: readonly RunSnapshot[],
  durableEntries: readonly ResumableWorkflowEntry[],
): WorkflowResumeSelectorItem[] {
  const liveIds = new Set(liveRuns.map((run) => run.id));
  return [
    ...liveRuns.map(liveRunSession),
    ...durableEntries
      .filter((entry) => !liveIds.has(entry.workflowId))
      .map(durableWorkflowSession),
  ];
}

export function openWorkflowResumeSelector(
  ui: WorkflowResumeSelectorUiSurface,
  liveRuns: readonly RunSnapshot[],
  durableEntries: readonly ResumableWorkflowEntry[],
): Promise<WorkflowResumeSelectorResult> {
  const custom = ui.custom;
  if (typeof custom !== "function") return Promise.resolve({ kind: "close" });

  const items = workflowResumeSelectorItems(liveRuns, durableEntries);

  const resultByPath = new Map(items.map((item) => [item.session.path, item.result]));
  const sessions = items.map((item) => item.session);
  const loadSessions = async (onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> => {
    onProgress?.(sessions.length, sessions.length);
    return [...sessions];
  };

  return new Promise<WorkflowResumeSelectorResult>((resolve) => {
    let settled = false;
    const settle = (result: WorkflowResumeSelectorResult, done?: (result: undefined) => void): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      done?.(undefined);
    };

    const factory = (
      tui: PiCustomOverlayFactoryTui,
      _theme: unknown,
      _keys: unknown,
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
      // Workflow rows are synthetic SessionInfo records. Reuse the /resume
      // selector chrome, but never let its session-file delete action touch a
      // path derived from a workflow id.
      selector.getSessionList().onDeleteSession = async () => {
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

    void custom(factory, { overlay: false });
  });
}
