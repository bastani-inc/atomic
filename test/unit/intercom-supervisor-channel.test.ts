import { test } from "bun:test";
import assert from "node:assert/strict";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { isVerticalBypass, sameGroup } from "../../packages/intercom/broker/group-isolation.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

function info(id: string, group?: string): SessionInfo {
  return { id, name: id, cwd: "/tmp", model: "m", pid: 1, startedAt: 1, lastActivity: 1, group };
}

test("sameGroup treats undefined and 'default' as equal, distinct names as different", () => {
  assert.equal(sameGroup(info("a"), info("b")), true);
  assert.equal(sameGroup(info("a", "default"), info("b")), true);
  assert.equal(sameGroup(info("a", "teamA"), info("b", "teamA")), true);
  assert.equal(sameGroup(info("a", "teamA"), info("b", "teamB")), false);
});

test("matchReply only matches a recorded crossing in the exact opposite direction", () => {
  const cache = new SupervisorChannelCache();
  cache.record("msg-1", "child", "supervisor");
  // supervisor(sender) replying to child(target) referencing msg-1 → allowed
  assert.equal(cache.matchReply("msg-1", "supervisor", "child"), true);
  // wrong direction (child replying) → not allowed
  assert.equal(cache.matchReply("msg-1", "child", "supervisor"), false);
  // unknown replyTo → not allowed
  assert.equal(cache.matchReply("unknown", "supervisor", "child"), false);
});

test("matchReply expires entries past the TTL", () => {
  const cache = new SupervisorChannelCache(1000, 10);
  cache.record("msg-1", "child", "supervisor", 0);
  assert.equal(cache.matchReply("msg-1", "supervisor", "child", 500), true);
  assert.equal(cache.matchReply("msg-1", "supervisor", "child", 2000), false);
});

test("broker capabilities bind one exact child to one supervisor and support reconnects", () => {
  const cache = new SupervisorChannelCache();
  assert.equal(cache.claim("not-issued", "child"), undefined);

  const capability = cache.authorize("supervisor", "owner-secret", "child");
  assert.equal(cache.claim(capability, "other-child"), undefined);
  assert.equal(cache.claim(capability, "child"), "supervisor");
  cache.authorize("supervisor-reconnected", "owner-secret", "child", capability);
  assert.equal(cache.claim(capability, "child"), "supervisor-reconnected");
  assert.throws(
    () => cache.authorize("other-supervisor", "attacker-secret", "child", capability),
    /invalid supervisor capability owner/i,
  );
});

test("dynamic child slots accept child names but remain fixed to the issuing supervisor", () => {
  const cache = new SupervisorChannelCache();
  const capability = cache.authorize("supervisor", "owner-secret", "*");
  assert.equal(cache.claim(capability, "dynamic-child"), "supervisor");
  assert.equal(cache.claim(capability, "another-child"), undefined);
  assert.equal(cache.claim(capability, "dynamic-child"), "supervisor", "the bound dynamic child may reconnect");
  assert.throws(
    () => cache.authorize("other-supervisor", "attacker-secret", "*", capability),
    /invalid supervisor capability owner/i,
  );
});


test("isVerticalBypass only honors exact recorded-crossing replies", () => {
  const cache = new SupervisorChannelCache();
  const sender = info("child", "teamA");
  const supervisor = info("supervisor", "default");

  assert.equal(isVerticalBypass({ replyTo: "x", sender: supervisor, target: sender, supervisorCache: cache }), false);
  cache.record("x", "child", "supervisor");
  assert.equal(isVerticalBypass({ replyTo: "x", sender: supervisor, target: sender, supervisorCache: cache }), true);
  assert.equal(isVerticalBypass({ sender, target: supervisor, supervisorCache: cache }), false);
});
