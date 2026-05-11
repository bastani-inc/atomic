/** @jsxImportSource @opentui/react */
/**
 * Tests for SessionGraphPanel RFC §5.5 resume gate logic.
 *
 * Test strategy:
 *   - `decideAttachAction` pure helper: exhaustive unit tests (no mocks needed).
 *   - Async `doAttach` branching: thin harness that reproduces the exact
 *     conditional logic without mounting the full OpenTUI component tree.
 *   - Focus-poll: same thin-harness approach for the interval callback logic.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { decideAttachAction } from "./session-graph-panel.tsx";
import { PanelStore } from "./orchestrator-panel-store.ts";
import { errorMessage } from "../errors.ts";
import type { OffloadManager } from "../runtime/offload-manager.ts";

// ─── decideAttachAction ───────────────────────────────────────────────────────

describe("decideAttachAction", () => {
  test("status=alive → switchClient", () => {
    expect(decideAttachAction("alive")).toEqual({ kind: "switchClient" });
  });

  test("status=offloaded → resume", () => {
    expect(decideAttachAction("offloaded")).toEqual({ kind: "resume" });
  });

  test("status=resuming → resume (coalesces onto in-flight op)", () => {
    expect(decideAttachAction("resuming")).toEqual({ kind: "resume" });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOffloadManager(overrides: Partial<OffloadManager> = {}): OffloadManager {
  return {
    registerSession: mock(async () => {}),
    offloadSession: mock(async () => {}),
    onWorkflowCompletion: mock(async () => {}),
    requestResume: mock(async () => {}),
    getStatus: mock(() => "alive" as const),
    ...overrides,
  };
}

/**
 * Thin reproducer of the doAttach async logic from session-graph-panel.tsx.
 *
 * Mirrors the exact conditional structure without any React/OpenTUI overhead.
 * Keeps tests fast and deterministic.
 */
async function runDoAttach(opts: {
  id: string;
  nodeExists: boolean;
  offloadManager: OffloadManager;
  store: PanelStore;
  tmuxRun: (args: string[]) => void;
  tmuxSession: string;
  setFocusedId: (id: string) => void;
}): Promise<void> {
  const { id, nodeExists, offloadManager, store, tmuxRun: mockTmuxRun, tmuxSession, setFocusedId } = opts;

  // Mirrors layout.map[id] lookup
  if (!nodeExists) return;

  // Mirrors session guard
  const session = store.sessions.find((s) => s.name === id);
  if (!session || session.status === "pending") return;

  setFocusedId(id);

  const status = offloadManager.getStatus(id);
  if (status === "offloaded" || status === "resuming") {
    store.setViewMode("resuming", id);
    try {
      await offloadManager.requestResume(id);
      store.setViewMode("attached", id);
    } catch (err) {
      store.showToast(`Failed to resume ${id}: ${errorMessage(err)}`);
      store.setViewMode("graph");
    }
    return;
  }

  store.setViewMode("attached", id);
  mockTmuxRun(["switch-client", "-t", `${tmuxSession}:${id}`]); // offload-exempt: status === "alive"
}

// ─── doAttach async branching ─────────────────────────────────────────────────

