/** Shared fixtures for overlay graph tests. */
import assert from "node:assert/strict";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, StageInputRequest, StoreSnapshot, RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

export function makeStage(id: string, parentIds: string[] = []): StageSnapshot {
  return {
    id,
    name: id,
    status: "pending",
    parentIds,
    toolEvents: [],
  };
}

export function makePendingPrompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    id: "prompt-1",
    kind: "input",
    message: "Continue?",
    createdAt: Date.now(),
    ...overrides,
  };
}

export function makeInputRequest(overrides: Partial<StageInputRequest> = {}): StageInputRequest {
  return {
    id: "input-request-1",
    kind: "ask_user_question",
    createdAt: Date.now(),
    questions: [
      {
        question: "Which option should the workflow use?",
        header: "Choice",
        options: [{ label: "Use A" }, { label: "Use B" }],
      },
    ],
    ...overrides,
  };
}

export function makeAwaitingInputStage(
  id: string,
  parentIds: string[] = [],
  overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    ...makeStage(id, parentIds),
    status: "awaiting_input",
    awaitingInputSince: Date.now(),
    attachable: true,
    ...overrides,
  };
}

export function makeRun(stages: StageSnapshot[]): RunSnapshot {
  return {
    id: "run-1",
    name: "Test Run",
    inputs: {},
    status: "running",
    stages,
    startedAt: Date.now(),
  };
}

export function makeSnap(stages: StageSnapshot[]): StoreSnapshot {
  return {
    runs: [makeRun(stages)],
    notices: [],
    version: 1,
  };
}

export function makeRunPromptSnap(
  stages: StageSnapshot[],
  prompt: PendingPrompt,
): StoreSnapshot {
  return {
    runs: [{ ...makeRun(stages), pendingPrompt: prompt }],
    notices: [],
    version: 1,
  };
}

export type PromptResolution = { runId: string; promptId: string; response: unknown };

export function makeStore(snap: StoreSnapshot): Store {
  return {
    runs: () => snap.runs as RunSnapshot[],
    notices: () => [],
    activeRunId: () => snap.runs[0]?.id ?? null,
    recordRunStart: () => {},
    reconcileRunParentStage: () => false,
    recordStageStart: () => {},
    recordStageWorkflowChildRun: () => false,
    recordToolStart: () => {},
    recordToolEnd: () => {},
    recordStageEnd: () => {},
    recordStageAwaitingInput: () => false,
    recordStageInputRequest: () => false,
    clearStageInputRequest: () => false,
    recordRunEnd: () => false,
    recordRunBlocked: () => false,
    removeRun: () => false,
    recordNotice: () => {},
    ackNotice: () => false,
    recordPendingPrompt: () => false,
    resolvePendingPrompt: () => false,
    awaitPendingPrompt: () => Promise.reject(new Error("test stub")),
    recordStagePendingPrompt: () => false,
    resolveStagePendingPrompt: () => false,
    awaitStagePendingPrompt: () => Promise.reject(new Error("test stub")),
    recordStagePromptAnswer: () => false,
    recordStagePromptDraft: () => false,
    getStagePromptDraft: () => undefined,
    clearStagePromptDraft: () => false,
    getStagePromptAnswer: () => undefined,
    clearStagePromptAnswer: () => {},
    recordStageSession: () => false,
    recordStageAttachable: () => false,
    recordStageAttached: () => false,
    recordStageBlocked: () => false,
    recordStageUnblocked: () => false,
    recordStageNotice: () => false,
    recordStagePaused: () => false,
    recordStageResumed: () => false,
    recordRunPaused: () => false,
    recordRunResumed: () => false,
    snapshot: () => snap,
    clear: () => {},
    subscribe: () => () => {},
  };
}

export const defaultTheme = deriveGraphTheme({});
export const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const SGR_MOUSE_WHEEL_DOWN = "\x1b[<65;10;10M";

export function visibleText(lines: string[]): string {
  return lines.join("\n").replace(ANSI_RE, "");
}

export function assertVisibleWidths(lines: string[], width: number): void {
  for (const [idx, line] of lines.entries()) {
    assert.equal(
      visibleWidth(line),
      width,
      `line ${idx} expected visible width ${width}, got ${visibleWidth(line)}`,
    );
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForRenderCount(
  count: () => number,
  target: number,
  polls = 80,
  pollMs = 25,
): Promise<void> {
  for (let i = 0; i < polls && count() < target; i++) {
    await delay(pollMs);
  }
}

export function typeIntoView(view: GraphView, text: string): void {
  for (const key of text) view.handleInput(key);
}

// ---------------------------------------------------------------------------
// Layout tests
// ---------------------------------------------------------------------------

export function makeView(stages: StageSnapshot[], onClose?: () => void): GraphView {
  const snap = makeSnap(stages);
  const store = makeStore(snap);
  return new GraphView({
    mode: "overlay",
    runId: "run-1",
    store,
    graphTheme: defaultTheme,
    onClose,
  });
}
