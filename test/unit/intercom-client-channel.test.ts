import { test } from "bun:test";
import assert from "node:assert/strict";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

test("client preserves the supervisor channel on inbound broker messages", () => {
  const client = new IntercomClient();
  const internals = client as unknown as {
    _sessionId: string;
    handleBrokerMessage(message: unknown): void;
  };
  internals._sessionId = "parent";
  const from: SessionInfo = {
    id: "child",
    name: "reviewer",
    cwd: "/repo",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    group: "reviewers",
  };
  const message: Message = { id: "update-1", timestamp: 1, content: { text: "progress" } };
  let receivedChannel: string | undefined;
  client.on("message", (_from: SessionInfo, _message: Message, channel?: string) => {
    receivedChannel = channel;
  });

  internals.handleBrokerMessage({ type: "message", from, message, channel: "supervisor" });

  assert.equal(receivedChannel, "supervisor");
});
