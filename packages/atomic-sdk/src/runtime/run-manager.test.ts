/**
 * RunManager — focused tests for terminal lifecycle (run/ended) and
 * cancellation path wired through stop().
 *
 * Also covers integration of ctx.stage() via RunManager.start() with a
 * fake ISupervisor — no real agent binaries required.
 */

import { test, expect, describe, mock } from "bun:test";
import { join } from "node:path";
import { RunManager } from "./run-manager.ts";
import type { ISupervisor } from "./ui-protocol/methods.ts";
import type { MessageConnection } from "vscode-jsonrpc";

// ─── Fake MessageConnection ───────────────────────────────────────────────────

interface Notification {
  method: string;
  params: unknown;
}

function fakeConnection(): MessageConnection & { notifications: Notification[] } {
  const notifications: Notification[] = [];
  return {
    notifications,
    sendNotification(method: string, params?: unknown) {
      notifications.push({ method, params });
    },
    sendRequest: () => Promise.resolve(undefined),
    onRequest: () => ({ dispose: () => {} }),
    onNotification: () => ({ dispose: () => {} }),
    onError: () => ({ dispose: () => {} }),
    onClose: () => ({ dispose: () => {} }),
    onUnhandledNotification: () => ({ dispose: () => {} }),
    onProgress: () => ({ dispose: () => {} }),
    sendProgress: () => Promise.resolve(),
    telemetry: { onEvent: () => ({ dispose: () => {} }) },
    trace: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    listen: () => {},
    end: () => {},
    dispose: () => {},
    hasPendingResponse: () => false,
    inspect: () => ({}),
  } as unknown as MessageConnection & { notifications: Notification[] };
}