describe("doAttach — offloaded path", () => {
  let store: PanelStore;
  let tmuxRunMock: ReturnType<typeof mock>;

  beforeEach(() => {
    store = new PanelStore();
    store.setWorkflowInfo("wf", "claude", [{ name: "agent-1", parents: [] }], "prompt");
    store.startSession("agent-1");
    store.setSessionStatus("agent-1", "offloaded");
    tmuxRunMock = mock(() => {});
  });

  test("(a) requestResume called BEFORE any switch-client when node is offloaded", async () => {
    const callOrder: string[] = [];
    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
      requestResume: mock(async () => {
        callOrder.push("requestResume");
      }),
    });
    const tmuxRunCapture = mock((..._args: unknown[]) => {
      callOrder.push("switch-client");
    });

    await runDoAttach({
      id: "agent-1",
      nodeExists: true,
      offloadManager: mgr,
      store,
      tmuxRun: tmuxRunCapture,
      tmuxSession: "test-session",
      setFocusedId: () => {},
    });

    expect(callOrder).toContain("requestResume");
    // switch-client must NOT appear at all — OffloadManager does selectWindow on success
    expect(callOrder).not.toContain("switch-client");
    // requestResume must come first if both appeared
    if (callOrder.includes("switch-client")) {
      expect(callOrder.indexOf("requestResume")).toBeLessThan(callOrder.indexOf("switch-client"));
    }
  });

  test("viewMode transitions to 'resuming' during resume, then 'attached' on success", async () => {
    const viewModes: string[] = [];
    const origSetViewMode = store.setViewMode.bind(store);
    store.setViewMode = mock((mode, id?) => {
      viewModes.push(mode);
      origSetViewMode(mode, id);
    });

    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
      requestResume: mock(async () => {}),
    });

    await runDoAttach({
      id: "agent-1",
      nodeExists: true,
      offloadManager: mgr,
      store,
      tmuxRun: () => {},
      tmuxSession: "test-session",
      setFocusedId: () => {},
    });

    expect(viewModes).toContain("resuming");
    expect(viewModes[viewModes.length - 1]).toBe("attached");
  });

  test("(b) requestResume rejection sets toast and leaves viewMode === 'graph'", async () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
      requestResume: mock(async () => {
        throw new Error("tmux window gone");
      }),
    });

    await runDoAttach({
      id: "agent-1",
      nodeExists: true,
      offloadManager: mgr,
      store,
      tmuxRun: () => {},
      tmuxSession: "test-session",
      setFocusedId: () => {},
    });

    expect(store.viewMode).toBe("graph");
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0]!.message).toMatch(/^Failed to resume agent-1:/);
    expect(store.toasts[0]!.message).toContain("tmux window gone");
  });

  test("(b) no switch-client on resume failure", async () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
      requestResume: mock(async () => {
        throw new Error("fail");
      }),
    });

    await runDoAttach({
      id: "agent-1",
      nodeExists: true,
      offloadManager: mgr,
      store,
      tmuxRun: tmuxRunMock,
      tmuxSession: "test-session",
      setFocusedId: () => {},
    });

    expect(tmuxRunMock).not.toHaveBeenCalled();
  });
});

describe("doAttach — alive path", () => {
  let store: PanelStore;
  let tmuxRunMock: ReturnType<typeof mock>;

  beforeEach(() => {
    store = new PanelStore();
    store.setWorkflowInfo("wf", "claude", [{ name: "agent-1", parents: [] }], "prompt");
    store.startSession("agent-1");
    tmuxRunMock = mock(() => {});
  });

  test("(d) status=alive: switch-client issued, no requestResume", async () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "alive" as const),
    });

    await runDoAttach({
      id: "agent-1",
      nodeExists: true,
      offloadManager: mgr,
      store,
      tmuxRun: tmuxRunMock,
      tmuxSession: "test-session",
      setFocusedId: () => {},
    });

    expect(tmuxRunMock).toHaveBeenCalledWith(["switch-client", "-t", "test-session:agent-1"]);
    expect(mgr.requestResume).not.toHaveBeenCalled();
  });

  test("(d) viewMode set to 'attached' on alive path", async () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "alive" as const),
    });

    await runDoAttach({
      id: "agent-1",
      nodeExists: true,
      offloadManager: mgr,
      store,
      tmuxRun: tmuxRunMock,
      tmuxSession: "test-session",
      setFocusedId: () => {},
    });

    expect(store.viewMode).toBe("attached");
    expect(store.activeAgentId).toBe("agent-1");
  });
});

// ─── focus-poll resume trigger ────────────────────────────────────────────────

/**
 * Thin reproducer of the focus-poll `check` callback logic.
 * Mirrors the exact conditional from the useEffect in session-graph-panel.tsx
 * including the R3 tri-state fix (offloaded / resuming / alive).
 */
function runFocusPollCheck(opts: {
  tmuxOutput: string; // e.g. "1 agent-1"
  offloadManager: OffloadManager;
  store: PanelStore;
}): void {
  const { tmuxOutput, offloadManager, store } = opts;
  const output = tmuxOutput.trim();
  const spaceIdx = output.indexOf(" ");
  const idx = spaceIdx >= 0 ? output.slice(0, spaceIdx) : output;
  const windowName = spaceIdx >= 0 ? output.slice(spaceIdx + 1) : "";

  if (idx === "0") {
    if (store.viewMode !== "graph") {
      store.setViewMode("graph");
    }
  } else {
    // Mirror of session-graph-panel.tsx focus poll: "offloaded" and "resuming"
    // both render as "resuming"; only "alive" flips to "attached" (R3 fix).
    const targetStatus = offloadManager.getStatus(windowName);
    const desiredMode = targetStatus === "alive" ? "attached" : "resuming";
    if (store.viewMode !== desiredMode || store.activeAgentId !== windowName) {
      store.setViewMode(desiredMode, windowName);
    }
    if (targetStatus === "offloaded") {
      void offloadManager.requestResume(windowName).catch(() => {});
    }
  }
}

