/**
 * Tests for WorkflowGraphOverlayAdapter and overlay entrypoints.
 *
 * Every mount path goes through Pi / pi's real
 * `ctx.ui.custom(factory, options)` primitive. There is no legacy
 * object-shaped overlay path.
 *
 * Verifies:
 *   - buildGraphOverlayAdapter is a no-op when pi.ui.custom is absent.
 *   - open(runId) calls pi.ui.custom with overlay:true and full-screen
 *     overlayOptions (width/maxHeight 100%, margin 0).
 *   - The factory returns a PiCustomComponent that paints overlay-style
 *     content; when `tui.terminal.rows` is provided the component
 *     renders that many lines (full-screen) instead of the constant
 *     32-row fallback.
 *   - toggle() uses `setHidden`/`focus` rather than remounting.
 *   - close() releases the OverlayHandle (`hide`) and disposes the view.
 *   - F2 shortcut registration in extension factory calls
 *     overlay.open(activeRunId).
 *   - /workflow resume + /workflow attach + /workflow pause routing.
 *   - Graph-mode Ctrl+D / `h` never kills the run.
 *   - `q` kills and retains the active run for inspection (regression gate).
 */

import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { OverlayPiSurface } from "../../packages/workflows/src/tui/overlay-adapter.js";

export { buildGraphOverlayAdapter } from "../../packages/workflows/src/tui/overlay-adapter.js";
export type { OverlayPiSurface } from "../../packages/workflows/src/tui/overlay-adapter.js";
export { InteractiveMode };
export { initTheme };
import type {
  PiCustomComponent,
  PiCustomOverlayFactory,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayOptions,
  PiHostCustomUiStateListener,
  PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";

export type {
  PiCustomComponent,
  PiCustomOverlayFactory,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
  PiCustomOverlayOptions,
  PiHostCustomUiStateListener,
  PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

export {
  createStore,
  store as singletonStore,
} from "../../packages/workflows/src/shared/store.js";
export { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
export { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
export { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
export { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
export { Type } from "typebox";
export { default as factory } from "../../packages/workflows/src/extension/index.js";
import type {
  ExtensionAPI,
  PiCommandContext,
  PiCommandOptions,
} from "../../packages/workflows/src/extension/index.js";

export type {
  ExtensionAPI,
  PiCommandContext,
  PiCommandOptions,
} from "../../packages/workflows/src/extension/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface CapturedCustomCall {
  /** Real factory passed to ctx.ui.custom. */
  factory: PiCustomOverlayFactory;
  /** Options passed alongside the factory. */
  options: PiCustomOverlayOptions;
  /** Component returned by the factory after it was invoked. */
  component: PiCustomComponent;
  /** Handle surfaced to the adapter via options.onHandle. */
  handle: PiOverlayHandle;
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

export async function waitForStagePendingPrompt(
  store: ReturnType<typeof createStore>,
  runId: string,
  expectedKind?: "input" | "confirm" | "select" | "editor",
  timeoutMs = 5000,
): Promise<{ stageId: string; promptId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((candidate) => candidate.id === runId);
    const stage = run?.stages.find((candidate) => {
      const prompt = candidate.pendingPrompt;
      return prompt !== undefined && (expectedKind === undefined || prompt.kind === expectedKind);
    });
    if (stage?.pendingPrompt) return { stageId: stage.id, promptId: stage.pendingPrompt.id };
    await delay(5);
  }
  throw new Error(`stage pending prompt did not appear on run ${runId}`);
}

export async function waitForRunEnded(
  store: ReturnType<typeof createStore>,
  runId: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((candidate) => candidate.id === runId);
    if (run?.endedAt !== undefined) return;
    await delay(5);
  }
  throw new Error(`run ${runId} did not end in time`);
}

/** A controllable in-memory `PiOverlayHandle` used by the mock. */
export function buildOverlayHandle(): {
  handle: PiOverlayHandle;
  state: {
    hidden: boolean;
    focused: boolean;
    setHiddenCalls: boolean[];
    focusCalls: number;
    unfocusCalls: number;
    hideCalls: number;
  };
} {
  const state = {
    hidden: false,
    focused: true,
    setHiddenCalls: [] as boolean[],
    focusCalls: 0,
    unfocusCalls: 0,
    hideCalls: 0,
  };
  const handle: PiOverlayHandle = {
    hide: () => {
      state.hideCalls++;
    },
    setHidden: (h) => {
      state.setHiddenCalls.push(h);
      state.hidden = h;
    },
    isHidden: () => state.hidden,
    focus: () => {
      state.focusCalls++;
      state.focused = true;
    },
    unfocus: () => {
      state.unfocusCalls++;
      state.focused = false;
    },
    isFocused: () => state.focused,
  };
  return { handle, state };
}

export interface MockUiOpts {
  /** Optional terminal-row hint surfaced to the factory's `tui.terminal.rows`. */
  rows?: number;
  /** Optional terminal-col hint surfaced to the factory's `tui.terminal.columns`. */
  columns?: number;
  /** Optional observer for custom overlay render requests. */
  onRequestRender?: () => void;
}

/**
 * Build a pi.ui mock whose `custom` matches the real factory/options
 * signature. Invokes the factory immediately (mirroring Pi's runtime),
 * surfaces an `OverlayHandle` via `options.onHandle`, and captures every
 * call for assertion.
 */
export function buildMockUi(mockOpts: MockUiOpts = {}): {
  ui: NonNullable<OverlayPiSurface["ui"]>;
  calls: CapturedCustomCall[];
} {
  const calls: CapturedCustomCall[] = [];
  const ui: NonNullable<OverlayPiSurface["ui"]> = {
    custom: (factoryArg, options) => {
      const { handle } = buildOverlayHandle();
      options.onHandle?.(handle);
      const tui: PiCustomOverlayFactoryTui = {
        requestRender: () => mockOpts.onRequestRender?.(),
        terminal:
          mockOpts.rows != null || mockOpts.columns != null
            ? { rows: mockOpts.rows, columns: mockOpts.columns }
            : undefined,
      };
      const component = factoryArg(tui, {}, {}, () => undefined);
      if (component instanceof Promise) {
        throw new Error("test factory should be sync");
      }
      calls.push({ factory: factoryArg, options, component, handle });
      return undefined;
    },
  };
  return { ui, calls };
}

export function buildInteractiveHostCustomUi(): {
  ui: NonNullable<OverlayPiSurface["ui"]>;
  customMounts: PiCustomOverlayFactory[];
  overlayHandles: Array<ReturnType<typeof buildOverlayHandle>>;
  overlayShows: () => number;
  focusTargets: unknown[];
  customPromises: Promise<unknown>[];
} {
  initTheme("dark");
  const customMounts: PiCustomOverlayFactory[] = [];
  const customPromises: Promise<unknown>[] = [];
  const overlayHandles: Array<ReturnType<typeof buildOverlayHandle>> = [];
  const focusTargets: unknown[] = [];
  let overlayShowCount = 0;
  const host: any = {
    editor: {
      getText: () => "",
      setText: () => undefined,
    },
    editorContainer: {
      clear: () => undefined,
      addChild: () => undefined,
    },
    keybindings: {},
    ui: {
      setFocus: (target: unknown) => {
        focusTargets.push(target);
      },
      requestRender: () => undefined,
      showOverlay: () => {
        overlayShowCount++;
        const overlayHandle = buildOverlayHandle();
        overlayHandles.push(overlayHandle);
        return overlayHandle.handle;
      },
      hideOverlay: () => undefined,
    },
    blockingInlineCustomUiDepth: 0,
    deferredInlineCustomUiFocusDepth: 0,
    pendingInlineCustomUiFocus: undefined,
    hostCustomUiStateListeners: new Set(),
  };
  Object.setPrototypeOf(host, (InteractiveMode as any).prototype);

  const ui = host.ui as NonNullable<OverlayPiSurface["ui"]>;
  ui.custom = (factoryArg, options) => {
    customMounts.push(factoryArg);
    const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
      host,
      factoryArg,
      options,
    ) as Promise<unknown>;
    customPromises.push(promise);
    return promise;
  };
  ui.getHostCustomUiState = () => host.getHostCustomUiState();
  ui.onHostCustomUiStateChange = (listener) => host.onHostCustomUiStateChange(listener);

  return {
    ui,
    customMounts,
    overlayHandles,
    overlayShows: () => overlayShowCount,
    focusTargets,
    customPromises,
  };
}

export function attachHostCustomUiState(ui: NonNullable<OverlayPiSurface["ui"]>): {
  setActive: (active: boolean) => void;
  listenerCount: () => number;
} {
  let depth = 0;
  const listeners = new Set<PiHostCustomUiStateListener>();
  const snapshot = () => ({
    blockingInlineCustomUiDepth: depth,
    blockingInlineCustomUiActive: depth > 0,
  });
  ui.getHostCustomUiState = snapshot;
  ui.onHostCustomUiStateChange = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    setActive: (active) => {
      depth = active ? 1 : 0;
      const state = snapshot();
      for (const listener of listeners) listener(state);
    },
    listenerCount: () => listeners.size,
  };
}

/** Create a minimal mock pi ExtensionAPI with the real custom overlay surface. */
export function buildMockPi(overrides: Partial<ExtensionAPI> = {}): {
  pi: ExtensionAPI;
  shortcuts: Record<string, (ctx?: PiCommandContext) => void>;
  commands: Record<string, { name: string; options: PiCommandOptions }>;
  customCalls: CapturedCustomCall[];
} {
  const shortcuts: Record<string, (ctx?: PiCommandContext) => void> = {};
  const commands: Record<string, { name: string; options: PiCommandOptions }> = {};
  const { ui, calls } = buildMockUi();

  const pi: ExtensionAPI = {
    // The overlay tests assert registration/entrypoint behavior against the
    // bundled startup registry. Disable project/global async discovery so each
    // mock factory instance does not leave unrelated background work running.
    disableAsyncDiscovery: true,
    registerTool: () => undefined,
    registerCommand: (name: string, options: PiCommandOptions) => {
      commands[name] = { name, options };
    },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: (key, opts) => {
      shortcuts[key] = opts.handler;
    },
    ui,
    ...overrides,
  };

  return { pi, shortcuts, commands, customCalls: calls };
}

/** Build a slash-command ctx whose `ui.notify` captures the printed messages. */
export function buildPrintCtx(): { ctx: PiCommandContext; messages: string[] } {
  const messages: string[] = [];
  return {
    ctx: {
      ui: {
        notify: (m: string) => {
          messages.push(m);
        },
      },
    },
    messages,
  };
}

export function buildPrintCtxWithRealCustom(rows?: number): {
  ctx: PiCommandContext;
  messages: string[];
  customCalls: CapturedCustomCall[];
} {
  const messages: string[] = [];
  const { ui, calls } = buildMockUi({ rows });
  const ctx: PiCommandContext = {
    ui: {
      notify: (m: string) => {
        messages.push(m);
      },
      custom: ui.custom,
    },
  };
  return { ctx, messages, customCalls: calls };
}

export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleText(lines: string[]): string {
  return lines.join("\n").replace(ANSI_RE, "");
}

export function setupSequentialRun(store: ReturnType<typeof createStore>, runId: string, count: number): void {
  store.recordRunStart({
    id: runId,
    name: "wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  for (let i = 0; i < count; i++) {
    store.recordStageStart(runId, {
      id: `stage-${i}`,
      name: `stage-${i}`,
      status: "pending",
      parentIds: i === 0 ? [] : [`stage-${i - 1}`],
      toolEvents: [],
    });
  }
}

export function setupBranchingRun(store: ReturnType<typeof createStore>, runId: string): void {
  const stages = [
    { id: "root", parentIds: [] },
    { id: "branch-left", parentIds: ["root"] },
    { id: "branch-right", parentIds: ["root"] },
    { id: "merge", parentIds: ["branch-left", "branch-right"] },
    { id: "tail-a", parentIds: ["merge"] },
    { id: "tail-b", parentIds: ["tail-a"] },
  ];
  setupRunFromStages(store, runId, stages);
}

export function setupWideFanoutRun(store: ReturnType<typeof createStore>, runId: string): void {
  setupRunFromStages(store, runId, [
    { id: "root", parentIds: [] },
    { id: "child-0", parentIds: ["root"] },
    { id: "child-1", parentIds: ["root"] },
    { id: "child-2", parentIds: ["root"] },
    { id: "child-3", parentIds: ["root"] },
    { id: "child-4", parentIds: ["root"] },
    { id: "child-5", parentIds: ["root"] },
  ]);
}

export function setupRunFromStages(
  store: ReturnType<typeof createStore>,
  runId: string,
  stages: Array<{ id: string; parentIds: string[] }>,
): void {
  store.recordRunStart({
    id: runId,
    name: "wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  for (const stage of stages) {
    store.recordStageStart(runId, {
      id: stage.id,
      name: stage.id,
      status: "pending",
      parentIds: stage.parentIds,
      toolEvents: [],
    });
  }
}

// ---------------------------------------------------------------------------
// buildGraphOverlayAdapter — degraded runtime (no custom)
// ---------------------------------------------------------------------------
