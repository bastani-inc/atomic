import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildSendSignature,
  PendingSendRegistry,
} from "../../packages/intercom/broker/pending-send-registry.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { buildSubagentMessageSource } from "../../packages/intercom/source-ownership.js";

const signature = (to = "session-a", text = "hello") => buildSendSignature(to, { text });

describe("PendingSendRegistry", () => {
  test("coalesces identical concurrent sends onto the same promise", async () => {
    const registry = new PendingSendRegistry();
    const first = registry.acquire("message-1", signature(), 1_000);
    const second = registry.acquire("message-1", signature(), 1_000);

    assert.equal(first.owner, true);
    assert.equal(second.owner, false);
    assert.equal(second.attempt, first.attempt);
    assert.equal(second.attempt.promise, first.attempt.promise);

    assert.equal(registry.resolve("message-1", first.attempt.attemptId, {
      id: "message-1",
      delivered: true,
    }), true);
    assert.deepEqual(await second.attempt.promise, { id: "message-1", delivered: true });
  });

  test("rejects reuse of a pending explicit ID for a different logical send", async () => {
    const registry = new PendingSendRegistry();
    const first = registry.acquire("message-1", signature(), 1_000);

    assert.throws(
      () => registry.acquire("message-1", signature("session-b"), 1_000),
      /already pending with a different target or payload/,
    );
    assert.throws(
      () => registry.acquire("message-1", signature("session-a", "different"), 1_000),
      /already pending with a different target or payload/,
    );
    assert.throws(
      () => registry.acquire("message-1", buildSendSignature("session-a", { text: "hello", expectsReply: true }), 1_000),
      /already pending with a different target or payload/,
    );

    registry.reject(first.attempt, new Error("test cleanup"));
    await assert.rejects(first.attempt.promise, /test cleanup/);
  });

  test("an old attempt cannot delete or settle a newer owner", async () => {
    const registry = new PendingSendRegistry();
    const old = registry.acquire("message-1", signature(), 1_000);
    registry.reject(old.attempt, new Error("old attempt ended"));
    await assert.rejects(old.attempt.promise, /old attempt ended/);

    const current = registry.acquire("message-1", signature(), 1_000);
    assert.equal(registry.reject(old.attempt, new Error("late old cleanup")), false);
    assert.equal(registry.resolve("message-1", old.attempt.attemptId, {
      id: "message-1",
      delivered: true,
    }), false);

    assert.equal(registry.resolve("message-1", current.attempt.attemptId, {
      id: "message-1",
      delivered: true,
    }), true);
    assert.deepEqual(await current.attempt.promise, { id: "message-1", delivered: true });
  });

  test("timeout cleanup is attempt-safe when an ID is reused", async () => {
    const registry = new PendingSendRegistry();
    const expired = registry.acquire("message-1", signature(), 5);
    await assert.rejects(expired.attempt.promise, /Send timeout/);

    const current = registry.acquire("message-1", signature(), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(registry.resolveLegacy("message-1", { id: "message-1", delivered: true }), false, "a late legacy timeout response is ambiguous");
    assert.equal(registry.resolve("message-1", expired.attempt.attemptId, {
      id: "message-1",
      delivered: true,
    }), false);
    assert.equal(registry.resolve("message-1", current.attempt.attemptId, {
      id: "message-1",
      delivered: true,
    }), true);
    await current.attempt.promise;
  });

  test("disconnect cleanup cannot reject a later replacement", async () => {
    const registry = new PendingSendRegistry();
    const disconnected = registry.acquire("message-1", signature(), 1_000);
    registry.rejectAll(new Error("Client disconnected"));
    await assert.rejects(disconnected.attempt.promise, /Client disconnected/);

    const replacement = registry.acquire("message-1", signature(), 1_000);
    assert.equal(registry.reject(disconnected.attempt, new Error("late disconnect")), false);
    assert.equal(registry.resolveLegacy("message-1", { id: "message-1", delivered: false, reason: "late disconnect response" }), false);
    registry.resolve("message-1", replacement.attempt.attemptId, {
      id: "message-1",
      delivered: true,
    });
    await replacement.attempt.promise;
  });

  test("resolves a legacy response only for the exact active message ID", async () => {
    const registry = new PendingSendRegistry();
    const active = registry.acquire("message-1", signature(), 1_000);
    assert.equal(registry.resolveLegacy("stale-id", { id: "stale-id", delivered: true }), false);
    assert.equal(registry.resolveLegacy("message-1", { id: "message-1", delivered: true }), true);
    assert.deepEqual(await active.attempt.promise, { id: "message-1", delivered: true });
  });

  test("ignores late legacy delivered and delivery_failed responses after ID replacement", async () => {
    for (const delivered of [true, false]) {
      const registry = new PendingSendRegistry();
      const original = registry.acquire(`reused-${delivered}`, signature(), 1_000);
      registry.reject(original.attempt, new Error("replace"));
      await assert.rejects(original.attempt.promise, /replace/);
      const replacement = registry.acquire(`reused-${delivered}`, signature(), 1_000);
      assert.equal(registry.resolveLegacy(replacement.attempt.messageId, {
        id: replacement.attempt.messageId,
        delivered,
        ...(delivered ? {} : { reason: "late failure" }),
      }), false);
      assert.equal(registry.resolve(replacement.attempt.messageId, replacement.attempt.attemptId, {
        id: replacement.attempt.messageId,
        delivered: true,
      }), true);
      assert.equal((await replacement.attempt.promise).delivered, true);
    }
  });

  test("legacy eligibility expires and generation history remains bounded", async () => {
    let now = 0;
    const registry = new PendingSendRegistry(100, 2, () => now);
    const retire = async (id: string) => {
      const acquired = registry.acquire(id, signature(), 1_000);
      registry.reject(acquired.attempt, new Error("retire"));
      await assert.rejects(acquired.attempt.promise, /retire/);
    };
    await retire("oldest");
    await retire("middle");
    await retire("newest");
    const evicted = registry.acquire("oldest", signature(), 1_000);
    assert.equal(registry.resolveLegacy("oldest", { id: "oldest", delivered: true }), true, "evicted history may safely start a new compatibility window");
    await evicted.attempt.promise;

    await retire("expires");
    now = 101;
    const expired = registry.acquire("expires", signature(), 1_000);
    assert.equal(registry.resolveLegacy("expires", { id: "expires", delivered: false, reason: "legacy failure" }), true);
    assert.deepEqual(await expired.attempt.promise, { id: "expires", delivered: false, reason: "legacy failure" });
  });

  test("generation retention starts at settlement for long-running original attempts", async () => {
    let now = 0;
    const registry = new PendingSendRegistry(100, 10, () => now);
    const original = registry.acquire("long-running", signature(), 1_000);
    now = 1_000;
    registry.reject(original.attempt, new Error("settled late"));
    await assert.rejects(original.attempt.promise, /settled late/);
    const replacement = registry.acquire("long-running", signature(), 1_000);
    assert.equal(registry.resolveLegacy("long-running", { id: "long-running", delivered: true }), false);
    assert.equal(registry.resolve("long-running", replacement.attempt.attemptId, { id: "long-running", delivered: true }), true);
    await replacement.attempt.promise;
  });

});
function makeConnectedClient(): {
  client: IntercomClient;
  writes: Buffer[];
  setWriteFailure(fail: boolean): void;
  deliver(index?: number, legacy?: boolean): void;
  fail(index?: number, legacy?: boolean): void;
} {
  const writes: Buffer[] = [];
  let failWrites = false;
  const client = new IntercomClient();
  const internals = client as unknown as {
    socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
    _sessionId: string;
    handleBrokerMessage(message: unknown): void;
  };
  internals.socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(data) {
      if (failWrites) throw new Error("wire write failed");
      writes.push(data);
      return true;
    },
  };
  internals._sessionId = "sender";
  return {
    client,
    setWriteFailure(fail) {
      failWrites = fail;
    },
    writes,
    deliver(index = 0, legacy = false) {
      const frame = writes[index];
      assert.ok(frame);
      const payload = JSON.parse(frame.subarray(4).toString("utf-8")) as {
        message: { id: string };
        attemptId: string;
      };
      internals.handleBrokerMessage({
        type: "delivered",
        messageId: payload.message.id,
        ...(legacy ? {} : { attemptId: payload.attemptId }),
      });
    },
    fail(index = 0, legacy = false) {
      const frame = writes[index];
      assert.ok(frame);
      const payload = JSON.parse(frame.subarray(4).toString("utf-8")) as { message: { id: string }; attemptId: string };
      internals.handleBrokerMessage({
        type: "delivery_failed",
        messageId: payload.message.id,
        reason: "legacy failure",
        ...(legacy ? {} : { attemptId: payload.attemptId }),
      });
    },
  };
}

