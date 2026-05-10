import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunState, type RunStateOptions } from "./run-state.ts";
import { readSnapshot } from "./status-writer.ts";
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
    // Stub unused members
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<RunStateOptions> = {}) {
  return new RunState({
    runId: "test-run-123",
    workflowName: "test-workflow",
    agent: "claude",
    projectRoot: "/tmp/test-project",
    ...overrides,
  });
}

/** Wait for all pending microtasks and macrotasks. */
async function flushAsync() {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RunState", () => {
  describe("constructor", () => {
    test("stores identity fields", () => {
      const state = makeState();
      expect(state.runId).toBe("test-run-123");
      expect(state.workflowName).toBe("test-workflow");
      expect(state.agent).toBe("claude");
      expect(state.projectRoot).toBe("/tmp/test-project");
    });
  });

  describe("subscribe / unsubscribe", () => {
    test("subscribe returns a unique subscriptionId", () => {
      const state = makeState();
      const conn1 = fakeConnection();
      const conn2 = fakeConnection();
      const id1 = state.subscribe(conn1);
      const id2 = state.subscribe(conn2);
      expect(typeof id1).toBe("string");
      expect(typeof id2).toBe("string");
      expect(id1).not.toBe(id2);
      state.dispose();
    });

    test("unsubscribe stops notifications reaching that connection", async () => {
      const state = makeState();
      const conn = fakeConnection();
      const subId = state.subscribe(conn);

      state.unsubscribe(subId);
      state.addStage({ name: "stage-a" });
      await flushAsync();

      // No panel/update should have been sent after unsubscribe.
      const updates = conn.notifications.filter((n) => n.method === "panel/update");
      expect(updates.length).toBe(0);
      state.dispose();
    });

    test("unsubscribe on unknown id is a no-op", () => {
      const state = makeState();
      expect(() => state.unsubscribe("does-not-exist")).not.toThrow();
      state.dispose();
    });
  });

  describe("getSnapshot", () => {
    test("returns snapshot with correct runId and workflowName", () => {
      const state = makeState();
      const snap = state.getSnapshot();
      expect(snap.workflowRunId).toBe("test-run-123");
      expect(snap.workflowName).toBe("test-workflow");
      expect(snap.agent).toBe("claude");
      state.dispose();
    });

    test("initial overall status is in_progress", () => {
      const state = makeState();
      expect(state.getSnapshot().overall).toBe("in_progress");
      state.dispose();
    });
  });

  describe("addStage / updateStage", () => {
    test("addStage inserts a pending stage into snapshot", () => {
      const state = makeState();
      state.addStage({ name: "build" });
      const snap = state.getSnapshot();
      const row = snap.sessions.find((s) => s.name === "build");
      expect(row).toBeDefined();
      expect(row!.status).toBe("pending");
      state.dispose();
    });

    test("updateStage patches an existing stage", () => {
      const state = makeState();
      state.addStage({ name: "lint" });
      state.updateStage("lint", { status: "running", startedAt: 1000 });
      const snap = state.getSnapshot();
      const row = snap.sessions.find((s) => s.name === "lint");
      expect(row!.status).toBe("running");
      expect(row!.startedAt).toBe(1000);
      state.dispose();
    });

    test("updateStage on unknown name is a no-op", () => {
      const state = makeState();
      expect(() => state.updateStage("nonexistent", { status: "complete" })).not.toThrow();
      state.dispose();
    });
  });

  describe("sessionStarted / sessionEnded / setError", () => {
    test("sessionStarted sets status running and startedAt", () => {
      const state = makeState();
      state.addStage({ name: "test" });
      state.sessionStarted("test");
      const row = state.getSnapshot().sessions.find((s) => s.name === "test")!;
      expect(row.status).toBe("running");
      expect(typeof row.startedAt).toBe("number");
      state.dispose();
    });

    test("sessionEnded without error sets complete", () => {
      const state = makeState();
      state.addStage({ name: "deploy" });
      state.sessionEnded("deploy", "complete");
      const row = state.getSnapshot().sessions.find((s) => s.name === "deploy")!;
      expect(row.status).toBe("complete");
      expect(typeof row.endedAt).toBe("number");
      state.dispose();
    });

    test("sessionEnded with error sets error status and message", () => {
      const state = makeState();
      state.addStage({ name: "deploy" });
      state.sessionEnded("deploy", "error", "disk full");
      const snap = state.getSnapshot();
      const row = snap.sessions.find((s) => s.name === "deploy")!;
      expect(row.status).toBe("error");
      expect(row.error).toBe("disk full");
      expect(snap.overall).toBe("error");
      state.dispose();
    });

    test("setError sets fatalError and overall to error", () => {
      const state = makeState();
      state.setError("fatal boom");
      const snap = state.getSnapshot();
      expect(snap.fatalError).toBe("fatal boom");
      expect(snap.overall).toBe("error");
      state.dispose();
    });
  });

  describe("markCompletionReached", () => {
    test("sets overall to completed when no errors", () => {
      const state = makeState();
      state.markCompletionReached();
      expect(state.getSnapshot().overall).toBe("completed");
      state.dispose();
    });
  });

  describe("panel/update broadcast (coalescing)", () => {
    test("single mutation → single panel/update notification", async () => {
      const state = makeState();
      const conn = fakeConnection();
      state.subscribe(conn);

      state.addStage({ name: "a" });
      await flushAsync();

      const updates = conn.notifications.filter((n) => n.method === "panel/update");
      expect(updates.length).toBe(1);
      state.dispose();
    });

    test("multiple synchronous mutations coalesce into one notification", async () => {
      const state = makeState();
      const conn = fakeConnection();
      state.subscribe(conn);

      // Three mutations in the same tick.
      state.addStage({ name: "x" });
      state.addStage({ name: "y" });
      state.addStage({ name: "z" });
      await flushAsync();

      const updates = conn.notifications.filter((n) => n.method === "panel/update");
      expect(updates.length).toBe(1);
      state.dispose();
    });

    test("panel/update params include runId and snapshot", async () => {
      const state = makeState();
      const conn = fakeConnection();
      state.subscribe(conn);

      state.addStage({ name: "stage-1" });
      await flushAsync();

      const update = conn.notifications.find((n) => n.method === "panel/update");
      expect(update).toBeDefined();
      const params = update!.params as { runId: string; snapshot: unknown };
      expect(params.runId).toBe("test-run-123");
      expect(params.snapshot).toBeDefined();
      state.dispose();
    });

    test("multiple subscribers each receive the notification", async () => {
      const state = makeState();
      const conn1 = fakeConnection();
      const conn2 = fakeConnection();
      state.subscribe(conn1);
      state.subscribe(conn2);

      state.addStage({ name: "multi" });
      await flushAsync();

      const u1 = conn1.notifications.filter((n) => n.method === "panel/update");
      const u2 = conn2.notifications.filter((n) => n.method === "panel/update");
      expect(u1.length).toBe(1);
      expect(u2.length).toBe(1);
      state.dispose();
    });

    test("subscriber error does not block other subscribers", async () => {
      const state = makeState();
      const bad = {
        notifications: [],
        sendNotification() {
          throw new Error("network gone");
        },
      } as unknown as MessageConnection & { notifications: Notification[] };
      const good = fakeConnection();

      state.subscribe(bad as unknown as MessageConnection);
      state.subscribe(good);

      state.addStage({ name: "fault-test" });
      await flushAsync();

      // good connection still got notified.
      const updates = good.notifications.filter((n) => n.method === "panel/update");
      expect(updates.length).toBe(1);
      state.dispose();
    });
  });

  describe("setForeground", () => {
    test("broadcasts panel/foregroundChange immediately", async () => {
      const state = makeState();
      const conn = fakeConnection();
      state.subscribe(conn);

      state.setForeground("stage-a");
      await flushAsync();

      const fc = conn.notifications.filter((n) => n.method === "panel/foregroundChange");
      expect(fc.length).toBeGreaterThanOrEqual(1);
      const params = fc[0]!.params as { runId: string; stageName: string | null };
      expect(params.runId).toBe("test-run-123");
      expect(params.stageName).toBe("stage-a");
      state.dispose();
    });

    test("setForeground(null) clears foreground", async () => {
      const state = makeState();
      const conn = fakeConnection();
      state.subscribe(conn);

      state.setForeground(null);
      await flushAsync();

      const fc = conn.notifications.find((n) => n.method === "panel/foregroundChange");
      const params = fc!.params as { stageName: string | null };
      expect(params.stageName).toBeNull();
      state.dispose();
    });
  });

  describe("dispose", () => {
    test("after dispose, mutations do not produce notifications", async () => {
      const state = makeState();
      const conn = fakeConnection();
      state.subscribe(conn);
      state.dispose();

      state.addStage({ name: "after-dispose" });
      await flushAsync();

      const updates = conn.notifications.filter((n) => n.method === "panel/update");
      expect(updates.length).toBe(0);
    });

    test("dispose is idempotent", () => {
      const state = makeState();
      state.dispose();
      expect(() => state.dispose()).not.toThrow();
    });
  });

  describe("subscriber pruning on send failure", () => {
    let warnSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      warnSpy?.mockRestore();
    });

    test("throwing subscriber is pruned after first failure; console.warn called once", async () => {
      // Defensively restore any leaked spy from earlier files in the same process.
      const prior = console.warn as unknown as { mockRestore?: () => void };
      prior.mockRestore?.();

      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const before = warnSpy.mock.calls.length; // baseline

      const state = makeState();
      const bad = {
        sendNotification() {
          throw new Error("network gone");
        },
      } as unknown as MessageConnection;
      state.subscribe(bad);

      // 100 mutations — each batch fires broadcast once; subscriber should be
      // pruned on first broadcast so warn is called exactly once.
      for (let i = 0; i < 100; i++) {
        state.addStage({ name: `stage-${i}` });
        await flushAsync();
      }

      expect(state.subscriberCount).toBe(0);
      expect(warnSpy.mock.calls.length - before).toBe(1);
      state.dispose();
    });

    test("bad subscriber pruned; good subscriber still receives notifications", async () => {
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const state = makeState();
      const bad = {
        sendNotification() {
          throw new Error("bad conn");
        },
      } as unknown as MessageConnection;
      const good = fakeConnection();

      state.subscribe(bad);
      state.subscribe(good);

      state.addStage({ name: "resilience-test" });
      await flushAsync();

      const updates = good.notifications.filter((n) => n.method === "panel/update");
      expect(updates.length).toBe(1);
      expect(state.subscriberCount).toBe(1); // only good remains
      state.dispose();
    });
  });

  describe("panel/update version field", () => {
    test("first broadcast has version 1; second has version 2", async () => {
      const state = makeState();
      const conn = fakeConnection();
      state.subscribe(conn);

      // First mutation → first broadcast
      state.addStage({ name: "v-test-1" });
      await flushAsync();

      const first = conn.notifications.filter((n) => n.method === "panel/update");
      expect(first.length).toBe(1);
      expect((first[0]!.params as { version: number }).version).toBe(1);

      // Second mutation → second broadcast
      state.addStage({ name: "v-test-2" });
      await flushAsync();

      const all = conn.notifications.filter((n) => n.method === "panel/update");
      expect(all.length).toBe(2);
      expect((all[1]!.params as { version: number }).version).toBe(2);
      state.dispose();
    });
  });

  describe("schedulePersist stale snapshot fix (Cluster B.2)", () => {
    test("schedulePersist writes latest snapshot when bursts coalesce", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "run-state-persist-test-"));
      try {
        const statusFilePath = join(tmpDir, "status.json");
        const state = makeState({ statusFilePath });

        // First mutation — schedules microtask broadcast; sets latestSnapshot on flush
        state.addStage({ name: "a" });
        await Promise.resolve(); // drain first microtask

        // Second mutation before macrotask fires — schedulePersist early-returns
        // on persistPending but must still update latestSnapshot
        state.addStage({ name: "b" });
        await Promise.resolve(); // drain second microtask

        // Flush macrotasks so the single setTimeout fires with latest snapshot
        await flushAsync();

        const snap = await readSnapshot(tmpDir);
        expect(snap).not.toBeNull();
        const names = snap!.sessions.map((s) => s.name);
        expect(names).toContain("a");
        expect(names).toContain("b");

        state.dispose();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("dispose() clears latestSnapshot reference", () => {
      const state = makeState();
      state.addStage({ name: "x" });
      state.dispose();
      expect((state as unknown as { latestSnapshot: unknown }).latestSnapshot).toBeNull();
    });
  });
});