describe("focus-poll", () => {
  let store: PanelStore;

  beforeEach(() => {
    store = new PanelStore();
    store.setWorkflowInfo("wf", "claude", [{ name: "agent-1", parents: [] }], "prompt");
    store.startSession("agent-1");
  });

  test("(c) poll detects offloaded window → invokes requestResume", () => {
    const mgr = makeOffloadManager({
      getStatus: mock((name: string) => (name === "agent-1" ? "offloaded" : "alive") as "offloaded" | "alive"),
      requestResume: mock(async () => {}),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(mgr.requestResume).toHaveBeenCalledWith("agent-1");
    expect(store.viewMode).toBe("resuming");
    expect(store.activeAgentId).toBe("agent-1");
  });

  test("(c) poll on offloaded window sets viewMode to 'resuming'", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(store.viewMode).toBe("resuming");
    expect(store.activeAgentId).toBe("agent-1");
  });

  test("poll on alive window sets viewMode to 'attached'", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "alive" as const),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(store.viewMode).toBe("attached");
    expect(store.activeAgentId).toBe("agent-1");
    expect(mgr.requestResume).not.toHaveBeenCalled();
  });

  test("poll on window index 0 sets viewMode to 'graph'", () => {
    store.setViewMode("attached", "agent-1");
    const mgr = makeOffloadManager();

    runFocusPollCheck({ tmuxOutput: "0 orchestrator", offloadManager: mgr, store });

    expect(store.viewMode).toBe("graph");
    expect(mgr.requestResume).not.toHaveBeenCalled();
  });

  test("poll on already-resuming window does not re-call setViewMode", () => {
    store.setViewMode("resuming", "agent-1");
    const setViewModeSpy = mock(store.setViewMode.bind(store));
    store.setViewMode = setViewModeSpy;

    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    // Should NOT call setViewMode again since it's already "resuming" + same agentId
    expect(setViewModeSpy).not.toHaveBeenCalled();
  });
});

// ─── focus-leave offload trigger (chrome-tab semantics) ──────────────────────

/**
 * Thin reproducer of the focus-poll's focus-leave branch from
 * session-graph-panel.tsx. Mirrors the offloadSession call order so we can
 * assert the eligibility-check ordering (setViewMode runs first so the
 * manager sees the updated activeAgentId).
 */
function runFocusLeaveCheck(opts: {
  prevName: string;
  currentName: string;
  offloadManager: OffloadManager;
}): void {
  const { prevName, currentName, offloadManager } = opts;
  if (prevName !== "" && prevName !== currentName && prevName !== "orchestrator") {
    void offloadManager.offloadSession(prevName).catch(() => {});
  }
}

describe("focus-leave — Chrome-tab offload semantics", () => {
  test("user navigates from stage to orchestrator → offloadSession on stage", () => {
    const mgr = makeOffloadManager();
    runFocusLeaveCheck({ prevName: "agent-1", currentName: "orchestrator", offloadManager: mgr });
    expect(mgr.offloadSession).toHaveBeenCalledWith("agent-1");
  });

  test("user navigates between stages → offloadSession on previous stage", () => {
    const mgr = makeOffloadManager();
    runFocusLeaveCheck({ prevName: "agent-1", currentName: "agent-2", offloadManager: mgr });
    expect(mgr.offloadSession).toHaveBeenCalledWith("agent-1");
  });

  test("user stays on the same window → no offloadSession call", () => {
    const mgr = makeOffloadManager();
    runFocusLeaveCheck({ prevName: "agent-1", currentName: "agent-1", offloadManager: mgr });
    expect(mgr.offloadSession).not.toHaveBeenCalled();
  });

  test("first poll tick (prev empty) → no offloadSession call", () => {
    const mgr = makeOffloadManager();
    runFocusLeaveCheck({ prevName: "", currentName: "agent-1", offloadManager: mgr });
    expect(mgr.offloadSession).not.toHaveBeenCalled();
  });

  test("user navigates from orchestrator to stage → no offloadSession (orchestrator excluded)", () => {
    const mgr = makeOffloadManager();
    runFocusLeaveCheck({ prevName: "orchestrator", currentName: "agent-1", offloadManager: mgr });
    expect(mgr.offloadSession).not.toHaveBeenCalled();
  });
});

// ─── focus-poll R3 resuming branch ───────────────────────────────────────────

