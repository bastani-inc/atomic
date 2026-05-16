import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  chatEntriesFromAgentMessages,
  LiveChatEntriesController,
  ScrollableComponentViewport,
} from "../../packages/coding-agent/src/modes/interactive/components/index.js";

describe("chat message renderer utilities", () => {
  test("pairs assistant tool calls with later tool results while preserving args", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo hi" } }],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "bash",
        content: [{ type: "text", text: "hi\n" }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const entries = chatEntriesFromAgentMessages(messages);
    const toolEntry = entries.find((entry) => entry.kind === "tool");

    assert.equal(toolEntry?.kind, "tool");
    assert.deepEqual(toolEntry.args, { command: "echo hi" });
    assert.equal(toolEntry.result?.content[0]?.type, "text");
    assert.equal(toolEntry.result?.isError, false);
  });

  test("live chat controller accumulates assistant deltas and tool results", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);

    assert.equal(live.applyEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
      message: { role: "assistant", content: [] },
    }), true);
    assert.equal(live.applyEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
      message: { role: "assistant", content: [] },
    }), true);
    assert.equal(entries[0]?.kind, "assistant");
    assert.equal(entries[0]?.kind === "assistant" ? entries[0].message.content[0]?.type : undefined, "text");
    assert.equal(
      entries[0]?.kind === "assistant" && entries[0].message.content[0]?.type === "text"
        ? entries[0].message.content[0].text
        : undefined,
      "hello",
    );

    live.applyEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    assert.deepEqual(live.pendingToolIds(), ["t1"]);
    live.applyEvent({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    const toolEntry = entries.find((entry) => entry.kind === "tool");
    assert.equal(toolEntry?.kind, "tool");
    assert.equal(toolEntry.result?.isError, false);
    assert.deepEqual(live.pendingToolIds(), []);
  });

  test("scrollable viewport defaults to sticky bottom and handles PageUp/PageDown", () => {
    const viewport = new ScrollableComponentViewport();
    viewport.setVisibleRows(3);
    viewport.setComponents([
      {
        render: () => ["line-0", "line-1", "line-2", "line-3", "line-4"],
        invalidate: () => {},
      },
    ]);

    assert.deepEqual(viewport.render(20), ["line-2", "line-3", "line-4"]);
    assert.equal(viewport.handleInput("\x1b[5~"), true);
    assert.deepEqual(viewport.render(20), ["line-0", "line-1", "line-2"]);
    assert.equal(viewport.handleInput("\x1b[6~"), true);
    assert.deepEqual(viewport.render(20), ["line-2", "line-3", "line-4"]);
  });
});
