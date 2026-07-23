import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { registerIntercomLifecycle } from "../../packages/intercom/lifecycle.js";
import { InboundIdleQueue } from "../../packages/intercom/inbound-idle-queue.js";

interface TestContext { sessionManager: { getSessionId(): string }; model: { id: string } }
type Handler = (event: Record<string, never>, ctx: TestContext) => void | Promise<void>;

function fixture(disconnectRejects = false) {
  const handlers = new Map<string, Handler>();
  const clients: Array<{ id: string; disconnects: number; disconnect(): Promise<void> }> = [];
  let client: (typeof clients)[number] | null = null;
  let generation = 0;
  let live = false;
  let sessionId: string | null = null;
  const pending = new InboundIdleQueue();
  const activeTools = new Map([["old-tool", "intercom"]]);
  const rejected: string[] = [];
  let sessionEnvRestores = 0;
  const inboundFlushDelays: Array<number | undefined> = [];
  const pi = { on(name: string, handler: Handler) { handlers.set(name, handler); } };
  const deps = {
    config: { enabled: true }, client: () => client, setClient: (value: typeof client) => { client = value; },
    setShuttingDown(value: boolean) { if (value) live = false; }, setDisposed(value: boolean) { if (value) live = false; },
    setRuntimeStarted(value: boolean) { live = value; }, incrementRuntimeGeneration: () => ++generation,
    resetReconnectAttempt() {}, clearReconnectTimer() {},
    setRuntimeContext() {}, setCurrentSessionId(id: string | null) { sessionId = id; }, setCurrentModel() {},
    setSessionStartedAt() {}, setAgentRunning() {}, activeTools,
    getLiveContext: (_ctx?: object, expected = generation) => live && expected === generation ? ({} as never) : null,
    scheduleReconnect() {}, rejectReplyWaiter(error: Error) { rejected.push(error.message); },
    replyTracker: { reset() {}, endTurn() {}, beginTurn() {} }, pendingIdleMessages: pending,
    clearInboundFlushTimer() {}, scheduleInboundFlush(delayMs?: number) { inboundFlushDelays.push(delayMs); }, syncPresenceStatus() {}, syncPresenceIdentity() {}, currentStatus: () => "idle",
    restoreIntercomSessionIdEnv() { sessionEnvRestores++; },
  };
  registerIntercomLifecycle(pi as never, deps as never);
  const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id }, model: { id: "model" } });
  const connect = async () => {
    const next = { id: sessionId ?? "missing", disconnects: 0, async disconnect() { this.disconnects++; if (disconnectRejects) throw new Error("disconnect failed"); } };
    clients.push(next); client = next; return next;
  };
  return { handlers, clients, pending, activeTools, rejected, inboundFlushDelays, ctx, connect, get client() { return client; }, get sessionEnvRestores() { return sessionEnvRestores; } };
}

async function emit(current: ReturnType<typeof fixture>, name: string, ctx: TestContext): Promise<void> {
  await current.handlers.get(name)?.({}, ctx);
  await Bun.sleep(1);
}

describe("intercom lifecycle replacement", () => {
  test("disconnects and clears old runtime without reconnecting the replacement", async () => {
    const current = fixture();
    await emit(current, "session_start", current.ctx("A"));
    assert.equal(current.clients.length, 0);
    const first = await current.connect();
    current.pending.enqueue({ message: { id: "queued", timestamp: 1, content: { text: "queued" } } } as never);
    current.activeTools.set("stale", "subagent");
    await emit(current, "session_start", current.ctx("B"));
    assert.equal(first.disconnects, 1);
    assert.equal(current.client, null);
    assert.equal(current.clients.length, 1);
    assert.equal(current.pending.size, 0);
    assert.equal(current.activeTools.size, 0);
    assert.ok(current.rejected.includes("Session replaced"));
    assert.equal(current.sessionEnvRestores, 1);
  });

  test("disconnect failure is diagnosed without reconnecting the replacement", async () => {
    const current = fixture(true);
    await emit(current, "session_start", current.ctx("A"));
    await current.connect();
    await emit(current, "session_start", current.ctx("B"));
    assert.equal(current.client, null);
    assert.equal(current.clients.length, 1);
    assert.equal(current.sessionEnvRestores, 1);
  });
  test("idle lifecycle keeps the normal flush grace period for terminal barriers", async () => {
    const current = fixture();
    await emit(current, "session_start", current.ctx("A"));

    await emit(current, "turn_end", current.ctx("A"));
    await emit(current, "agent_end", current.ctx("A"));

    assert.deepEqual(current.inboundFlushDelays, [undefined, undefined]);
  });
});