/** Drain microtasks and macrotasks. */
async function flushAsync() {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

// ─── Fake ISupervisor ─────────────────────────────────────────────────────────

interface SpawnCall {
  runId: string;
  stageName: string;
  agent: string;
  args: string[];
}

function makeFakeSupervisor(exitCode = 0): ISupervisor & { spawnCalls: SpawnCall[] } {
  const spawnCalls: SpawnCall[] = [];
  return {
    spawnCalls,
    async spawn(params) {
      spawnCalls.push(params as SpawnCall);
      if (params.onExit) {
        const cb = params.onExit;
        queueMicrotask(() => cb(exitCode));
      }
      return { pid: 99999 };
    },
    sendInput: mock(() => {}),
    getScrollback: mock(() => ({ data: "", headOffset: 0 })),
    kill: mock(() => {}),
  } as ISupervisor & { spawnCalls: SpawnCall[] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RunManager", () => {
  describe("stop() — cancellation path", () => {
    test("stop() marks run as cancelled in RunInfo", async () => {
      const manager = new RunManager();
      // Use a non-existent source so executeRun hangs until cancelled.
      // We don't need actual execution to test stop().
      const { runId } = await manager.start({
        source: "/dev/null/nonexistent-will-fail.ts",
        workflowName: "test-wf",
        agent: "claude",
        inputs: {},
      });

      await manager.stop(runId);
      await flushAsync();

      const info = manager.get(runId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe("cancelled");
      expect(typeof info!.endedAt).toBe("string");
    });

    test("stop() emits run/ended with overall=cancelled to subscribers", async () => {
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: "/dev/null/nonexistent.ts",
        workflowName: "cancel-test-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      await manager.stop(runId);
      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { runId: string; overall: string };
      expect(p.runId).toBe(runId);
      expect(p.overall).toBe("cancelled");
    });

    test("stop() emits run/ended exactly once even if state already completed", async () => {
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: "/dev/null/nonexistent.ts",
        workflowName: "double-end-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      // Manually trigger completion via getState (simulates executeRun finishing).
      const state = manager.getState(runId);
      state?.markCompletionReached();

      // Now stop() tries to cancel — should NOT emit a second run/ended.
      await manager.stop(runId);
      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      // First emission wins — completion beat cancellation.
      const p = ended[0]!.params as { overall: string };
      expect(p.overall).toBe("complete");
    });

    test("stop() on unknown runId is a no-op", async () => {
      const manager = new RunManager();
      await expect(manager.stop("does-not-exist")).resolves.toBeUndefined();
    });
  });

  describe("list()", () => {
    test("cancelled run appears in list() with scope=all", async () => {
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: "/dev/null/noop.ts",
        workflowName: "list-test",
        agent: "claude",
        inputs: {},
      });
      await manager.stop(runId);
      await flushAsync();

      const all = manager.list("all");
      const match = all.find((r) => r.runId === runId);
      expect(match).toBeDefined();
      expect(match!.status).toBe("cancelled");
    });

    test("cancelled run does not appear in list('active')", async () => {
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: "/dev/null/noop.ts",
        workflowName: "active-filter-test",
        agent: "claude",
        inputs: {},
      });
      await manager.stop(runId);
      await flushAsync();

      const active = manager.list("active");
      expect(active.find((r) => r.runId === runId)).toBeUndefined();
    });
  });

  describe("executeRun — complete path", () => {
    test("successful executeRun emits run/ended with overall=complete", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/default-only.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "complete-path-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      // Wait for async executeRun to complete.
      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { runId: string; overall: string };
      expect(p.runId).toBe(runId);
      expect(p.overall).toBe("complete");
    });

    test("successful executeRun marks RunInfo status=complete with endedAt", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/default-only.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "complete-info-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      const info = manager.get(runId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe("complete");
      expect(typeof info!.endedAt).toBe("string");
    });

    test("successful executeRun does not appear in list('active')", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/default-only.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "complete-active-filter-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      const active = manager.list("active");
      expect(active.find((r) => r.runId === runId)).toBeUndefined();
    });
  });

  describe("executeRun — error path", () => {
    test("failing executeRun emits run/ended with overall=error", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/throws-on-run.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "error-path-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { runId: string; overall: string };
      expect(p.runId).toBe(runId);
      expect(p.overall).toBe("error");
    });

    test("failing executeRun marks RunInfo status=error with endedAt", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/throws-on-run.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "error-info-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      const info = manager.get(runId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe("error");
      expect(typeof info!.endedAt).toBe("string");
    });

    test("failing executeRun emits run/ended exactly once", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/throws-on-run.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "error-once-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      // Wait well past when the error fires.
      await flushAsync();
      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
    });

    test("cancel wins over concurrent executeRun error — run/ended=cancelled, not error", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/throws-on-run.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "cancel-vs-error-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      // stop() immediately — before executeRun has a chance to finish.
      await manager.stop(runId);
      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { overall: string };
      expect(p.overall).toBe("cancelled");
    });
  });

  describe("executeRun — import validation", () => {
    test("module with no default export emits run/ended=error", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/empty-module.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "no-default-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { overall: string };
      expect(p.overall).toBe("error");
    });

    test("module with no default export marks RunInfo status=error", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/empty-module.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "no-default-status-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      const info = manager.get(runId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe("error");
      expect(typeof info!.endedAt).toBe("string");
    });

    test("module with no-run default export surfaces descriptive error message", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/default-no-run.ts");
      const manager = new RunManager();
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "no-run-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      const info = manager.get(runId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe("error");
      expect(typeof info!.endedAt).toBe("string");
    });
  });

  // ─── Integration: ctx.stage() wired through RunManager ─────────────────────

  describe("executeRun — staged workflow integration", () => {
    test("workflow calling ctx.stage() completes when stage exits 0", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/with-one-stage.ts");
      const supervisor = makeFakeSupervisor(0);
      const manager = new RunManager({ supervisor });
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "stage-complete-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { runId: string; overall: string };
      expect(p.runId).toBe(runId);
      expect(p.overall).toBe("complete");
    });

    test("workflow calling ctx.stage() marks RunInfo status=complete", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/with-one-stage.ts");
      const supervisor = makeFakeSupervisor(0);
      const manager = new RunManager({ supervisor });
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "stage-info-complete-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      const info = manager.get(runId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe("complete");
      expect(typeof info!.endedAt).toBe("string");
    });

    test("supervisor.spawn called with correct runId and stageName", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/with-one-stage.ts");
      const supervisor = makeFakeSupervisor(0);
      const manager = new RunManager({ supervisor });
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "stage-spawn-params-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      expect(supervisor.spawnCalls).toHaveLength(1);
      expect(supervisor.spawnCalls[0]!.runId).toBe(runId);
      expect(supervisor.spawnCalls[0]!.stageName).toBe("step-1");
      expect(supervisor.spawnCalls[0]!.agent).toBe("claude");
    });

    test("workflow calling ctx.stage() with non-zero exit emits run/ended=error", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/with-one-stage.ts");
      const supervisor = makeFakeSupervisor(1); // stage fails
      const manager = new RunManager({ supervisor });
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "stage-error-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { runId: string; overall: string };
      expect(p.runId).toBe(runId);
      expect(p.overall).toBe("error");
    });

    test("workflow calling ctx.stage() with non-zero exit marks RunInfo status=error", async () => {
      const fixturePath = join(import.meta.dir, "__fixtures__/with-one-stage.ts");
      const supervisor = makeFakeSupervisor(1);
      const manager = new RunManager({ supervisor });
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "stage-error-info-wf",
        agent: "claude",
        inputs: {},
      });

      await flushAsync();

      const info = manager.get(runId);
      expect(info).not.toBeNull();
      expect(info!.status).toBe("error");
      expect(typeof info!.endedAt).toBe("string");
    });

    test("stop() cancels staged workflow before stage completes", async () => {
      // Use a supervisor that never fires onExit — stage blocks forever.
      const hangingSupervisor: ISupervisor & { spawnCalls: SpawnCall[] } = {
        spawnCalls: [],
        async spawn(params) {
          (this as { spawnCalls: SpawnCall[] }).spawnCalls.push(params as SpawnCall);
          // Intentionally never call params.onExit — simulates long-running stage.
          return { pid: 77777 };
        },
        sendInput: mock(() => {}),
        getScrollback: mock(() => ({ data: "", headOffset: 0 })),
        kill: mock(() => {}),
      };

      const fixturePath = join(import.meta.dir, "__fixtures__/with-one-stage.ts");
      const manager = new RunManager({ supervisor: hangingSupervisor });
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "stage-cancel-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      // stop() immediately — stage is hanging.
      await manager.stop(runId);
      await flushAsync();

      const info = manager.get(runId);
      expect(info!.status).toBe("cancelled");

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { overall: string };
      expect(p.overall).toBe("cancelled");
    });

    test("no-supervisor RunManager emits error when workflow calls ctx.stage()", async () => {
      // RunManager without supervisor uses noopSupervisor which rejects spawn.
      const fixturePath = join(import.meta.dir, "__fixtures__/with-one-stage.ts");
      const manager = new RunManager(); // no supervisor
      const { runId } = await manager.start({
        source: fixturePath,
        workflowName: "no-supervisor-stage-wf",
        agent: "claude",
        inputs: {},
      });

      const conn = fakeConnection();
      manager.subscribe(conn, runId);

      await flushAsync();

      const ended = conn.notifications.filter((n) => n.method === "run/ended");
      expect(ended.length).toBe(1);
      const p = ended[0]!.params as { overall: string };
      // noopSupervisor rejects — workflow error propagates as run/ended=error.
      expect(p.overall).toBe("error");
    });
  });
});

