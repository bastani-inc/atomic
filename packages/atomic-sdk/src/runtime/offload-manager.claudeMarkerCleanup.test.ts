/**
 * Tests for claudeOffloadCleanup wiring inside OffloadManager.killOnePane.
 * Spec: specs/2026-05-08-workflow-pane-offload-and-resume.md §5.4
 */

import { test, expect, mock, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOffloadManager } from "./offload-manager.ts";
import type { OffloadManagerDeps } from "./offload-manager.ts";
import type { AgentKind } from "./offload-types.ts";
import type { SessionData } from "../components/orchestrator-panel-types.ts";
import type { MetadataJsonWithResume } from "./offload-types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = 1_717_804_800_000;
const TMUX_SESSION = "atomic-wf-cleanup-test-1";

const IMMUTABLES: Omit<MetadataJsonWithResume, "resume"> = {
  name: "build",
  description: "Build stage",
  agent: "claude" as const,
  paneId: "%9",
  serverUrl: "",
  port: 0,
  startedAt: new Date(FIXED_NOW).toISOString(),
};

function makeStageDir(agentOverride: AgentKind = "claude"): string {
  const dir = mkdtempSync(join(tmpdir(), "offload-cleanup-"));
  writeFileSync(
    join(dir, "metadata.json"),
    JSON.stringify(
      { ...IMMUTABLES, agent: agentOverride } satisfies Omit<MetadataJsonWithResume, "resume">,
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return dir;
}

type EmitCall = { event: string; payload: Record<string, unknown> };

interface MutablePanelStore {
  sessions: SessionData[];
  activeAgentId: string;
  setSessionStatus: ReturnType<typeof mock>;
}

const CLEAN_RESULT = {
  readyCleared: true,
  stopCleared: true,
  pidCleared: true,
  inflightCleared: true,
  failures: 0,
};

function makeDeps(
  agentOverride: AgentKind = "claude",
  stageDirOverride?: string,
): {
  deps: OffloadManagerDeps;
  panelStore: MutablePanelStore;
  emitCalls: EmitCall[];
  stageDir: string;
  callOrder: string[];
} {
  const emitCalls: EmitCall[] = [];
  const callOrder: string[] = [];
  const stageDir = stageDirOverride ?? makeStageDir(agentOverride);

  const panelStore: MutablePanelStore = {
    sessions: [{ name: "build", status: "complete", parents: [], startedAt: null, endedAt: null }],
    activeAgentId: "",
    setSessionStatus: mock(() => {}),
  };

  const claudeCleanupMock = mock(async (_id: string) => {
    callOrder.push("cleanup");
    return { ...CLEAN_RESULT };
  });

  const killWindowMock = mock(async (_session: string, _window: string) => {
    callOrder.push("killWindow");
  });

  const deps: OffloadManagerDeps = {
    panelStore: panelStore as unknown as OffloadManagerDeps["panelStore"],
    tmux: {
      killWindow: killWindowMock,
      createWindow: mock(async () => {}),
      selectWindow: mock(async () => {}),
    },
    providers: {
      claude:   { buildResumeArgs: mock(() => []) },
      opencode: { buildResumeArgs: mock(() => []) },
      copilot:  { buildResumeArgs: mock(() => []) },
    },
    hookSettingsPath: mock(() => "/tmp/hook-settings.json"),
    shellQuote: mock((argv: readonly string[]) => argv.join(" ")),
    waitForReady: mock(async (_agent: AgentKind, _id: string, _pane: string) => {}),
    now: mock(() => FIXED_NOW),
    emit: mock((event: string, payload: Record<string, unknown>) => {
      emitCalls.push({ event, payload });
    }),
    claudeOffloadCleanup: claudeCleanupMock,
  };

  return { deps, panelStore, emitCalls, stageDir, callOrder };
}

function makeSessionInput(
  name: string,
  stageDir: string,
  agent: AgentKind = "claude",
) {
  return {
    name,
    runId: "run-abc",
    stageDir,
    agent,
    agentSessionId: "sess-xyz",
    tmuxSession: TMUX_SESSION,
    tmuxWindow: name,
    spawnEnv: { CLAUDECODE: "1" },
    spawnCwd: "/home/user/project",
    headless: false,
    chatFlags: [],
  };
}

// ---------------------------------------------------------------------------
// 1. claude branch: cleanup called before killWindow, telemetry emitted
// ---------------------------------------------------------------------------

describe("killOnePane: claude marker cleanup", () => {
  test("calls claudeOffloadCleanup before killWindow, emits WORKFLOW_OFFLOAD_CLAUDE_MARKER_CLEANUP", async () => {
    const { deps, emitCalls, stageDir, callOrder } = makeDeps("claude");
    const mgr = createOffloadManager(deps);
    await mgr.registerSession(makeSessionInput("build", stageDir, "claude"));

    await mgr.onWorkflowCompletion();

    // cleanup called once with the correct agentSessionId
    expect(deps.claudeOffloadCleanup).toHaveBeenCalledTimes(1);
    expect((deps.claudeOffloadCleanup as ReturnType<typeof mock>).mock.calls[0]![0]).toBe("sess-xyz");

    // cleanup called BEFORE killWindow
    expect(callOrder).toEqual(["cleanup", "killWindow"]);

    // WORKFLOW_OFFLOAD_CLAUDE_MARKER_CLEANUP emitted with full payload
    const cleanupEvent = emitCalls.find(
      (c) => c.event === "workflow.offload.claude_marker_cleanup",
    );
    expect(cleanupEvent).toBeDefined();
    expect(cleanupEvent!.payload).toMatchObject({
      runId: "run-abc",
      name: "build",
      agentSessionId: "sess-xyz",
      readyCleared: true,
      stopCleared: true,
      pidCleared: true,
      inflightCleared: true,
      failures: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // 2. non-claude branch: cleanup NOT called, event NOT emitted
  // ---------------------------------------------------------------------------

  test("opencode session: claudeOffloadCleanup not called, no WORKFLOW_OFFLOAD_CLAUDE_MARKER_CLEANUP", async () => {
    const stageDir = makeStageDir("opencode");
    const { deps, emitCalls } = makeDeps("opencode", stageDir);
    // Patch metadata.json agent field to opencode (fixture helper already does this)
    const mgr = createOffloadManager(deps);
    await mgr.registerSession(makeSessionInput("build", stageDir, "opencode"));

    await mgr.onWorkflowCompletion();

    expect(deps.claudeOffloadCleanup).not.toHaveBeenCalled();
    expect(emitCalls.some((c) => c.event === "workflow.offload.claude_marker_cleanup")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 3. failures recorded in payload
  // ---------------------------------------------------------------------------

  test("failures in cleanup result are forwarded in telemetry payload", async () => {
    const { deps, emitCalls, stageDir } = makeDeps("claude");
    // Override mock to return failures: 2
    deps.claudeOffloadCleanup = mock(async (_id: string) => ({
      readyCleared: false,
      stopCleared: false,
      pidCleared: true,
      inflightCleared: true,
      failures: 2,
    }));
    const mgr = createOffloadManager(deps);
    await mgr.registerSession(makeSessionInput("build", stageDir, "claude"));

    await mgr.onWorkflowCompletion();

    const cleanupEvent = emitCalls.find(
      (c) => c.event === "workflow.offload.claude_marker_cleanup",
    );
    expect(cleanupEvent).toBeDefined();
    expect(cleanupEvent!.payload.failures).toBe(2);

    // Kill still proceeded
    expect(deps.tmux.killWindow).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 4. cleanup throws: kill still proceeds
  // ---------------------------------------------------------------------------

  test("if claudeOffloadCleanup throws, killWindow still called", async () => {
    const { deps, stageDir } = makeDeps("claude");
    deps.claudeOffloadCleanup = mock(async (_id: string) => {
      throw new Error("boom");
    });
    const mgr = createOffloadManager(deps);
    await mgr.registerSession(makeSessionInput("build", stageDir, "claude"));

    // Must not throw
    await mgr.onWorkflowCompletion();

    expect(deps.tmux.killWindow).toHaveBeenCalledTimes(1);
  });
});