describe("IntercomClient.send", () => {
  test("coalesces identical explicit-ID sends into one wire write and promise", async () => {
    const { client, writes, deliver } = makeConnectedClient();
    const first = client.send("recipient", { text: "hello", messageId: "stable-id" });
    const second = client.send("recipient", { text: "hello", messageId: "stable-id" });

    assert.equal(first, second);
    assert.equal(writes.length, 1);
    deliver();
    assert.deepEqual(await first, { id: "stable-id", delivered: true });
  });

  test("rejects conflicting explicit-ID reuse without another wire write", async () => {
    const { client, writes, deliver } = makeConnectedClient();
    const first = client.send("recipient", { text: "hello", messageId: "stable-id" });
    const conflicting = client.send("other-recipient", { text: "hello", messageId: "stable-id" });

    await assert.rejects(conflicting, /different target or payload/);
    assert.equal(writes.length, 1);
    deliver();
    await first;
  });

  test("a synchronous write failure releases only its own attempt", async () => {
    const { client, writes, deliver, setWriteFailure } = makeConnectedClient();
    setWriteFailure(true);
    const failed = client.send("recipient", { text: "hello", messageId: "stable-id" });
    await assert.rejects(failed, /wire write failed/);

    setWriteFailure(false);
    const replacement = client.send("recipient", { text: "hello", messageId: "stable-id" });
    assert.equal(writes.length, 1);
    deliver();
    assert.deepEqual(await replacement, { id: "stable-id", delivered: true });
  });

  test("accepts a delivered response from an already-running legacy broker", async () => {
    const { client, writes, deliver } = makeConnectedClient();
    const pending = client.send("recipient", { text: "hello", messageId: "stable-id" });
    assert.equal(writes.length, 1);
    deliver(0, true);
    assert.deepEqual(await pending, { id: "stable-id", delivered: true });
  });

  test("accepts a delivery_failed response from an already-running legacy broker", async () => {
    const { client, fail } = makeConnectedClient();
    const pending = client.send("recipient", { text: "hello", messageId: "stable-failure" });
    fail(0, true);
    assert.deepEqual(await pending, { id: "stable-failure", delivered: false, reason: "legacy failure" });
  });

  test("builds exact subagent run ownership for broker messages", () => {
    assert.deepEqual(buildSubagentMessageSource(" run-source ", "worker", "2"), {
      subagentRunId: "run-source",
      subagentAgent: "worker",
      subagentIndex: 2,
    });
    assert.equal(buildSubagentMessageSource(undefined, "worker", "2"), undefined);
  });
});