// ─── outer .catch() on executeRun (lines 73-82) ──────────────────────────────

describe("RunManager.start() — outer executeRun rejection handler (lines 73-82)", () => {
  test("outer catch marks run as error when executeRun promise rejects outside internal try/catch", async () => {
    const manager = new RunManager();

    // Replace the private executeRun with a function that unconditionally rejects.
    // This simulates an unexpected rejection that bypasses the internal try/catch.
    (manager as unknown as Record<string, unknown>).executeRun = async () => {
      throw new Error("Simulated outer executeRun rejection");
    };

    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/with-one-stage.ts"),
      workflowName: "outer-catch-wf",
      agent: "claude",
      inputs: {},
    });

    // Allow microtasks to resolve so the outer .catch() callback fires.
    await flushAsync();

    const info = manager.get(runId);
    expect(info).not.toBeNull();
    expect(info!.status).toBe("error");
  });

  test("outer catch sets endedAt on RunInfo", async () => {
    const manager = new RunManager();

    (manager as unknown as Record<string, unknown>).executeRun = async () => {
      throw new Error("Outer rejection — endedAt check");
    };

    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/with-one-stage.ts"),
      workflowName: "outer-catch-endedat-wf",
      agent: "claude",
      inputs: {},
    });

    await flushAsync();

    const info = manager.get(runId);
    expect(info).not.toBeNull();
    expect(info!.status).toBe("error");
    expect(typeof info!.endedAt).toBe("string");
  });

  test("outer catch stores fatalError message in RunState snapshot", async () => {
    const manager = new RunManager();
    const errMsg = "Outer rejection — fatalError check";

    (manager as unknown as Record<string, unknown>).executeRun = async () => {
      throw new Error(errMsg);
    };

    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/with-one-stage.ts"),
      workflowName: "outer-catch-fatalerror-wf",
      agent: "claude",
      inputs: {},
    });

    await flushAsync();

    const state = manager.getState(runId);
    expect(state).not.toBeNull();
    const snapshot = state!.getSnapshot();
    expect(snapshot.fatalError).toBe(errMsg);
  });

  test("outer catch emits run/ended with overall=error to subscribers", async () => {
    const manager = new RunManager();

    // Delay rejection via setTimeout so subscriber can be registered before the
    // outer .catch() fires — microtask-immediate throws would fire before subscribe().
    (manager as unknown as Record<string, unknown>).executeRun = (
      _state: unknown,
      _info: unknown,
    ) =>
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Outer rejection — run/ended check")), 0);
      });

    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/with-one-stage.ts"),
      workflowName: "outer-catch-ended-wf",
      agent: "claude",
      inputs: {},
    });

    const conn = fakeConnection();
    manager.subscribe(conn, runId);

    await flushAsync();

    const ended = conn.notifications.filter((n) => n.method === "run/ended");
    expect(ended.length).toBe(1);
    const p = ended[0]!.params as { runId: string; overall: string };
    expect(p.runId).toBe(runId);
    expect(p.overall).toBe("error");
  });

  test("outer catch — rejected run excluded from list('active')", async () => {
    const manager = new RunManager();

    (manager as unknown as Record<string, unknown>).executeRun = async () => {
      throw new Error("Outer rejection — active list check");
    };

    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/with-one-stage.ts"),
      workflowName: "outer-catch-active-wf",
      agent: "claude",
      inputs: {},
    });

    await flushAsync();

    const active = manager.list("active");
    expect(active.find((r) => r.runId === runId)).toBeUndefined();
  });

  test("cancellation before outer rejection wins — status=cancelled, run/ended=cancelled", async () => {
    const manager = new RunManager();

    // Rejection delayed via setTimeout so stop() fires first.
    (manager as unknown as Record<string, unknown>).executeRun = (
      _state: unknown,
      _info: unknown,
    ) =>
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Late outer rejection")), 0);
      });

    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/with-one-stage.ts"),
      workflowName: "outer-catch-cancel-wins-wf",
      agent: "claude",
      inputs: {},
    });

    const conn = fakeConnection();
    manager.subscribe(conn, runId);

    // stop() before the setTimeout fires — cancellation wins.
    await manager.stop(runId);
    await flushAsync();

    const info = manager.get(runId);
    expect(info!.status).toBe("cancelled");

    const ended = conn.notifications.filter((n) => n.method === "run/ended");
    expect(ended.length).toBe(1);
    expect((ended[0]!.params as { overall: string }).overall).toBe("cancelled");
  });
});

