/**
 * Tests for `src/primitives/sessions.ts`.
 *
 * Each function accepts an optional `deps` parameter, so these tests
 * inject in-memory fakes (SessionPrimitiveDeps) instead of connecting
 * to a real daemon. All tmux-related dependencies have been removed.
 */

import { test, expect, describe, mock, afterAll } from "bun:test";
import {
  listSessions,
  getSession,
  stopSession,
  attachSession,
  detachSession,
  nextWindow,
  previousWindow,
  gotoOrchestrator,
  getSessionStatus,
  getSessionTranscript,
  type SessionPrimitiveDeps,
} from "./sessions.ts";
import type { RunInfo } from "../runtime/ui-protocol/schemas.ts";
import type { WorkflowStatusSnapshot } from "../runtime/status-writer.ts";
import type { SavedMessage } from "../types.ts";

// ─── Real daemon module snapshot ─────────────────────────────────────────────
//
// Captured BEFORE any mock.module calls (at module load time, before tests run).
// Used in afterAll to restore the daemon module after the defaultDeps describe
// block mocks it, preventing live-binding leakage to other test files.
//
// In Bun, mock.module() mutates the module registry entry's exports in-place,
// which updates all ESM live bindings pointing to those exports — including
// bindings in OTHER test files loaded in the same worker. By capturing the
// real function objects here (before any mock), we can restore them after.
const _realDaemon = await import("../runtime/daemon.ts");
const _realConnectToDaemon = _realDaemon.connectToDaemon;
const _realEnsureStarted = _realDaemon.ensureStarted;
const _realDaemonClass = _realDaemon.Daemon;
const _realReadEndpointFile = _realDaemon.readEndpointFile;
const _realProbeLiveness = _realDaemon.probeLiveness;
const _realMissingDependencyError = _realDaemon.MissingDependencyError;
const _realDaemonAlreadyRunningError = _realDaemon.DaemonAlreadyRunningError;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = "2026-04-27T00:00:00.000Z";

function makeRun(partial: Partial<RunInfo> & { runId: string }): RunInfo {
  return {
    workflowName: "test-wf",
    agent: "claude",
    status: "active",
    startedAt: NOW,
    ...partial,
  };
}

function makeDeps(overrides: Partial<SessionPrimitiveDeps> = {}): SessionPrimitiveDeps {
  return {
    listRuns: async () => [],
    getRun: async () => null,
    stopRun: async () => {},
    getRunStatus: async () => null,
    getRunTranscript: async () => [],
    getAttachInfo: async () => ({ subscriptionId: "sub-1", foregroundStage: null }),
    setForeground: async () => {},
    ...overrides,
  };
}

// ─── listSessions ────────────────────────────────────────────────────────────

describe("listSessions", () => {
  test("returns [] when no runs exist", async () => {
    const result = await listSessions({}, makeDeps());
    expect(result).toEqual([]);
  });

  test("maps RunInfo to SessionInfo correctly", async () => {
    const run = makeRun({ runId: "run-abc123", agent: "claude", workflowName: "my-wf", status: "active" });
    const result = await listSessions({}, makeDeps({ listRuns: async () => [run] }));
    expect(result).toHaveLength(1);
    const s = result[0]!;
    expect(s.id).toBe("run-abc123");
    expect(s.type).toBe("workflow");
    expect(s.agent).toBe("claude");
    expect(s.created).toBe(NOW);
    expect(s.attached).toBe(false);
    expect(s.status).toBe("active");
    expect(s.workflowName).toBe("my-wf");
  });

  test("scope 'workflow' keeps all workflow-type sessions", async () => {
    const runs = [
      makeRun({ runId: "r1" }),
      makeRun({ runId: "r2" }),
    ];
    const result = await listSessions({ scope: "workflow" }, makeDeps({ listRuns: async () => runs }));
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.type === "workflow")).toBe(true);
  });

  test("scope 'chat' filters out workflow sessions (all filtered)", async () => {
    const runs = [makeRun({ runId: "r1" })];
    const result = await listSessions({ scope: "chat" }, makeDeps({ listRuns: async () => runs }));
    // All daemon runs are type "workflow" so chat scope returns []
    expect(result).toEqual([]);
  });

  test("filters by agent", async () => {
    const runs = [
      makeRun({ runId: "r1", agent: "claude" }),
      makeRun({ runId: "r2", agent: "copilot" }),
    ];
    const result = await listSessions(
      { agent: "claude" },
      makeDeps({ listRuns: async () => runs }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.agent).toBe("claude");
  });

  test("filters by multiple agents", async () => {
    const runs = [
      makeRun({ runId: "r1", agent: "claude" }),
      makeRun({ runId: "r2", agent: "copilot" }),
      makeRun({ runId: "r3", agent: "opencode" }),
    ];
    const result = await listSessions(
      { agent: ["claude", "copilot"] },
      makeDeps({ listRuns: async () => runs }),
    );
    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
  });

  test("scope 'all' returns all runs", async () => {
    const runs = [makeRun({ runId: "r1" }), makeRun({ runId: "r2" })];
    const result = await listSessions({ scope: "all" }, makeDeps({ listRuns: async () => runs }));
    expect(result).toHaveLength(2);
  });
});

