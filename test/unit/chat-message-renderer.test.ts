import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ChatTranscriptComponent,
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

  test("renders distinct rows and output for parallel same-name tool calls (live events)", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);

    // A single assistant snapshot announcing TWO parallel `read` tool calls.
    live.applyEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "A", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "B", name: "read", arguments: { path: "b.ts" } },
        ],
      },
    });

    live.applyEvent({ type: "tool_execution_start", toolCallId: "A", toolName: "read", args: { path: "a.ts" } });
    live.applyEvent({ type: "tool_execution_start", toolCallId: "B", toolName: "read", args: { path: "b.ts" } });
    live.applyEvent({
      type: "tool_execution_end",
      toolCallId: "A",
      toolName: "read",
      result: { content: [{ type: "text", text: "OUTPUT_A" }] },
      isError: false,
    });
    live.applyEvent({
      type: "tool_execution_end",
      toolCallId: "B",
      toolName: "read",
      result: { content: [{ type: "text", text: "OUTPUT_B" }] },
      isError: false,
    });

    // Two distinct concrete toolCallIds must keep two distinct transcript rows.
    const tools = entries.filter((e) => e.kind === "tool");
    assert.equal(tools.length, 2);
    assert.deepEqual(tools.map((tool) => tool.toolCallId), ["A", "B"]);

    // Neither row may be left as a bare result-less tool marker (the #1198 bug).
    for (const tool of tools) {
      assert.notEqual(tool.result, undefined);
      assert.equal(tool.isPartial, false);
    }

    const aBlock = tools[0]?.result?.content[0];
    assert.equal(aBlock?.type === "text" ? aBlock.text : undefined, "OUTPUT_A");
    const bBlock = tools[1]?.result?.content[0];
    assert.equal(bBlock?.type === "text" ? bBlock.text : undefined, "OUTPUT_B");

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

  test("scrollable viewport renders only visible rows for windowed components", () => {
    const viewport = new ScrollableComponentViewport();
    const renderedWindows: Array<readonly [number, number]> = [];
    viewport.setVisibleRows(2);
    const windowedComponent = {
      supportsRowWindow: true as const,
      rowCount: () => 5,
      renderRows: (_width: number, startRow: number, endRow: number) => {
        renderedWindows.push([startRow, endRow]);
        return ["line-0", "line-1", "line-2", "line-3", "line-4"].slice(startRow, endRow);
      },
      render: () => {
        throw new Error("windowed component should not render all rows");
      },
      invalidate: () => {},
    };
    viewport.setComponents([windowedComponent]);

    assert.deepEqual(viewport.render(20), ["line-3", "line-4"]);
    assert.deepEqual(renderedWindows, [[3, 5]]);
  });

  test("chat transcript without cache key reflects in-place entry mutations", () => {
    const entries: Array<{ role: "user"; text: string }> = [
      { role: "user", text: "first" },
    ];
    const transcript = new ChatTranscriptComponent(entries, (entry) => ({
      render: () => [entry.text],
      invalidate: () => {},
    }));

    assert.deepEqual(transcript.render(20), ["first"]);
    entries[0]!.text = "updated";
    assert.deepEqual(transcript.render(20), ["updated"]);
  });

  test("chat transcript reuses cached entry blocks across small viewport renders", () => {
    const entries = [
      { role: "user" as const, text: "first" },
      { role: "assistant" as const, text: "second" },
      { role: "user" as const, text: "third" },
    ];
    let renderCount = 0;
    const transcript = new ChatTranscriptComponent(
      entries,
      (entry) => {
        renderCount += 1;
        return {
          render: () => [entry.text],
          invalidate: () => {},
        };
      },
      (entry) => entry.text,
    );
    const viewport = new ScrollableComponentViewport();
    viewport.setVisibleRows(1);
    viewport.setComponents([transcript]);

    assert.deepEqual(viewport.render(20), ["third"]);
    assert.equal(renderCount, 3);
    assert.deepEqual(viewport.render(20), ["third"]);
    assert.equal(renderCount, 3);
  });
});
