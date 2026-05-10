/**
 * Tests for `src/primitives/sessions.ts`.
 *
 * Each function accepts an optional `deps` parameter, so these tests
 * inject in-memory fakes (SessionPrimitiveDeps) instead of connecting
 * to a real daemon. All tmux-related dependencies have been removed.
 */

import { test, expect, describe, mock } from "bun:test";
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