// ─── getSession ──────────────────────────────────────────────────────────────

describe("getSession", () => {
  test("returns undefined when run not found", async () => {
    const result = await getSession("nonexistent", makeDeps());
    expect(result).toBeUndefined();
  });

  test("returns SessionInfo for found run", async () => {
    const run = makeRun({ runId: "run-xyz", agent: "copilot" });
    const result = await getSession("run-xyz", makeDeps({ getRun: async () => run }));
    expect(result).toBeDefined();
    expect(result!.id).toBe("run-xyz");
    expect(result!.agent).toBe("copilot");
    expect(result!.type).toBe("workflow");
    expect(result!.attached).toBe(false);
  });
});

// ─── stopSession ─────────────────────────────────────────────────────────────

describe("stopSession", () => {
  test("calls deps.stopRun with the correct id", async () => {
    const stopRun = mock(async (_id: string) => {});
    await stopSession("run-to-stop", makeDeps({ stopRun }));
    expect(stopRun).toHaveBeenCalledWith("run-to-stop");
  });

  test("swallows errors (best-effort)", async () => {
    const stopRun = mock(async () => { throw new Error("run not found"); });
    // Should not throw
    await expect(stopSession("missing-run", makeDeps({ stopRun }))).resolves.toBeUndefined();
  });
});

// ─── attachSession ────────────────────────────────────────────────────────────

describe("attachSession", () => {
  test("returns subscriptionId and foregroundStage from deps.getAttachInfo", async () => {
    const getAttachInfo = mock(async (_id: string) => ({
      subscriptionId: "sub-42",
      foregroundStage: "stage-a",
    }));
    const result = await attachSession("run-id", makeDeps({ getAttachInfo }));
    expect(result.subscriptionId).toBe("sub-42");
    expect(result.foregroundStage).toBe("stage-a");
    expect(getAttachInfo).toHaveBeenCalledWith("run-id");
  });

  test("foregroundStage can be null", async () => {
    const result = await attachSession("run-id", makeDeps({
      getAttachInfo: async () => ({ subscriptionId: "sub-1", foregroundStage: null }),
    }));
    expect(result.foregroundStage).toBeNull();
  });
});

// ─── detachSession ────────────────────────────────────────────────────────────

describe("detachSession", () => {
  test("resolves without error (no-op)", async () => {
    await expect(detachSession("any-id", makeDeps())).resolves.toBeUndefined();
  });
});

// ─── nextWindow ───────────────────────────────────────────────────────────────

describe("nextWindow", () => {
  test("calls deps.setForeground with the run id", async () => {
    const setForeground = mock(async (_id: string, _stage?: string) => {});
    await nextWindow("run-id", makeDeps({ setForeground }));
    expect(setForeground).toHaveBeenCalledWith("run-id", undefined);
  });
});

// ─── previousWindow ───────────────────────────────────────────────────────────

