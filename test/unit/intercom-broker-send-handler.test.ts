import { test } from "bun:test";
import assert from "node:assert/strict";
import type net from "node:net";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { handleBrokerSend, type BrokerConnectedSession } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

function session(id: string, name: string, socket: net.Socket): BrokerConnectedSession {
  const info: SessionInfo = {
    id, name, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1,
  };
  return { socket, info };
}

function message(id: string, text = "hello"): Message {
  return { id, timestamp: 1, content: { text } };
}

test("broker wire send dedupes identical retries, rejects conflicts, and preserves attempt IDs across sender replacement", () => {
  const senderOne = {} as net.Socket;
  const senderTwo = {} as net.Socket;
  const recipient = {} as net.Socket;
  const other = {} as net.Socket;
  const sessions = new Map<string, BrokerConnectedSession>([
    ["sender-1", session("sender-1", "sender", senderOne)],
    ["recipient", session("recipient", "recipient", recipient)],
    ["other", session("other", "other", other)],
  ]);
  const cache = new DeliveredMessageCache();
  const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
  const write = (socket: net.Socket, value: BrokerMessage) => writes.push({ socket, message: value });

  handleBrokerSend(senderOne, { type: "send", to: "recipient", message: message("stable"), attemptId: "attempt-1" }, "sender-1", sessions, cache, write);
  handleBrokerSend(senderOne, { type: "send", to: "recipient", message: message("stable"), attemptId: "attempt-2" }, "sender-1", sessions, cache, write);
  assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1);
  assert.deepEqual(writes.flatMap((entry) => entry.socket === senderOne && entry.message.type === "delivered" ? [entry.message.attemptId] : []), ["attempt-1", "attempt-2"]);

  handleBrokerSend(senderOne, { type: "send", to: "recipient", message: message("stable", "changed"), attemptId: "attempt-3" }, "sender-1", sessions, cache, write);
  handleBrokerSend(senderOne, { type: "send", to: "other", message: message("stable"), attemptId: "attempt-4" }, "sender-1", sessions, cache, write);
  const conflicts = writes.filter((entry) => entry.socket === senderOne && entry.message.type === "delivery_failed");
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.flatMap((entry) => entry.message.type === "delivery_failed" ? [entry.message.attemptId] : []), ["attempt-3", "attempt-4"]);
  assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1);
  assert.equal(writes.filter((entry) => entry.socket === other && entry.message.type === "message").length, 0);

  sessions.delete("sender-1");
  sessions.set("sender-2", session("sender-2", "sender", senderTwo));
  handleBrokerSend(senderTwo, { type: "send", to: "recipient", message: message("stable"), attemptId: "attempt-5" }, "sender-2", sessions, cache, write);
  assert.equal(writes.filter((entry) => entry.socket === senderTwo && entry.message.type === "delivered" && entry.message.attemptId === "attempt-5").length, 1);
  assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1, "replacement sender receives cached acknowledgement without replay");
});

test("broker wire send keeps absent attemptId compatibility but rejects malformed present values", () => {
  const sender = {} as net.Socket;
  const recipient = {} as net.Socket;
  const sessions = new Map<string, BrokerConnectedSession>([
    ["sender", session("sender", "sender", sender)],
    ["recipient", session("recipient", "recipient", recipient)],
  ]);
  const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
  const write = (socket: net.Socket, value: BrokerMessage) => writes.push({ socket, message: value });
  const cache = new DeliveredMessageCache();

  handleBrokerSend(sender, { type: "send", to: "recipient", message: message("legacy-ok") }, "sender", sessions, cache, write);
  const legacyAck = writes.find((entry) => entry.socket === sender && entry.message.type === "delivered")?.message;
  assert.equal(legacyAck?.type, "delivered");
  assert.equal(legacyAck?.attemptId, undefined);
  assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1);

  handleBrokerSend(sender, { type: "send", to: "missing", message: message("legacy-failed") }, "sender", sessions, cache, write);
  const legacyFailure = writes.find((entry) => entry.message.type === "delivery_failed" && entry.message.messageId === "legacy-failed")?.message;
  assert.equal(legacyFailure?.type, "delivery_failed");
  assert.equal(legacyFailure?.attemptId, undefined);

  handleBrokerSend(sender, { type: "send", to: "recipient", message: message("bad-attempt"), attemptId: 42 }, "sender", sessions, cache, write);
  const malformed = writes.find((entry) => entry.message.type === "delivery_failed" && entry.message.messageId === "bad-attempt")?.message;
  assert.equal(malformed?.type, "delivery_failed");
  assert.match(malformed?.reason ?? "", /attemptId/);
  assert.equal(writes.filter((entry) => entry.socket === recipient && entry.message.type === "message").length, 1, "malformed attemptId must not downgrade and forward");
});

test("broker routes the session ID exactly as displayed by intercom list", () => {
  const sender = {} as net.Socket;
  const recipient = {} as net.Socket;
  const recipientId = "aa56071e-1111-4222-8333-123456789abc";
  const sessions = new Map<string, BrokerConnectedSession>([
    ["sender", session("sender", "sender", sender)],
    [recipientId, session(recipientId, "recipient", recipient)],
  ]);
  const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];

  handleBrokerSend(
    sender,
    { type: "send", to: recipientId.slice(0, 8), message: message("displayed-id") },
    "sender",
    sessions,
    new DeliveredMessageCache(),
    (socket, value) => writes.push({ socket, message: value }),
  );

  assert.equal(
    writes.some((entry) => entry.socket === recipient && entry.message.type === "message"),
    true,
  );
  assert.equal(
    writes.some((entry) => entry.socket === sender && entry.message.type === "delivered"),
    true,
  );
});

test("broker never routes a short session ID back to its sender", () => {
  const sender = {} as net.Socket;
  const senderId = "aa56071e-1111-4222-8333-123456789abc";
  const sessions = new Map<string, BrokerConnectedSession>([
    [senderId, session(senderId, "sender", sender)],
  ]);
  const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];

  handleBrokerSend(
    sender,
    { type: "send", to: senderId.slice(0, 8), message: message("self-target") },
    senderId,
    sessions,
    new DeliveredMessageCache(),
    (socket, value) => writes.push({ socket, message: value }),
  );

  assert.equal(writes.some((entry) => entry.message.type === "message"), false);
  const failure = writes.find((entry) => entry.message.type === "delivery_failed")?.message;
  assert.equal(failure?.type, "delivery_failed");
  assert.match(failure?.reason ?? "", /current session/i);
});
