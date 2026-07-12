import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";

type SessionStartHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

function checkpointEntry(workflowId: string): SessionEntry {
  return {
    id: `entry-${workflowId}`,
    type: "custom",
    customType: "workflow.durable.checkpoint",
    data: {
      type: "workflow.durable.checkpoint",
      workflowId,
      name: "ralph",
      status: "running",
      completedCheckpoints: 1,
      pendingPrompts: 0,
    },
  };
}

function captureSessionStart(): SessionStartHandler {
  const handlers = new Map<string, SessionStartHandler>();
  const pi: ExtensionAPI = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    on: (event, handler) => handlers.set(event, handler as SessionStartHandler),
    disableAsyncDiscovery: true,
  };
  factory(pi);
  const sessionStart = handlers.get("session_start");
  assert.notEqual(sessionStart, undefined);
  return sessionStart!;
}

async function runSessionStart(
  handler: SessionStartHandler,
  reason: string,
  entries: readonly SessionEntry[],
): Promise<string[]> {
  const notifications: string[] = [];
  await handler({ reason }, {
    sessionManager: { getEntries: () => entries },
    ui: { notify: (message: string) => notifications.push(message) },
  });
  return notifications;
}

afterEach(() => setDurableBackend(undefined));

describe("restored-session resumable workflow notices", () => {
  test("does not advertise a stale cache entry without durable backend state", async () => {
    setDurableBackend(new InMemoryDurableBackend());

    const notifications = await runSessionStart(captureSessionStart(), "startup", [checkpointEntry("stale-run")]);

    assert.equal(notifications.some((message) => message.includes("resumable workflows")), false);
  });

  test("does not advertise cache metadata for authoritative terminal state", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({ workflowId: "done-run", name: "ralph", inputs: {}, createdAt: 1, status: "running" });
    backend.setWorkflowStatus("done-run", "completed");

    const notifications = await runSessionStart(captureSessionStart(), "resume", [checkpointEntry("done-run")]);

    assert.equal(notifications.some((message) => message.includes("resumable workflows")), false);
  });

  test("advertises authoritative resumable state on startup and resume", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({ workflowId: "resumable-run", name: "ralph", inputs: {}, createdAt: 1, status: "running" });
    backend.recordCheckpoint({
      kind: "tool",
      workflowId: "resumable-run",
      checkpointId: "tool:1",
      name: "prepare",
      argsHash: "hash",
      output: "ready",
      completedAt: 2,
    });
    const handler = captureSessionStart();

    for (const reason of ["startup", "resume"] as const) {
      const notifications = await runSessionStart(handler, reason, [checkpointEntry("resumable-run")]);
      const notice = notifications.find((message) => message.includes("resumable workflows"));
      assert.match(notice ?? "", /\/workflow resume resumable-run/);
    }
  });

  test("does not advertise resumable state for unrelated session-start reasons", async () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    backend.registerWorkflow({ workflowId: "resumable-run", name: "ralph", inputs: {}, createdAt: 1, status: "failed" });
    const handler = captureSessionStart();

    for (const reason of ["reload", "new", "fork"] as const) {
      const notifications = await runSessionStart(handler, reason, [checkpointEntry("resumable-run")]);
      assert.equal(notifications.some((message) => message.includes("resumable workflows")), false);
    }
  });
});