describe("previousWindow", () => {
  test("calls deps.setForeground with the run id", async () => {
    const setForeground = mock(async (_id: string, _stage?: string) => {});
    await previousWindow("run-id", makeDeps({ setForeground }));
    expect(setForeground).toHaveBeenCalledWith("run-id", undefined);
  });
});

// ─── gotoOrchestrator ─────────────────────────────────────────────────────────

describe("gotoOrchestrator", () => {
  test("calls deps.setForeground with the run id", async () => {
    const setForeground = mock(async (_id: string, _stage?: string) => {});
    await gotoOrchestrator("run-id", makeDeps({ setForeground }));
    expect(setForeground).toHaveBeenCalledWith("run-id", undefined);
  });
});

// ─── getSessionStatus ─────────────────────────────────────────────────────────

describe("getSessionStatus", () => {
  test("returns null when no status available", async () => {
    const result = await getSessionStatus("run-id", makeDeps());
    expect(result).toBeNull();
  });

  test("returns snapshot from deps.getRunStatus", async () => {
    const snapshot: WorkflowStatusSnapshot = {
      schemaVersion: 1,
      workflowRunId: "run-id",
      tmuxSession: "atomic-wf-claude-test-runid12",
      workflowName: "test-wf",
      agent: "claude",
      prompt: "",
      overall: "in_progress" as const,
      completionReached: false,
      fatalError: null,
      updatedAt: NOW,
      sessions: [],
    };
    const result = await getSessionStatus(
      "run-id",
      makeDeps({ getRunStatus: async () => snapshot }),
    );
    expect(result).toEqual(snapshot);
  });

  test("passes the correct run id", async () => {
    const getRunStatus = mock(async (_id: string) => null);
    await getSessionStatus("my-run-123", makeDeps({ getRunStatus }));
    expect(getRunStatus).toHaveBeenCalledWith("my-run-123");
  });
});

// ─── getSessionTranscript ─────────────────────────────────────────────────────

describe("getSessionTranscript", () => {
  test("returns empty array when no transcript", async () => {
    const result = await getSessionTranscript("run-id", "stage-1", makeDeps());
    expect(result).toEqual([]);
  });

  test("returns messages from deps.getRunTranscript", async () => {
    const messages = [
      { provider: "claude", data: { type: "assistant" } },
    ] as unknown as SavedMessage[];
    const result = await getSessionTranscript(
      "run-id",
      "stage-1",
      makeDeps({ getRunTranscript: async () => messages }),
    );
    // Verify the result is the same array reference from the mock
    expect(result).toHaveLength(1);
    expect(result).toBe(messages);
  });

  test("passes the correct runId and sessionName", async () => {
    const getRunTranscript = mock(async (_runId: string, _sessionName: string) => []);
    await getSessionTranscript("run-abc", "my-stage", makeDeps({ getRunTranscript }));
    expect(getRunTranscript).toHaveBeenCalledWith("run-abc", "my-stage");
  });
});

// ─── defaultDeps coverage — via mock.module ───────────────────────────────────
//
// The `defaultDeps` object contains 7 async functions that each call
// `connectToDaemon()` and forward the RPC result. To cover these without
// a real daemon, we intercept the `connectToDaemon` module export via
// `mock.module` and exercise each function by calling the public API
// without injecting custom deps (so the defaults are used).
//
// Note: mock.module must be called before the module under test is imported,
// so we use a fresh dynamic import after setting up the mock.