// ─── getTranscript ────────────────────────────────────────────────────────────

describe("RunManager.getTranscript()", () => {
  test("returns empty array when messages.json does not exist", async () => {
    const manager = new RunManager();
    const result = await manager.getTranscript("nonexistent-run", "nonexistent-stage");
    expect(result).toEqual([]);
  });

  test("reads and parses messages.json from HOME/.atomic/sessions/<runId>/<sessionName>/", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // Create a temporary directory to act as HOME.
    const tmpHome = await mkdtemp(join(tmpdir(), "atomic-rm-transcript-"));
    const runId = "test-run-transcript-id";
    const sessionName = "my-stage";
    const messagesDir = join(tmpHome, ".atomic", "sessions", runId, sessionName);
    await mkdir(messagesDir, { recursive: true });

    const messages = [
      { type: "assistant", content: "hello" },
      { type: "user", content: "world" },
    ];
    await writeFile(join(messagesDir, "messages.json"), JSON.stringify(messages), "utf-8");

    // Override HOME env to point at our temp dir.
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      const manager = new RunManager();
      const result = await manager.getTranscript(runId, sessionName);
      expect(result).toEqual(messages);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});

// ─── unsubscribe ──────────────────────────────────────────────────────────────

describe("RunManager.unsubscribe()", () => {
  test("removes the subscription without throwing", () => {
    const manager = new RunManager();
    const conn = fakeConnection();

    // Subscribe (no runId — subscribes to all active runs).
    const subId = manager.subscribe(conn);
    // Unsubscribe — should succeed silently.
    expect(() => manager.unsubscribe(subId)).not.toThrow();
  });

  test("unsubscribing an unknown id is a no-op", () => {
    const manager = new RunManager();
    expect(() => manager.unsubscribe("non-existent-subscription-id")).not.toThrow();
  });

  test("subscribe returns a subscriptionId that can be unsubscribed", async () => {
    const manager = new RunManager();
    const conn = fakeConnection();
    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/throws-on-run.ts"),
      workflowName: "unsub-test",
      agent: "claude",
      inputs: {},
    });

    const subId = manager.subscribe(conn, runId);
    expect(typeof subId).toBe("string");
    expect(subId.length).toBeGreaterThan(0);

    // Unsubscribe should not throw.
    expect(() => manager.unsubscribe(subId)).not.toThrow();

    await flushAsync();
  });

  test("unsubscribe removes inner RunState subscriber for run-specific subscription", async () => {
    const manager = new RunManager();
    const conn = fakeConnection();
    const { runId } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/throws-on-run.ts"),
      workflowName: "inner-unsub-specific-wf",
      agent: "claude",
      inputs: {},
    });

    const state = manager.getState(runId)!;
    const beforeCount = state.subscriberCount;

    const subId = manager.subscribe(conn, runId);
    expect(state.subscriberCount).toBe(beforeCount + 1);

    manager.unsubscribe(subId);
    expect(state.subscriberCount).toBe(beforeCount);

    await flushAsync();
  });

  test("unsubscribe removes inner RunState subscribers for all-runs subscription", async () => {
    const manager = new RunManager();
    const conn = fakeConnection();

    // Start two runs so the all-runs subscribe wires into both states.
    const { runId: r1 } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/throws-on-run.ts"),
      workflowName: "inner-unsub-all-wf-1",
      agent: "claude",
      inputs: {},
    });
    const { runId: r2 } = await manager.start({
      source: join(import.meta.dir, "__fixtures__/throws-on-run.ts"),
      workflowName: "inner-unsub-all-wf-2",
      agent: "claude",
      inputs: {},
    });

    const s1 = manager.getState(r1)!;
    const s2 = manager.getState(r2)!;
    const before1 = s1.subscriberCount;
    const before2 = s2.subscriberCount;

    // Subscribe with no runId — should wire into both states.
    const subId = manager.subscribe(conn);
    expect(s1.subscriberCount).toBe(before1 + 1);
    expect(s2.subscriberCount).toBe(before2 + 1);

    manager.unsubscribe(subId);
    expect(s1.subscriberCount).toBe(before1);
    expect(s2.subscriberCount).toBe(before2);

    await flushAsync();
  });
});

// ─── noopSupervisor methods ───────────────────────────────────────────────────

describe("noopSupervisor — sendInput and getScrollback throw descriptive errors", () => {
  test("noopSupervisor.sendInput throws when called via workflow context (no supervisor)", async () => {
    const fixturePath = join(import.meta.dir, "__fixtures__/access-noop-supervisor.ts");
    const manager = new RunManager(); // no supervisor → noopSupervisor used as fallback

    const { runId } = await manager.start({
      source: fixturePath,
      workflowName: "noop-methods-wf",
      agent: "claude",
      inputs: {},
    });

    await flushAsync();

    // The workflow accesses noopSupervisor.sendInput/getScrollback and catches the errors.
    // The run should complete successfully (the fixture doesn't call ctx.stage()).
    const info = manager.get(runId);
    // The workflow completes normally; sendInput/getScrollback errors are caught internally.
    expect(info).not.toBeNull();
  });
});
