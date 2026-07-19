import { test } from "bun:test";
import assert from "node:assert/strict";
import type net from "node:net";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { handleBrokerSend, type BrokerConnectedSession } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

function session(id: string, name: string, group: string | undefined, socket: net.Socket): BrokerConnectedSession {
  const info: SessionInfo = { id, name, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, group };
  return { socket, info };
}

function message(id: string, text = "hello", extra: Partial<Message> = {}): Message {
  return { id, timestamp: 1, content: { text }, ...extra };
}

interface Harness {
  sessions: Map<string, BrokerConnectedSession>;
  writes: Array<{ socket: net.Socket; message: BrokerMessage }>;
  supervisorCache: SupervisorChannelCache;
  send: (from: net.Socket, msg: Record<string, unknown>, fromId: string) => void;
  sockets: Record<string, net.Socket>;
}

function harness(defs: Array<[id: string, name: string, group: string | undefined]>): Harness {
  const sockets: Record<string, net.Socket> = {};
  const sessions = new Map<string, BrokerConnectedSession>();
  for (const [id, name, group] of defs) {
    const socket = {} as net.Socket;
    sockets[id] = socket;
    sessions.set(id, session(id, name, group, socket));
  }
  const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
  const supervisorCache = new SupervisorChannelCache();
  const cache = new DeliveredMessageCache();
  return {
    sessions,
    writes,
    supervisorCache,
    sockets,
    send: (from, msg, fromId) =>
      handleBrokerSend(from, msg as never, fromId, sessions, cache, (socket, value) => writes.push({ socket, message: value }), supervisorCache),
  };
}

function failureReason(h: Harness): string {
  const failure = h.writes.map((w) => w.message).find((m): m is Extract<BrokerMessage, { type: "delivery_failed" }> => m.type === "delivery_failed");
  return failure?.reason ?? "";
}
test("same-group send is delivered", () => {
  const h = harness([["a", "alice", "teamA"], ["b", "bob", "teamA"]]);
  h.send(h.sockets.a!, { type: "send", to: "bob", message: message("m1") }, "a");
  assert.equal(h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"), true);
  assert.equal(h.writes.some((w) => w.socket === h.sockets.a && w.message.type === "delivered"), true);
});

test("cross-group send by name is unresolvable (filtered resolution)", () => {
  const h = harness([["a", "alice", "teamA"], ["b", "bob", "teamB"]]);
  h.send(h.sockets.a!, { type: "send", to: "bob", message: message("m1") }, "a");
  assert.equal(h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"), false);
  assert.equal(h.writes.some((w) => w.message.type === "delivery_failed"), true);
  assert.match(failureReason(h), /not found/i);
});

test("cross-group send by exact id is rejected via defense-in-depth", () => {
  const h = harness([["a", "alice", "teamA"], ["b", "bob", "teamB"]]);
  h.send(h.sockets.a!, { type: "send", to: "b", message: message("m1") }, "a");
  assert.equal(h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"), false);
  assert.equal(h.writes.some((w) => w.message.type === "delivery_failed"), true);
  assert.match(failureReason(h), /different intercom group/i);
});

test("ungrouped sessions share the default group and can message each other", () => {
  const h = harness([["a", "alice", undefined], ["b", "bob", undefined]]);
  h.send(h.sockets.a!, { type: "send", to: "bob", message: message("m1") }, "a");
  assert.equal(h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"), true);
});

test("supervisor channel bypasses group isolation and records a crossing for the reply", () => {
  const h = harness([["child", "child", "teamA"], ["sup", "supervisor", "default"]]);
  // child -> supervisor via supervisor channel (cross-group) is delivered
  h.send(h.sockets.child!, { type: "send", to: "sup", message: message("q1", "need decision", { expectsReply: true }), channel: "supervisor" }, "child");
  const supervisorDelivery = h.writes.find((w) => w.socket === h.sockets.sup && w.message.type === "message");
  assert.equal(supervisorDelivery?.message.type, "message");
  assert.equal((supervisorDelivery?.message as { channel?: string } | undefined)?.channel, "supervisor");

  // supervisor replies to the recorded crossing (replyTo=q1) back to the child -> delivered
  h.send(h.sockets.sup!, { type: "send", to: "child", message: message("r1", "approved", { replyTo: "q1" }) }, "sup");
  assert.equal(h.writes.some((w) => w.socket === h.sockets.child && w.message.type === "message"), true);
});

test("a fabricated replyTo cannot bypass isolation to another group", () => {
  const h = harness([["a", "alice", "teamA"], ["b", "bob", "teamB"]]);
  // no recorded crossing exists; a peer forges a replyTo to reach teamB by exact id
  h.send(h.sockets.a!, { type: "send", to: "b", message: message("m1", "sneaky", { replyTo: "does-not-exist" }) }, "a");
  assert.equal(h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"), false);
  assert.match(failureReason(h), /different intercom group/i);
});