describe("defaultDeps — connectToDaemon wiring", () => {
  // Build a reusable fake connection factory.
  function makeFakeConn(sendRequest: (method: string, params: unknown) => Promise<unknown>) {
    return {
      sendRequest: mock(async (method: string, params: unknown) => sendRequest(method, params)),
      dispose: mock(() => {}),
    };
  }

  test("listRuns (defaultDeps) calls run/list and disposes connection", async () => {
    const fakeRunList = [
      { runId: "r1", workflowName: "wf", agent: "claude", status: "active", startedAt: "2026-01-01T00:00:00Z" },
    ];
    const fakeConn = makeFakeConn(async (_method) => fakeRunList);

    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: mock(async () => fakeConn),
    }));

    const { listSessions: ls } = await import("./sessions.ts");
    const result = await ls({});

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("r1");
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("getRun (defaultDeps) calls run/get and disposes connection", async () => {
    const fakeRun = {
      runId: "run-42",
      workflowName: "my-wf",
      agent: "claude",
      status: "active",
      startedAt: "2026-01-01T00:00:00Z",
    };
    const fakeConn = makeFakeConn(async () => fakeRun);

    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: mock(async () => fakeConn),
    }));

    const { getSession: gs } = await import("./sessions.ts");
    const result = await gs("run-42");

    expect(result).toBeDefined();
    expect(result!.id).toBe("run-42");
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("stopRun (defaultDeps) calls run/stop and disposes connection", async () => {
    const fakeConn = makeFakeConn(async () => undefined);

    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: mock(async () => fakeConn),
    }));

    const { stopSession: ss } = await import("./sessions.ts");
    await ss("run-99");

    expect(fakeConn.sendRequest).toHaveBeenCalledWith("run/stop", { runId: "run-99" });
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("getRunStatus (defaultDeps) calls run/status and disposes connection", async () => {
    const fakeStatus = { schemaVersion: 1, workflowRunId: "r1", overall: "in_progress" } as unknown as import("./sessions.ts").StatusSnapshot;
    const fakeConn = makeFakeConn(async () => fakeStatus);

    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: mock(async () => fakeConn),
    }));

    const { getSessionStatus: gss } = await import("./sessions.ts");
    const result = await gss("r1");

    expect(result).toEqual(fakeStatus);
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("getRunTranscript (defaultDeps) calls run/transcript and disposes connection", async () => {
    const fakeMessages = [{ provider: "claude" as const, data: { type: "assistant" } }] as unknown as SavedMessage[];
    const fakeConn = makeFakeConn(async () => fakeMessages);

    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: mock(async () => fakeConn),
    }));

    const { getSessionTranscript: gst } = await import("./sessions.ts");
    const result = await gst("r1", "stage-1");

    expect(result).toEqual(fakeMessages);
    expect(fakeConn.sendRequest).toHaveBeenCalledWith("run/transcript", {
      runId: "r1",
      sessionName: "stage-1",
    });
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("getAttachInfo (defaultDeps) calls run/getAttachInfo and disposes connection", async () => {
    const fakeAttach = { subscriptionId: "sub-1", foregroundStage: "stage-a" };
    const fakeConn = makeFakeConn(async () => fakeAttach);

    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: mock(async () => fakeConn),
    }));

    const { attachSession: as } = await import("./sessions.ts");
    const result = await as("r1");

    expect(result.subscriptionId).toBe("sub-1");
    expect(result.foregroundStage).toBe("stage-a");
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("setForeground (defaultDeps) calls run/setForeground and disposes connection", async () => {
    const fakeConn = makeFakeConn(async () => undefined);

    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: mock(async () => fakeConn),
    }));

    const { nextWindow: nw } = await import("./sessions.ts");
    await nw("r1");

    expect(fakeConn.sendRequest).toHaveBeenCalledWith("run/setForeground", {
      runId: "r1",
      stageName: undefined,
    });
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  afterAll(async () => {
    // Restore the real daemon module exports to prevent mock.module leakage to
    // other test files sharing the same Bun worker. Without this, daemon.test.ts
    // (and any other file that imports daemon.ts) would receive a mock
    // connectToDaemon instead of the real one.
    await mock.module("../runtime/daemon.ts", () => ({
      connectToDaemon: _realConnectToDaemon,
      ensureStarted: _realEnsureStarted,
      Daemon: _realDaemonClass,
      readEndpointFile: _realReadEndpointFile,
      probeLiveness: _realProbeLiveness,
      MissingDependencyError: _realMissingDependencyError,
      DaemonAlreadyRunningError: _realDaemonAlreadyRunningError,
    }));
  });
});

