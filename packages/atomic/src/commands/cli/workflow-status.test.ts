/**
 * Tests for `atomic workflow status` — covers the dependency-injected
 * command shape end-to-end with no real tmux server, no real
 * filesystem outside a temp dir, and JSON output capture so assertions
 * can run on parsed objects.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflowStatusCommand, type StatusDeps } from "./workflow-status.ts";
import {
  buildSnapshot,
  writeSnapshot,
  type WorkflowStatusSnapshot,
} from "@bastani/atomic-sdk/runtime/status-writer";
import type { TmuxSession } from "./workflow-status.ts";
import type { SessionData } from "@bastani/atomic-sdk/components/orchestrator-panel-types";

// ─── output capture ────────────────────────────────────────────────

function captureStdout(): { read: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stdout.write;
  return {
    read: () => chunks.join(""),
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

let originalNoColor: string | undefined;
beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

function tmuxSession(name: string): TmuxSession {
  return {
    name,
    windows: 1,
    created: new Date().toISOString(),
    attached: false,
    type: "workflow",
    agent: "claude",
  };
}

function panelSession(
  name: string,
  status: SessionData["status"],
  extra: Partial<SessionData> = {},
): SessionData {
  return {
    name,
    status,
    parents: [],
    startedAt: 1000,
    endedAt: null,
    ...extra,
  };
}

function snapshotOf(
  workflowName: string,
  agent: string,
  sessions: SessionData[],
  opts: { fatalError?: string | null; completionReached?: boolean } = {},
): WorkflowStatusSnapshot {
  return buildSnapshot({
    workflowRunId: "abcd1234",
    tmuxSession: `atomic-wf-${agent}-${workflowName}-abcd1234`,
    workflowName,
    agent,
    prompt: "",
    fatalError: opts.fatalError ?? null,
    completionReached: opts.completionReached ?? false,
    sessions,
  });
}

interface Mocks {
  isTmuxInstalled: ReturnType<typeof mock>;
  sessionExists: ReturnType<typeof mock>;
  listSessions: ReturnType<typeof mock>;
  readSnapshot: ReturnType<typeof mock>;
}

function makeDeps(sessionsBaseDir: string): { deps: StatusDeps; mocks: Mocks } {
  const mocks: Mocks = {
    isTmuxInstalled: mock(() => true),
    sessionExists: mock(() => true),
    listSessions: mock<() => TmuxSession[]>(() => []),
    readSnapshot: mock(async () => null),
  };
  const deps: StatusDeps = {
    isTmuxInstalled: mocks.isTmuxInstalled,
    sessionExists: mocks.sessionExists,
    listSessions: mocks.listSessions as unknown as StatusDeps["listSessions"],
    readSnapshot: mocks.readSnapshot as unknown as StatusDeps["readSnapshot"],
    sessionsBaseDir,
  };
  return { deps, mocks };
}

// ─── tests ─────────────────────────────────────────────────────────

describe("workflowStatusCommand", () => {
  let tmpDir = "";
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atomic-status-cmd-"));
  });

  test("prints empty list when no workflow sessions are running", async () => {
    const { deps } = makeDeps(tmpDir);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "json" }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed).toEqual({ workflows: [] });
    } finally {
      cap.restore();
    }
  });

  test("derives 'in_progress' for an alive workflow with a running stage", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(
      snapshotOf("ralph", "claude", [panelSession("orchestrator", "running")]),
    );
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "json" }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed.workflows).toHaveLength(1);
      expect(parsed.workflows[0].overall).toBe("in_progress");
      expect(parsed.workflows[0].alive).toBe(true);
    } finally {
      cap.restore();
    }
  });

  test("returns 'needs_review' when any stage is awaiting input (HIL)", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(
      snapshotOf("ralph", "claude", [
        panelSession("orchestrator", "running"),
        panelSession("loop", "awaiting_input"),
      ]),
    );
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand(
        { format: "json", id: "atomic-wf-claude-ralph-abcd1234" },
        deps,
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed.overall).toBe("needs_review");
    } finally {
      cap.restore();
    }
  });

  test("returns 'completed' when completionReached and no errors", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(
      snapshotOf(
        "ralph",
        "claude",
        [panelSession("orchestrator", "complete")],
        { completionReached: true },
      ),
    );
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand(
        { format: "json", id: "atomic-wf-claude-ralph-abcd1234" },
        deps,
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed.overall).toBe("completed");
    } finally {
      cap.restore();
    }
  });

  test("returns 'error' when fatalError is present in the snapshot", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(
      snapshotOf("ralph", "claude", [panelSession("orchestrator", "running")], {
        fatalError: "boom",
      }),
    );
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand(
        { format: "json", id: "atomic-wf-claude-ralph-abcd1234" },
        deps,
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed.overall).toBe("error");
      expect(parsed.fatalError).toBe("boom");
    } finally {
      cap.restore();
    }
  });

  test("returns 1 with a JSON error envelope when the requested id is unknown", async () => {
    const { deps } = makeDeps(tmpDir);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand(
        { format: "json", id: "atomic-wf-claude-ralph-deadbeef" },
        deps,
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.read());
      expect(parsed.error).toContain("not found");
    } finally {
      cap.restore();
    }
  });

  test("falls back to a minimal report when the orchestrator hasn't written a snapshot yet", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(null);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "json" }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed.workflows).toHaveLength(1);
      expect(parsed.workflows[0].overall).toBe("in_progress");
      expect(parsed.workflows[0].workflowName).toBe("");
    } finally {
      cap.restore();
    }
  });

  test("recognises a stale snapshot as 'error' when the tmux session is gone", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([]);
    // Place a real snapshot on disk so the dead-session post-mortem
    // path can read it.
    const sessionDir = join(tmpDir, "abcd1234");
    await mkdir(sessionDir, { recursive: true });
    await writeSnapshot(
      sessionDir,
      snapshotOf("ralph", "claude", [panelSession("orchestrator", "running")]),
    );
    // Use the real reader for this test so the dead-session lookup
    // hits the file we just wrote.
    deps.readSnapshot = (await import(
      "@bastani/atomic-sdk/runtime/status-writer"
    )).readSnapshot;
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand(
        { format: "json", id: "atomic-wf-claude-ralph-abcd1234" },
        deps,
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed.alive).toBe(false);
      expect(parsed.overall).toBe("error");
    } finally {
      cap.restore();
    }
  });

  test("text format: empty list prints the 'no workflows running' hint", async () => {
    const { deps } = makeDeps(tmpDir);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "text" }, deps);
      expect(code).toBe(0);
      expect(cap.read()).toContain("no workflows running");
    } finally {
      cap.restore();
    }
  });

  test("text format: renders a workflow list with indicator, id, and status", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(
      snapshotOf("ralph", "claude", [panelSession("orchestrator", "running")]),
    );
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "text" }, deps);
      expect(code).toBe(0);
      const out = cap.read();
      expect(out).toContain("atomic-wf-claude-ralph-abcd1234");
      expect(out).toContain("in_progress");
      expect(out).toContain("ralph");
      // singular noun when list has exactly one workflow
      expect(out).toContain("1");
    } finally {
      cap.restore();
    }
  });

  test("text format: list uses '(no snapshot)' placeholder when workflowName is empty", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(null);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "text" }, deps);
      expect(code).toBe(0);
      expect(cap.read()).toContain("(no snapshot)");
    } finally {
      cap.restore();
    }
  });

  test("text format: single-report render includes workflow, stages, fatal error, and updatedAt", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.listSessions.mockReturnValue([
      tmuxSession("atomic-wf-claude-ralph-abcd1234"),
    ]);
    mocks.readSnapshot.mockResolvedValue(
      snapshotOf(
        "ralph",
        "claude",
        [
          panelSession("orchestrator", "error", { error: "stage boom" }),
        ],
        { fatalError: "the whole thing" },
      ),
    );
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand(
        { format: "text", id: "atomic-wf-claude-ralph-abcd1234" },
        deps,
      );
      expect(code).toBe(0);
      const out = cap.read();
      expect(out).toContain("atomic-wf-claude-ralph-abcd1234");
      expect(out).toContain("workflow:");
      expect(out).toContain("ralph");
      expect(out).toContain("stages:");
      expect(out).toContain("orchestrator");
      expect(out).toContain("stage boom");
      expect(out).toContain("the whole thing");
      expect(out).toContain("updated:");
    } finally {
      cap.restore();
    }
  });

  test("text format: unknown id writes 'not found' to stderr and returns 1", async () => {
    const { deps } = makeDeps(tmpDir);
    const errChunks: string[] = [];
    const origErr = process.stderr.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      errChunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await workflowStatusCommand(
        { format: "text", id: "atomic-wf-claude-ralph-deadbeef" },
        deps,
      );
      expect(code).toBe(1);
      expect(errChunks.join("")).toContain("not found");
    } finally {
      process.stderr.write = origErr;
    }
  });

  test("reports zero workflows when tmux is not installed", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.isTmuxInstalled.mockReturnValue(false);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "json" }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.read());
      expect(parsed).toEqual({ workflows: [] });
    } finally {
      cap.restore();
    }
  });

  test("text format: tmux not installed prints the 'no sessions running' hint", async () => {
    const { deps, mocks } = makeDeps(tmpDir);
    mocks.isTmuxInstalled.mockReturnValue(false);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({ format: "text" }, deps);
      expect(code).toBe(0);
      expect(cap.read()).toContain("tmux is not installed");
    } finally {
      cap.restore();
    }
  });

  test("defaults format to 'json' when omitted", async () => {
    const { deps } = makeDeps(tmpDir);
    const cap = captureStdout();
    try {
      const code = await workflowStatusCommand({}, deps);
      expect(code).toBe(0);
      // JSON parses cleanly
      JSON.parse(cap.read());
    } finally {
      cap.restore();
    }
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });
});
