import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ChatTranscriptComponent,
  chatEntriesFromAgentMessages,
  LiveChatEntriesController,
  renderChatMessageEntry,
  ScrollableComponentViewport,
} from "../../packages/coding-agent/src/modes/interactive/components/index.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

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

  test("ignores a malformed assistant update snapshot", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);

    assert.equal(live.applyEvent({
      type: "message_update",
      message: { role: "assistant", content: "bad" },
    }), false);
    assert.deepEqual(entries, []);
  });
  for (const [streamType, delta] of [
    ["text_delta", "UNSAFE_TEXT"],
    ["thinking_delta", "UNSAFE_THINKING"],
  ] as const) {
    test(`ignores a ${streamType} from a malformed assistant update and renders the next valid delta`, () => {
      const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
      const live = new LiveChatEntriesController(entries);

      assert.equal(live.applyEvent({
        type: "message_update",
        message: { role: "assistant", content: "bad" },
        assistantMessageEvent: { type: streamType, delta },
      }), false);
      assert.equal(entries.length, 0);

      assert.equal(live.applyEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: streamType, delta: "SAFE_DELTA" },
      }), true);
      assert.deepEqual(entries[0]?.kind === "assistant" ? entries[0].message.content : undefined, [
        streamType === "text_delta"
          ? { type: "text", text: "SAFE_DELTA" }
          : { type: "thinking", thinking: "SAFE_DELTA" },
      ]);
    });
  }

  test("ignores a malformed assistant end snapshot", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);

    assert.equal(live.applyEvent({
      type: "message_end",
      message: { role: "assistant" },
    }), false);
    assert.deepEqual(entries, []);
  });

  for (const [label, interleavedMessage] of [
    ["custom", {
      role: "custom",
      customType: "status",
      content: "Background status",
      display: false,
      timestamp: 2,
    }],
    ["declaration-merged", {
      role: "extensionProgress",
      progress: 0.5,
      label: "Working",
      timestamp: 2,
    }],
  ] as const) {
    test(`keeps the active assistant entry across a valid ${label} message pair`, () => {
      const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
      const live = new LiveChatEntriesController(entries);

      assert.equal(live.applyEvent({
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      }), true);
      live.applyEvent({ type: "message_start", message: interleavedMessage });
      assert.equal(live.applyEvent({ type: "message_end", message: interleavedMessage }), false);
      assert.equal(live.applyEvent({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "complete" }] },
      }), true);

      const assistantEntries = entries.filter((entry) => entry.kind === "assistant");
      assert.equal(assistantEntries.length, 1);
      assert.deepEqual(assistantEntries[0]?.message.content, [{ type: "text", text: "complete" }]);
    });
  }

  for (const [label, terminalMessage] of [
    ["missing", undefined],
    ["null", null],
    ["roleless", {}],
    ["malformed", { role: "assistant", content: "malformed" }],
  ] as const) {
    test(`fences only assistant-owned tools after a ${label} assistant end`, () => {
      const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
      const live = new LiveChatEntriesController(entries);

      assert.equal(live.applyEvent({
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      }), true);
      live.applyEvent({
        type: "tool_execution_start",
        toolCallId: "unrelated-tool",
        toolName: "read",
        args: { path: "unrelated.txt" },
      });
      live.applyEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "owned-tool", name: "read", arguments: { path: "owned.txt" } }],
        },
      });

      assert.equal(live.applyEvent({
        type: "message_end",
        message: terminalMessage,
      }), false);
      assert.deepEqual(live.pendingToolIds(), ["unrelated-tool"]);

      assert.equal(live.applyEvent({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      }), true);
      const assistantEntries = entries.filter((entry) => entry.kind === "assistant");
      assert.equal(assistantEntries.length, 2);
      assert.deepEqual(assistantEntries.map((entry) => entry.message.content), [
        [{ type: "toolCall", id: "owned-tool", name: "read", arguments: { path: "owned.txt" } }],
        [{ type: "text", text: "second" }],
      ]);
      const ownedTool = entries.find((entry) => entry.kind === "tool" && entry.toolCallId === "owned-tool");
      assert.equal(ownedTool?.kind === "tool" ? ownedTool.isPartial : undefined, false);
      assert.deepEqual(ownedTool?.kind === "tool" ? ownedTool.result?.content : undefined, []);
      assert.equal(ownedTool?.kind === "tool" ? ownedTool.result?.isError : undefined, true);
      assert.deepEqual(live.pendingToolIds(), ["unrelated-tool"]);
    });
  }

  test("workflow chat reclaims an announced tool row when execution starts immediately after a malformed end", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);
    live.applyEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "reclaimed-tool", name: "read", arguments: { path: "first.txt" } }],
      },
    });

    live.applyEvent({ type: "message_end", message: undefined });
    assert.deepEqual(live.pendingToolIds(), []);
    live.applyEvent({
      type: "tool_execution_start",
      toolCallId: "reclaimed-tool",
      toolName: "read",
      args: { path: "first.txt" },
    });
    live.applyEvent({
      type: "tool_execution_update",
      toolCallId: "reclaimed-tool",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    live.applyEvent({
      type: "tool_execution_end",
      toolCallId: "reclaimed-tool",
      result: { content: [{ type: "text", text: "final" }] },
      isError: false,
    });

    const tools = entries.filter((entry) => entry.kind === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.result?.content[0]?.type === "text" ? tools[0].result.content[0].text : undefined, "final");
    assert.equal(tools[0]?.isPartial, false);
    assert.deepEqual(live.pendingToolIds(), []);
  });

  test("workflow chat settles an orphaned row and fences late execution traffic after a follow-up", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);
    live.applyEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "stale-tool", name: "read", arguments: { path: "first.txt" } }],
      },
    });
    const staleToolIndex = entries.findIndex((entry) => entry.kind === "tool");

    live.applyEvent({ type: "message_end", message: undefined });
    live.applyEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "follow-up" }] },
    });
    const settledTool = entries[staleToolIndex];
    assert.equal(settledTool?.kind, "tool");
    assert.equal(settledTool?.kind === "tool" ? settledTool.isPartial : undefined, false);
    assert.deepEqual(settledTool?.kind === "tool" ? settledTool.result?.content : undefined, []);
    assert.equal(settledTool?.kind === "tool" ? settledTool.result?.isError : undefined, true);

    const lateStartApplied = live.applyEvent({
      type: "tool_execution_start",
      toolCallId: "stale-tool",
      toolName: "read",
      args: { path: "late.txt" },
    });
    const lateUpdateApplied = live.applyEvent({
      type: "tool_execution_update",
      toolCallId: "stale-tool",
      partialResult: { content: [{ type: "text", text: "LATE_STALE_UPDATE" }] },
    });
    const lateEndApplied = live.applyEvent({
      type: "tool_execution_end",
      toolCallId: "stale-tool",
      result: { content: [{ type: "text", text: "LATE_STALE_END" }] },
      isError: false,
    });

    assert.equal(lateStartApplied, false);
    assert.equal(lateUpdateApplied, false);
    assert.equal(lateEndApplied, false);
    assert.equal(entries[staleToolIndex], settledTool);
    assert.deepEqual(live.pendingToolIds(), []);
    assert.equal(entries.filter((entry) => entry.kind === "assistant").length, 2);
    assert.equal(entries.filter((entry) => entry.kind === "tool").length, 1);

    assert.equal(live.applyEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "stale-tool", name: "read", arguments: { path: "new.txt" } }],
      },
    }), true);
    assert.equal(entries[staleToolIndex], settledTool);
    assert.equal(entries.filter((entry) => entry.kind === "tool").length, 2);
    assert.deepEqual(live.pendingToolIds(), ["stale-tool"]);
  });
  test("ignores malformed tool-result starts and renders a later valid result", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);

    assert.equal(live.applyEvent({
      type: "message_start",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "read" },
    }), false);
    assert.deepEqual(entries, []);

    const validResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 1,
    };
    assert.equal(live.applyEvent({ type: "message_start", message: validResult }), true);
    assert.equal(entries.length, 1);
    initTheme("dark");
    assert.doesNotThrow(() => renderChatMessageEntry(entries[0]!, {
      ui: { requestRender: () => {} },
      cwd: process.cwd(),
    }));
  });

  test("preserves an extension-defined message start", () => {
    const entries = [] as ReturnType<typeof chatEntriesFromAgentMessages>;
    const live = new LiveChatEntriesController(entries);

    assert.equal(live.applyEvent({
      type: "message_start",
      message: { role: "extensionProgress", progress: 0.5, label: "Working", timestamp: 1 },
    }), true);
    assert.deepEqual(entries, [
      { role: "system", kind: "system", text: "extensionProgress" },
    ]);
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
