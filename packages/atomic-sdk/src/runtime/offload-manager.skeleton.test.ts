/**
 * State-machine unit tests for the OffloadManager skeleton.
 * Spec: specs/2026-05-08-workflow-pane-offload-and-resume.md §5.2, task #12
 */

import { test, expect, mock } from "bun:test";
import { createOffloadManager } from "./offload-manager.ts";
import type { OffloadManagerDeps } from "./offload-manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): OffloadManagerDeps {
  return {
    panelStore: {
      setSessionStatus: mock(() => {}),
      activeAgentId: mock(() => null),
      sessions: mock(() => new Map()),
    },
    tmux: {
      killWindow: mock(async () => {}),
      createWindow: mock(async () => {}),
      sendKeys: mock(async () => {}),
      selectWindow: mock(async () => {}),
    },
    providers: {
      claude: { buildResumeArgs: mock(() => []) },
      opencode: { buildResumeArgs: mock(() => []) },
      copilot: { buildResumeArgs: mock(() => []) },
    },
    now: mock(() => Date.now()),
  };
}

function makeSessionInput(name = "review") {
  return {
    name,
    runId: "run-1",
    stageDir: "/tmp/stage/review",
    agent: "claude" as const,
    agentSessionId: "sess-abc",
    tmuxSession: "atomic-wf-claude-test-1",
    tmuxWindow: name,
    spawnEnv: { CLAUDECODE: "1" },
    spawnCwd: "/home/user/project",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("registerSession then getStatus returns 'alive'", () => {
  const mgr = createOffloadManager(makeDeps());
  mgr.registerSession(makeSessionInput("review"));
  expect(mgr.getStatus("review")).toBe("alive");
});

test("getStatus of unknown name returns 'alive' (defensive)", () => {
  const mgr = createOffloadManager(makeDeps());
  expect(mgr.getStatus("nonexistent")).toBe("alive");
});

test("onWorkflowCompletion rejects with 'not yet implemented (task-2)'", async () => {
  const mgr = createOffloadManager(makeDeps());
  mgr.registerSession(makeSessionInput("review"));
  await expect(mgr.onWorkflowCompletion()).rejects.toThrow("not yet implemented (task-2)");
});

test("requestResume rejects with 'not yet implemented (task-13)'", async () => {
  const mgr = createOffloadManager(makeDeps());
  mgr.registerSession(makeSessionInput("review"));
  await expect(mgr.requestResume("review")).rejects.toThrow("not yet implemented (task-13)");
});

test("multiple registerSession calls coexist independently", () => {
  const mgr = createOffloadManager(makeDeps());
  mgr.registerSession(makeSessionInput("stage-a"));
  mgr.registerSession(makeSessionInput("stage-b"));
  expect(mgr.getStatus("stage-a")).toBe("alive");
  expect(mgr.getStatus("stage-b")).toBe("alive");
  expect(mgr.getStatus("stage-c")).toBe("alive"); // unknown → defensive alive
});

test("idempotency: two concurrent calls for same op-name share the underlying promise (op invoked once)", async () => {
  const { _testOnlyGetOrStartOp } = await import("./offload-manager.ts");

  // Use an isolated per-test queue so module-level state doesn't bleed between tests.
  const testQueue = new Map<string, Promise<void>>();

  let invokeCount = 0;
  const op = async () => {
    invokeCount++;
    await Promise.resolve();
  };

  const p1 = _testOnlyGetOrStartOp("x", op, testQueue);
  const p2 = _testOnlyGetOrStartOp("x", op, testQueue);

  expect(p1).toBe(p2); // same promise object — deduplication in effect
  await Promise.all([p1, p2]);
  expect(invokeCount).toBe(1); // op only ran once — not double-invoked
});
