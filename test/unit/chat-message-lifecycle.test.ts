import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  chatEntriesFromAgentMessages,
  LiveChatEntriesController,
} from "../../packages/coding-agent/src/modes/interactive/components/index.ts";

function liveChat() {
  const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
  return { entries, live: new LiveChatEntriesController(entries) };
}

test("empty workflow follow-up reports orphaned tool settlement", () => {
  const { entries, live } = liveChat();
  live.applyEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "orphaned-tool", name: "read", arguments: {} }],
    },
  });
  live.applyEvent({ type: "message_end", message: undefined });

  const changed = live.applyEvent({
    type: "message_update",
    message: { role: "assistant", content: [] },
  });

  const tool = entries.find((entry) => entry.kind === "tool");
  assert.equal(changed, true);
  assert.equal(tool?.kind === "tool" ? tool.isPartial : undefined, false);
  assert.deepEqual(tool?.kind === "tool" ? tool.result?.content : undefined, []);
  assert.equal(tool?.kind === "tool" ? tool.result?.isError : undefined, true);
});

test("clearing workflow tool ownership fences late execution traffic", () => {
  const { entries, live } = liveChat();
  live.applyEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "cleared-tool", name: "read", arguments: {} }],
    },
  });
  live.clearPendingTools();

  assert.equal(live.applyEvent({
    type: "tool_execution_start",
    toolCallId: "cleared-tool",
    toolName: "read",
    args: {},
  }), false);
  assert.equal(live.applyEvent({
    type: "tool_execution_update",
    toolCallId: "cleared-tool",
    partialResult: { content: [{ type: "text", text: "LATE_CLEAR_UPDATE" }] },
  }), false);
  assert.equal(live.applyEvent({
    type: "tool_execution_end",
    toolCallId: "cleared-tool",
    result: { content: [{ type: "text", text: "LATE_CLEAR_END" }] },
    isError: false,
  }), false);
  const settledTool = entries.find((entry) => entry.kind === "tool");
  assert.equal(settledTool?.kind === "tool" ? settledTool.isPartial : undefined, false);
  assert.deepEqual(settledTool?.kind === "tool" ? settledTool.result?.content : undefined, []);
  assert.equal(settledTool?.kind === "tool" ? settledTool.result?.isError : undefined, true);
  assert.deepEqual(live.pendingToolIds(), []);
});

test("clearing after a malformed end retires orphaned workflow tools", () => {
  const { entries, live } = liveChat();
  live.applyEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "orphan-on-clear", name: "read", arguments: {} }],
    },
  });
  live.applyEvent({ type: "message_end", message: undefined });
  live.clearPendingTools();

  assert.equal(live.applyEvent({
    type: "tool_execution_start",
    toolCallId: "orphan-on-clear",
    toolName: "read",
    args: {},
  }), false);
  assert.equal(live.applyEvent({
    type: "tool_execution_end",
    toolCallId: "orphan-on-clear",
    result: { content: [{ type: "text", text: "LATE_ORPHAN_END" }] },
    isError: false,
  }), false);
  const settledTool = entries.find((entry) => entry.kind === "tool");
  assert.equal(entries.filter((entry) => entry.kind === "tool").length, 1);
  assert.equal(settledTool?.kind === "tool" ? settledTool.isPartial : undefined, false);
  assert.deepEqual(settledTool?.kind === "tool" ? settledTool.result?.content : undefined, []);
  assert.equal(settledTool?.kind === "tool" ? settledTool.result?.isError : undefined, true);
});

test("non-assistant traffic cannot reindex a retired workflow tool", () => {
  const { live } = liveChat();
  live.applyEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "retired-tool", name: "read", arguments: {} }],
    },
  });
  live.clearPendingTools();
  live.applyEvent({
    type: "message_start",
    message: { role: "user", content: "workflow boundary", timestamp: 1 },
  });

  assert.equal(live.applyEvent({
    type: "tool_execution_update",
    toolCallId: "retired-tool",
    partialResult: { content: [{ type: "text", text: "REINDEXED_LATE_OUTPUT" }] },
  }), false);
  assert.deepEqual(live.pendingToolIds(), []);
});

test("orphan settlement does not suppress the follow-up text delta", () => {
  const { entries, live } = liveChat();
  live.applyEvent({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "prior-tool", name: "read", arguments: {} }],
    },
  });
  live.applyEvent({ type: "message_end", message: undefined });

  assert.equal(live.applyEvent({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", delta: "follow-up delta" },
  }), true);
  const assistantEntries = entries.filter((entry) => entry.kind === "assistant");
  assert.deepEqual(assistantEntries.at(-1)?.message.content, [
    { type: "text", text: "follow-up delta" },
  ]);
});
