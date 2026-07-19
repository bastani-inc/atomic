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

test("isVerticalBypass honors the supervisor marker and recorded-crossing replies only", () => {
  const cache = new SupervisorChannelCache();
  const sender = info("child", "teamA");
  const supervisor = info("supervisor", "default");

  // marker path
  assert.equal(isVerticalBypass({ channel: "supervisor", sender, target: supervisor, supervisorCache: cache }), true);

  // reply path requires a recorded crossing
  assert.equal(
    isVerticalBypass({ replyTo: "x", sender: supervisor, target: sender, supervisorCache: cache }),
    false,
  );
  cache.record("x", "child", "supervisor");
  assert.equal(
    isVerticalBypass({ replyTo: "x", sender: supervisor, target: sender, supervisorCache: cache }),
    true,
  );

  // ordinary peer send (no channel, no replyTo) is never a bypass
  assert.equal(isVerticalBypass({ sender, target: supervisor, supervisorCache: cache }), false);
});