describe("focus-poll R3 — resuming branch", () => {
  let store: PanelStore;

  beforeEach(() => {
    store = new PanelStore();
    store.setWorkflowInfo("wf", "claude", [{ name: "agent-1", parents: [] }], "prompt");
    store.startSession("agent-1");
  });

  // Assertion 1a: viewMode reflects "resuming" when getStatus returns "resuming"
  test("status=resuming → viewMode is 'resuming'", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "resuming" as const),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(store.viewMode).toBe("resuming");
  });

  // Assertion 1b: activeAgentId is set to windowName
  test("status=resuming → activeAgentId equals windowName", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "resuming" as const),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(store.activeAgentId).toBe("agent-1");
  });

  // Assertion 1c (RFC invariant I3): viewMode NEVER flips to "attached" while status is "resuming"
  test("status=resuming — viewMode never becomes 'attached' across multiple poll ticks", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "resuming" as const),
    });

    // Simulate 5 consecutive poll ticks
    for (let tick = 0; tick < 5; tick++) {
      runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });
      expect(store.viewMode).not.toBe("attached");
    }

    expect(store.viewMode).toBe("resuming");
    expect(store.activeAgentId).toBe("agent-1");
  });

  // Assertion 2: requestResume is NEVER called when status is "resuming"
  test("status=resuming → requestResume NOT called (resume already in flight)", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "resuming" as const),
      requestResume: mock(async () => {}),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(mgr.requestResume).not.toHaveBeenCalled();
  });

  // Assertion 2 extended: zero calls across multiple ticks
  test("status=resuming — requestResume called zero times across multiple poll ticks", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "resuming" as const),
      requestResume: mock(async () => {}),
    });

    for (let tick = 0; tick < 5; tick++) {
      runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });
    }

    expect(mgr.requestResume).not.toHaveBeenCalled();
  });

  // Assertion 2 also: status=resuming does NOT call setViewMode when already correct
  test("status=resuming — no redundant setViewMode when state already matches", () => {
    store.setViewMode("resuming", "agent-1");
    const setViewModeSpy = mock(store.setViewMode.bind(store));
    store.setViewMode = setViewModeSpy;

    const mgr = makeOffloadManager({
      getStatus: mock(() => "resuming" as const),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(setViewModeSpy).not.toHaveBeenCalled();
  });

  // Assertion 3 (optional completeness): offloaded branch still triggers requestResume
  test("status=offloaded → requestResume called exactly once per tick", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
      requestResume: mock(async () => {}),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(mgr.requestResume).toHaveBeenCalledTimes(1);
    expect(mgr.requestResume).toHaveBeenCalledWith("agent-1");
  });

  test("status=offloaded — requestResume called once per tick across multiple ticks", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "offloaded" as const),
      requestResume: mock(async () => {}),
    });

    for (let tick = 0; tick < 3; tick++) {
      runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });
    }

    // 3 ticks × 1 call each = 3 total
    expect(mgr.requestResume).toHaveBeenCalledTimes(3);
  });

  // Assertion 4 (optional): alive branch flips to "attached"
  test("status=alive → viewMode becomes 'attached'", () => {
    const mgr = makeOffloadManager({
      getStatus: mock(() => "alive" as const),
    });

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });

    expect(store.viewMode).toBe("attached");
    expect(store.activeAgentId).toBe("agent-1");
    expect(mgr.requestResume).not.toHaveBeenCalled();
  });

  // Boundary: resuming → alive transition across ticks (status changes mid-sequence)
  test("status transitions resuming→alive: viewMode follows correctly", () => {
    let callCount = 0;
    const mgr = makeOffloadManager({
      getStatus: mock(() => {
        callCount++;
        // First 2 ticks: resuming; 3rd tick: alive (resume completed)
        return callCount <= 2 ? ("resuming" as const) : ("alive" as const);
      }),
      requestResume: mock(async () => {}),
    });

    // Ticks 1 & 2: resuming
    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });
    expect(store.viewMode).toBe("resuming");
    expect(mgr.requestResume).not.toHaveBeenCalled();

    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });
    expect(store.viewMode).toBe("resuming");
    expect(mgr.requestResume).not.toHaveBeenCalled();

    // Tick 3: alive — now safe to attach
    runFocusPollCheck({ tmuxOutput: "1 agent-1", offloadManager: mgr, store });
    expect(store.viewMode).toBe("attached");
    expect(store.activeAgentId).toBe("agent-1");
    // Still zero requestResume calls throughout
    expect(mgr.requestResume).not.toHaveBeenCalled();
  });
});
