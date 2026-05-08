import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderMessagesToText,
  hasContent,
  escBash,
  escPwsh,
  watchCopilotSessionForHIL,
  watchCopilotSessionForElicitation,
  shouldOverrideCopilotCliPath,
  discoverCopilotBinary,
  applyContainerEnvDefaults,
  normalizeExternalCopilotOptions,
  buildPaneCommand,
  waitForServer,
  executeWorkflow,
  type CopilotHILSessionSurface,
  type WorkflowRunOptions,
} from "./executor.ts";
import { NoDispatcherError } from "../errors.ts";
import type { SavedMessage } from "../types.ts";
import type { SessionEvent } from "@github/copilot-sdk";
import type { SessionPromptResponse } from "@opencode-ai/sdk/v2";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Test helpers — minimal cast factories
// ---------------------------------------------------------------------------

function makeCopilotAssistantEvent(content: string): SavedMessage {
  return {
    provider: "copilot",
    data: {
      id: "evt-001",
      timestamp: "2024-01-01T00:00:00Z",
      parentId: null,
      type: "assistant.message",
      data: {
        messageId: "msg-001",
        content,
        toolCalls: [],
      },
    } as unknown as SessionEvent,
  };
}

function makeCopilotSessionStartEvent(): SavedMessage {
  return {
    provider: "copilot",
    data: {
      id: "evt-000",
      timestamp: "2024-01-01T00:00:00Z",
      parentId: null,
      type: "session.start",
      data: {
        sessionId: "sess-001",
        version: 1,
        producer: "copilot-agent",
        copilotVersion: "1.0.0",
        startTime: "2024-01-01T00:00:00Z",
      },
    } as unknown as SessionEvent,
  };
}

function makeOpenCodeMessage(parts: Array<{ type: string; text?: string; id?: string }>): SavedMessage {
  return {
    provider: "opencode",
    data: {
      info: {
        id: "msg-oc-001",
        sessionID: "sess-oc-001",
        role: "assistant",
        time: { created: 1000 },
        parentID: "parent-001",
        modelID: "gpt-4",
        providerID: "openai",
        mode: "auto",
        agent: "agent",
        path: { cwd: "/tmp" },
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
      parts: parts.map((p, i) =>
        p.type === "text"
          ? { id: p.id ?? `part-${i}`, sessionID: "sess-oc-001", messageID: "msg-oc-001", type: "text" as const, text: p.text ?? "" }
          : { id: `part-${i}`, sessionID: "sess-oc-001", messageID: "msg-oc-001", type: p.type as "reasoning", text: "" },
      ),
    } as unknown as SessionPromptResponse,
  };
}

function makeClaudeMessage(
  type: "user" | "assistant" | "system",
  message: unknown,
): SavedMessage {
  return {
    provider: "claude",
    data: {
      type,
      uuid: "uuid-001",
      session_id: "sess-cl-001",
      message,
      parent_tool_use_id: null,
    } as SessionMessage,
  };
}

// ---------------------------------------------------------------------------
// renderMessagesToText
// ---------------------------------------------------------------------------

describe("renderMessagesToText", () => {
  test("returns empty string for empty array", () => {
    expect(renderMessagesToText([])).toBe("");
  });

  // --- Copilot ---

  test("renders a copilot assistant.message under an Assistant header", () => {
    const messages: SavedMessage[] = [
      makeCopilotAssistantEvent("Hello from Copilot"),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nHello from Copilot",
    );
  });

  test("skips copilot non-assistant events (session.start)", () => {
    const messages: SavedMessage[] = [makeCopilotSessionStartEvent()];
    expect(renderMessagesToText(messages)).toBe("");
  });

  test("only renders copilot assistant.message events when mixed with other event types", () => {
    const messages: SavedMessage[] = [
      makeCopilotSessionStartEvent(),
      makeCopilotAssistantEvent("First response"),
      makeCopilotSessionStartEvent(),
      makeCopilotAssistantEvent("Second response"),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nFirst response\n\n### Assistant\n\nSecond response",
    );
  });

  // --- OpenCode ---

  test("renders opencode text parts under an Assistant header", () => {
    const messages: SavedMessage[] = [
      makeOpenCodeMessage([
        { type: "text", text: "Line one" },
        { type: "text", text: "Line two" },
      ]),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nLine one\n\nLine two",
    );
  });

  test("filters out non-text parts from opencode messages", () => {
    const messages: SavedMessage[] = [
      makeOpenCodeMessage([
        { type: "reasoning", text: "thinking..." },
        { type: "subtask", text: "" },
      ]),
    ];
    expect(renderMessagesToText(messages)).toBe("");
  });

  test("includes only text parts when opencode message has mixed part types", () => {
    const messages: SavedMessage[] = [
      makeOpenCodeMessage([
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "The answer is 42" },
        { type: "subtask", text: "" },
      ]),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nThe answer is 42",
    );
  });

  // --- Claude ---

  test("renders a claude assistant string message under an Assistant header", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", "Plain string output"),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nPlain string output",
    );
  });

  test("renders claude assistant message with content as string under an Assistant header", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", { content: "Content field string" }),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nContent field string",
    );
  });

  test("joins claude text blocks with a double newline under a single Assistant header", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", {
        content: [
          { type: "text", text: "Block one" },
          { type: "text", text: "Block two" },
        ],
      }),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nBlock one\n\nBlock two",
    );
  });

  test("renders a claude user string message under a User header", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("user", "user prompt"),
    ];
    expect(renderMessagesToText(messages)).toBe("### User\n\nuser prompt");
  });

  test("skips claude system messages", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("system", "system instructions"),
    ];
    expect(renderMessagesToText(messages)).toBe("");
  });

  test("returns empty string for a claude assistant message with an unknown content shape", () => {
    const unknownMsg = { weird: "shape", count: 99 };
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", unknownMsg),
    ];
    expect(renderMessagesToText(messages)).toBe("");
  });

  test("renders tool_use blocks inline with text under a single Assistant header", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", {
        content: [
          { type: "text", text: "I'll read the file" },
          {
            type: "tool_use",
            id: "tu-1",
            name: "Read",
            input: { path: "/tmp/foo" },
          },
          { type: "text", text: "Here's what I found" },
        ],
      }),
    ];
    expect(renderMessagesToText(messages)).toBe(
      [
        "### Assistant",
        "",
        "I'll read the file",
        "",
        "**→ `Read`**",
        "",
        "```json",
        "{\n  \"path\": \"/tmp/foo\"\n}",
        "```",
        "",
        "Here's what I found",
      ].join("\n"),
    );
  });

  test("skips claude `thinking` blocks in the rendered transcript", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", {
        content: [
          { type: "thinking", thinking: "internal reasoning…", signature: "sig" },
          { type: "text", text: "Public answer" },
        ],
      }),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nPublic answer",
    );
  });

  test("omits `tool_result` payloads entirely — only the call and subsequent assistant turns survive", () => {
    const big = "x".repeat(5_000);
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", {
        content: [
          {
            type: "tool_use",
            id: "tu-42",
            name: "Read",
            input: { file_path: "/tmp/note.md" },
          },
        ],
      }),
      makeClaudeMessage("user", {
        content: [
          { type: "tool_result", tool_use_id: "tu-42", content: big },
        ],
      }),
      makeClaudeMessage("assistant", {
        content: [{ type: "text", text: "Done." }],
      }),
    ];
    const rendered = renderMessagesToText(messages);

    // The tool call itself is present, with its input JSON.
    expect(rendered).toContain("**→ `Read`**");
    expect(rendered).toContain("/tmp/note.md");

    // The follow-up assistant turn is present.
    expect(rendered).toContain("### Assistant\n\nDone.");

    // The tool_result payload is completely absent — not truncated, not
    // labelled, not present in any form. This is the context-rot guard:
    // even a 5_000-char result must not leak into the transcript.
    expect(rendered).not.toContain("xxxxx");
    expect(rendered).not.toContain("← `Read` result");
    expect(rendered).not.toContain("← `Read`");
  });

  test("truncates very long tool_use `input` payloads with a `[+N chars]` suffix", () => {
    const bigCommand = "echo " + "a".repeat(5_000);
    const messages: SavedMessage[] = [
      makeClaudeMessage("assistant", {
        content: [
          {
            type: "tool_use",
            id: "tu-big",
            name: "Bash",
            input: { command: bigCommand },
          },
        ],
      }),
    ];
    const rendered = renderMessagesToText(messages);
    expect(rendered).toContain("**→ `Bash`**");
    // Input budget is 800 chars of JSON — the long command must be truncated.
    expect(rendered).toContain("chars]");
    expect(rendered.length).toBeLessThan(bigCommand.length);
  });

  test("skips a user message whose only content is `tool_result` blocks", () => {
    const messages: SavedMessage[] = [
      makeClaudeMessage("user", {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-a",
            content: "would-be-noisy output",
          },
        ],
      }),
    ];
    expect(renderMessagesToText(messages)).toBe("");
  });

  // --- Mixed providers ---

  test("joins messages from mixed providers with double newlines and provider-appropriate headers", () => {
    const messages: SavedMessage[] = [
      makeCopilotAssistantEvent("Copilot says hello"),
      makeOpenCodeMessage([{ type: "text", text: "OpenCode says hello" }]),
      makeClaudeMessage("assistant", "Claude says hello"),
    ];
    expect(renderMessagesToText(messages)).toBe(
      [
        "### Assistant",
        "",
        "Copilot says hello",
        "",
        "### Assistant",
        "",
        "OpenCode says hello",
        "",
        "### Assistant",
        "",
        "Claude says hello",
      ].join("\n"),
    );
  });

  test("skips blank entries when building joined output", () => {
    const messages: SavedMessage[] = [
      makeCopilotSessionStartEvent(),
      makeCopilotAssistantEvent("Only one has content"),
      makeOpenCodeMessage([{ type: "reasoning", text: "ignored" }]),
    ];
    expect(renderMessagesToText(messages)).toBe(
      "### Assistant\n\nOnly one has content",
    );
  });
});

// ---------------------------------------------------------------------------
// hasContent type guard
// ---------------------------------------------------------------------------

describe("hasContent", () => {
  test("returns true for object with string content property", () => {
    expect(hasContent({ content: "hello" })).toBe(true);
  });

  test("returns false for empty object", () => {
    expect(hasContent({})).toBe(false);
  });

  test("returns false for null", () => {
    expect(hasContent(null)).toBe(false);
  });

  test("returns false when content is a number instead of a string", () => {
    expect(hasContent({ content: 42 })).toBe(false);
  });

  test("returns false for a plain string value", () => {
    expect(hasContent("hello")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(hasContent(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escBash — shell escaping for bash double-quoted strings
// ---------------------------------------------------------------------------

describe("escBash", () => {
  test("returns empty string unchanged", () => {
    expect(escBash("")).toBe("");
  });

  test("passes through plain alphanumeric text", () => {
    expect(escBash("hello world 123")).toBe("hello world 123");
  });

  test("escapes double quotes", () => {
    expect(escBash('say "hello"')).toBe('say \\"hello\\"');
  });

  test("escapes backslashes", () => {
    expect(escBash("a\\b")).toBe("a\\\\b");
  });

  test("escapes dollar signs", () => {
    expect(escBash("$HOME")).toBe("\\$HOME");
  });

  test("escapes backticks", () => {
    expect(escBash("`whoami`")).toBe("\\`whoami\\`");
  });

  test("escapes exclamation marks (history expansion)", () => {
    expect(escBash("hello!")).toBe("hello\\!");
  });

  test("replaces newlines with spaces", () => {
    expect(escBash("line1\nline2\nline3")).toBe("line1 line2 line3");
  });

  test("replaces carriage returns with spaces", () => {
    expect(escBash("line1\r\nline2")).toBe("line1 line2");
  });

  test("collapses consecutive newlines into a single space", () => {
    expect(escBash("a\n\n\nb")).toBe("a b");
  });

  test("strips null bytes", () => {
    expect(escBash("ab\0cd")).toBe("abcd");
  });

  test("preserves single quotes (literal in double-quoted bash strings)", () => {
    expect(escBash("it's fine")).toBe("it's fine");
  });

  test("preserves parentheses, braces, and brackets (safe in double quotes)", () => {
    expect(escBash("(a) {b} [c]")).toBe("(a) {b} [c]");
  });

  test("preserves pipe, ampersand, and semicolon (safe in double quotes)", () => {
    expect(escBash("a | b & c ; d")).toBe("a | b & c ; d");
  });

  test("handles a string with all special characters combined", () => {
    expect(escBash('$`"\\!\0')).toBe('\\$\\`\\"\\\\\\!');
  });

  test("handles unicode characters", () => {
    expect(escBash("héllo wörld 日本語")).toBe("héllo wörld 日本語");
  });

  test("handles very long strings without error", () => {
    const long = "a".repeat(10_000);
    expect(escBash(long)).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// escPwsh — shell escaping for PowerShell double-quoted strings
// ---------------------------------------------------------------------------

describe("escPwsh", () => {
  test("returns empty string unchanged", () => {
    expect(escPwsh("")).toBe("");
  });

  test("passes through plain text", () => {
    expect(escPwsh("hello world")).toBe("hello world");
  });

  test("escapes backticks (PowerShell escape character)", () => {
    expect(escPwsh("a`b")).toBe("a``b");
  });

  test("escapes double quotes", () => {
    expect(escPwsh('say "hi"')).toBe('say `"hi`"');
  });

  test("escapes dollar signs", () => {
    expect(escPwsh("$env:HOME")).toBe("`$env:HOME");
  });

  test("converts newlines to backtick-n", () => {
    expect(escPwsh("line1\nline2")).toBe("line1`nline2");
  });

  test("converts carriage returns to backtick-r", () => {
    expect(escPwsh("line1\rline2")).toBe("line1`rline2");
  });

  test("strips null bytes", () => {
    expect(escPwsh("ab\0cd")).toBe("abcd");
  });

  test("handles combined special characters", () => {
    expect(escPwsh('$`"\0')).toBe('`$```"');
  });
});

// ---------------------------------------------------------------------------
// watchCopilotSessionForHIL — event-driven HIL detection via tool.execution_*
// ---------------------------------------------------------------------------

/**
 * Minimal mock of the Copilot session surface that records handlers by event
 * type and lets tests dispatch synthetic events.  Mirrors the structural
 * `on()` contract of `CopilotHILSessionSurface`.
 */
function makeMockCopilotSession(): CopilotHILSessionSurface & {
  dispatch: (type: string, data: unknown) => void;
  handlerCount: (type: string) => number;
} {
  const handlers = new Map<string, Set<(event: { data?: unknown }) => void>>();
  return {
    on(eventType, handler) {
      let set = handlers.get(eventType);
      if (!set) {
        set = new Set();
        handlers.set(eventType, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
    dispatch(type, data) {
      const set = handlers.get(type);
      if (set) for (const h of set) h({ data });
    },
    handlerCount(type) {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

describe("watchCopilotSessionForHIL", () => {
  test("fires onHIL(true) on ask_user start and onHIL(false) on matching complete", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForHIL(session, (w) =>
      calls.push(w),
    );

    session.dispatch("tool.execution_start", {
      toolName: "ask_user",
      toolCallId: "tc-1",
    });
    expect(calls).toEqual([true]);

    session.dispatch("tool.execution_complete", { toolCallId: "tc-1" });
    expect(calls).toEqual([true, false]);

    unsubscribe();
  });

  test("ignores tool.execution_start for non-ask_user tools", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForHIL(session, (w) =>
      calls.push(w),
    );

    session.dispatch("tool.execution_start", {
      toolName: "edit_file",
      toolCallId: "tc-2",
    });
    session.dispatch("tool.execution_complete", { toolCallId: "tc-2" });
    expect(calls).toEqual([]);

    unsubscribe();
  });

  test("ignores complete events for toolCallIds it did not mark active", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForHIL(session, (w) =>
      calls.push(w),
    );

    // complete arrives for a tool we never started (e.g. another tool's id)
    session.dispatch("tool.execution_complete", { toolCallId: "tc-unknown" });
    expect(calls).toEqual([]);

    unsubscribe();
  });

  test("only fires onHIL(false) after the last overlapping ask_user completes", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForHIL(session, (w) =>
      calls.push(w),
    );

    session.dispatch("tool.execution_start", {
      toolName: "ask_user",
      toolCallId: "tc-a",
    });
    session.dispatch("tool.execution_start", {
      toolName: "ask_user",
      toolCallId: "tc-b",
    });
    // onHIL(true) fires exactly once on the first start
    expect(calls).toEqual([true]);

    session.dispatch("tool.execution_complete", { toolCallId: "tc-a" });
    // still one active — must not fire onHIL(false) yet
    expect(calls).toEqual([true]);

    session.dispatch("tool.execution_complete", { toolCallId: "tc-b" });
    expect(calls).toEqual([true, false]);

    unsubscribe();
  });

  test("skips ask_user start events that are missing a toolCallId", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForHIL(session, (w) =>
      calls.push(w),
    );

    session.dispatch("tool.execution_start", { toolName: "ask_user" });
    expect(calls).toEqual([]);

    unsubscribe();
  });

  test("unsubscribe removes both listeners", () => {
    const session = makeMockCopilotSession();
    const unsubscribe = watchCopilotSessionForHIL(session, () => {});

    expect(session.handlerCount("tool.execution_start")).toBe(1);
    expect(session.handlerCount("tool.execution_complete")).toBe(1);

    unsubscribe();

    expect(session.handlerCount("tool.execution_start")).toBe(0);
    expect(session.handlerCount("tool.execution_complete")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// watchCopilotSessionForElicitation — HIL detection via elicitation events
// ---------------------------------------------------------------------------

describe("watchCopilotSessionForElicitation", () => {
  test("fires onHIL(true) on elicitation.requested event", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForElicitation(session, (w) =>
      calls.push(w),
    );

    session.dispatch("elicitation.requested", { requestId: "req-1" });
    expect(calls).toEqual([true]);

    unsubscribe();
  });

  test("fires onHIL(false) on elicitation.completed with matching requestId", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForElicitation(session, (w) =>
      calls.push(w),
    );

    session.dispatch("elicitation.requested", { requestId: "req-1" });
    expect(calls).toEqual([true]);

    session.dispatch("elicitation.completed", { requestId: "req-1" });
    expect(calls).toEqual([true, false]);

    unsubscribe();
  });

  test("only fires onHIL(true) once and onHIL(false) only after last overlapping request completes", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForElicitation(session, (w) =>
      calls.push(w),
    );

    session.dispatch("elicitation.requested", { requestId: "req-a" });
    session.dispatch("elicitation.requested", { requestId: "req-b" });
    // onHIL(true) fires exactly once on the first request
    expect(calls).toEqual([true]);

    session.dispatch("elicitation.completed", { requestId: "req-a" });
    // req-b still active — must not fire onHIL(false) yet
    expect(calls).toEqual([true]);

    session.dispatch("elicitation.completed", { requestId: "req-b" });
    expect(calls).toEqual([true, false]);

    unsubscribe();
  });

  test("ignores elicitation.completed for an unknown requestId", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForElicitation(session, (w) =>
      calls.push(w),
    );

    session.dispatch("elicitation.completed", { requestId: "req-unknown" });
    expect(calls).toEqual([]);

    unsubscribe();
  });

  test("ignores elicitation.requested payload without a requestId", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForElicitation(session, (w) =>
      calls.push(w),
    );

    session.dispatch("elicitation.requested", {});
    expect(calls).toEqual([]);

    unsubscribe();
  });

  test("unsubscribe removes both elicitation listeners and subsequent events are not received", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForElicitation(session, (w) =>
      calls.push(w),
    );

    expect(session.handlerCount("elicitation.requested")).toBe(1);
    expect(session.handlerCount("elicitation.completed")).toBe(1);

    unsubscribe();

    expect(session.handlerCount("elicitation.requested")).toBe(0);
    expect(session.handlerCount("elicitation.completed")).toBe(0);

    // Events fired after unsubscribe must not reach the original handler
    session.dispatch("elicitation.requested", { requestId: "req-post" });
    session.dispatch("elicitation.completed", { requestId: "req-post" });
    expect(calls).toEqual([]);
  });

  test("MCP-initiated elicitation (non-empty elicitationSource) triggers onHIL(true) and onHIL(false) same as agent-initiated", () => {
    const session = makeMockCopilotSession();
    const calls: boolean[] = [];
    const unsubscribe = watchCopilotSessionForElicitation(session, (w) =>
      calls.push(w),
    );

    // Simulate MCP-initiated elicitation with a non-empty elicitationSource
    session.dispatch("elicitation.requested", {
      requestId: "req-mcp-1",
      elicitationSource: "mcp-server://my-tool",
      message: "Please provide your API key",
    });
    expect(calls).toEqual([true]);

    session.dispatch("elicitation.completed", {
      requestId: "req-mcp-1",
      action: "accept",
    });
    expect(calls).toEqual([true, false]);

    unsubscribe();
  });

  test("calling unsubscribe twice does not throw", () => {
    const session = makeMockCopilotSession();
    const unsubscribe = watchCopilotSessionForElicitation(session, () => {});

    unsubscribe();
    // Second call must be safe — no throw, no error
    expect(() => unsubscribe()).not.toThrow();
  });

  test("ask_user watcher and elicitation watcher on same session track HIL independently", () => {
    const session = makeMockCopilotSession();
    const hilCalls: boolean[] = [];
    const elicitationCalls: boolean[] = [];

    const unsubHIL = watchCopilotSessionForHIL(session, (w) =>
      hilCalls.push(w),
    );
    const unsubElicitation = watchCopilotSessionForElicitation(session, (w) =>
      elicitationCalls.push(w),
    );

    // Fire an ask_user event — only the HIL watcher should see it
    session.dispatch("tool.execution_start", {
      toolName: "ask_user",
      toolCallId: "tc-concurrent",
    });
    expect(hilCalls).toEqual([true]);
    expect(elicitationCalls).toEqual([]);

    // Fire an elicitation event — only the elicitation watcher should see it
    session.dispatch("elicitation.requested", {
      requestId: "req-concurrent",
    });
    expect(hilCalls).toEqual([true]);
    expect(elicitationCalls).toEqual([true]);

    // Complete the ask_user — only HIL watcher fires false
    session.dispatch("tool.execution_complete", { toolCallId: "tc-concurrent" });
    expect(hilCalls).toEqual([true, false]);
    expect(elicitationCalls).toEqual([true]);

    // Complete the elicitation — only elicitation watcher fires false
    session.dispatch("elicitation.completed", { requestId: "req-concurrent" });
    expect(hilCalls).toEqual([true, false]);
    expect(elicitationCalls).toEqual([true, false]);

    unsubHIL();
    unsubElicitation();
  });
});

// ---------------------------------------------------------------------------
// Copilot SDK 0.3 external-server auth option normalization
// ---------------------------------------------------------------------------

describe("normalizeExternalCopilotOptions", () => {
  test("moves client-level GitHub token to the session for cliUrl clients", () => {
    const result = normalizeExternalCopilotOptions({
      gitHubToken: "client-token",
      logLevel: "error",
    });

    expect(result).toEqual({
      clientOptions: { logLevel: "error" },
      sessionGitHubToken: "client-token",
    });
  });

  test("keeps an explicit session GitHub token when both levels are set", () => {
    const result = normalizeExternalCopilotOptions(
      { gitHubToken: "client-token" },
      "session-token",
    );

    expect(result).toEqual({
      clientOptions: {},
      sessionGitHubToken: "session-token",
    });
  });

  test("rejects useLoggedInUser because external Copilot servers own auth", () => {
    expect(() =>
      normalizeExternalCopilotOptions({ useLoggedInUser: false }),
    ).toThrow("useLoggedInUser");
  });
});

// ---------------------------------------------------------------------------
// Copilot CLI path discovery (Bun-without-node containers)
// ---------------------------------------------------------------------------

describe("discoverCopilotBinary / shouldOverrideCopilotCliPath", () => {
  let sandbox: string;
  let savedPath: string | undefined;
  let savedCliPath: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "atomic-cli-probe-"));
    savedPath = process.env.PATH;
    savedCliPath = process.env.COPILOT_CLI_PATH;
    delete process.env.COPILOT_CLI_PATH;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedCliPath === undefined) delete process.env.COPILOT_CLI_PATH;
    else process.env.COPILOT_CLI_PATH = savedCliPath;
    rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * Cross-platform stub binary writer. `discoverCopilotBinary` and
   * `isNodeOnPath` look for `<name>.exe` on Windows (PATHEXT-aware) and
   * the bare name on Unix; this helper writes whichever the host
   * resolver expects so the same test logic works everywhere.
   */
  function putExe(dir: string, name: string, contents?: string): string {
    if (process.platform === "win32") {
      const p = join(dir, `${name}.exe`);
      // Real PE binary content isn't required — the resolver only does a
      // file-exists/`isFile` check on Windows (no executable bit there).
      writeFileSync(p, contents ?? "stub\r\n");
      return p;
    }
    const p = join(dir, name);
    writeFileSync(p, contents ?? "#!/bin/sh\necho $0");
    chmodSync(p, 0o755);
    return p;
  }

  test("finds an executable 'copilot' on PATH", () => {
    const bin = putExe(sandbox, "copilot");
    process.env.PATH = sandbox;
    expect(discoverCopilotBinary()).toBe(bin);
  });

  test("returns undefined when no copilot on PATH", () => {
    process.env.PATH = sandbox;
    expect(discoverCopilotBinary()).toBeUndefined();
  });

  test("returns undefined when PATH is unset", () => {
    delete process.env.PATH;
    expect(discoverCopilotBinary()).toBeUndefined();
  });

  test("returns undefined when PATH is empty", () => {
    process.env.PATH = "";
    expect(discoverCopilotBinary()).toBeUndefined();
  });

  test("skips non-executable files named 'copilot' on Unix", () => {
    if (process.platform === "win32") return;
    const p = join(sandbox, "copilot");
    writeFileSync(p, "not executable");
    chmodSync(p, 0o644);
    process.env.PATH = sandbox;
    expect(discoverCopilotBinary()).toBeUndefined();
  });

  test("shouldOverrideCopilotCliPath: false when COPILOT_CLI_PATH is user-set", () => {
    putExe(sandbox, "copilot");
    process.env.PATH = sandbox;
    process.env.COPILOT_CLI_PATH = "/somewhere/else/copilot";
    expect(shouldOverrideCopilotCliPath()).toBe(false);
  });

  test("shouldOverrideCopilotCliPath: false when node is also on PATH (SDK default works)", () => {
    putExe(sandbox, "copilot");
    putExe(sandbox, "node");
    process.env.PATH = sandbox;
    expect(shouldOverrideCopilotCliPath()).toBe(false);
  });

  test("shouldOverrideCopilotCliPath: true when bun + copilot but no node", () => {
    putExe(sandbox, "copilot");
    // Sandboxing PATH to a dir without `node` is what makes this test
    // deterministic regardless of the host's installed toolchain.
    process.env.PATH = sandbox;
    // We're running this test under Bun, so process.versions.bun is set
    expect(!!process.versions.bun).toBe(true);
    expect(shouldOverrideCopilotCliPath()).toBe(true);
  });

  test("shouldOverrideCopilotCliPath: false when PATH is unset", () => {
    delete process.env.PATH;
    expect(shouldOverrideCopilotCliPath()).toBe(false);
  });

  test("applyContainerEnvDefaults sets COPILOT_CLI_PATH when override is needed", () => {
    const bin = putExe(sandbox, "copilot");
    process.env.PATH = sandbox;
    applyContainerEnvDefaults();
    expect(process.env.COPILOT_CLI_PATH).toBe(bin);
  });

  test("applyContainerEnvDefaults does NOT overwrite user-set COPILOT_CLI_PATH", () => {
    putExe(sandbox, "copilot");
    process.env.PATH = sandbox;
    process.env.COPILOT_CLI_PATH = "/custom/copilot";
    applyContainerEnvDefaults();
    expect(process.env.COPILOT_CLI_PATH).toBe("/custom/copilot");
  });
});

// ---------------------------------------------------------------------------
// buildPaneCommand
// ---------------------------------------------------------------------------

describe("buildPaneCommand", () => {
  test("copilot: command contains --ui-server and --port 0", () => {
    const { command } = buildPaneCommand("copilot");
    expect(command).toContain("--ui-server");
    expect(command).toContain("--port 0");
  });

  test("copilot: command invokes the copilot binary as the first token", () => {
    const { command } = buildPaneCommand("copilot");
    // Accept either a bare name (binary not on PATH in test env) or an
    // absolute path resolved via Bun.which — both end in "copilot".
    // Windows paths use `\\` separators and the resolved binary has a
    // `.exe` suffix; the optional `(\.exe)?` and dual-separator class
    // keep this matcher cross-platform.
    expect(command).toMatch(/^("[^"]*[\\/])?[^\s"]*copilot(\.exe)?"?\s/);
  });

  test("opencode: command contains --port 0 but not --ui-server", () => {
    const { command } = buildPaneCommand("opencode");
    expect(command).toContain("--port 0");
    expect(command).not.toContain("--ui-server");
  });

  test("opencode: command invokes the opencode binary as the first token", () => {
    const { command } = buildPaneCommand("opencode");
    expect(command).toMatch(/^("[^"]*[\\/])?[^\s"]*opencode(\.exe)?"?\s/);
  });

  test("claude: command resolves to a shell and does not contain --port", () => {
    const { command } = buildPaneCommand("claude");
    // SHELL is typically already absolute (e.g. /bin/zsh) so it passes through
    // unchanged; bare fallbacks ("sh"/"pwsh") get resolved via Bun.which —
    // which returns a `.exe`-suffixed path on Windows.
    const expected =
      process.env.SHELL || (process.platform === "win32" ? "pwsh" : "sh");
    // The command emitted into the tmux pane line is bash-escaped (each
    // `\` and `"` is prefixed with a literal `\`) and wrapped in quotes
    // when the path has special chars. Reverse both transforms to recover
    // the original path before comparing — Windows shell paths
    // (e.g. `C:\Program Files\PowerShell\7\pwsh.exe`) hit this branch.
    const stripped = command
      .replace(/^"|"$/g, "")
      .replace(/\\(.)/g, "$1");
    if (expected.includes("/") || expected.includes("\\")) {
      expect(stripped).toBe(expected);
    } else {
      // Bare fallback either resolved via Bun.which or returned as-is.
      const variants = [expected, `${expected}.exe`];
      expect(
        variants.some((v) => stripped.endsWith(v) || stripped === v),
      ).toBe(true);
    }
    expect(command).not.toContain("--port");
  });

  test("claude: scopes temp files to the user's Atomic temp directory", () => {
    const { envVars } = buildPaneCommand("claude");
    // `path.join`'s separator differs by platform; accept either form.
    expect(envVars.TMPDIR).toMatch(/[\\/]\.atomic[\\/]tmp$/);
    expect(envVars.TMP).toBe(envVars.TMPDIR);
    expect(envVars.TEMP).toBe(envVars.TMPDIR);
  });

  test("claude: explicit temp env overrides the Atomic default", () => {
    const { envVars } = buildPaneCommand("claude", {
      envVars: { TMPDIR: "/custom/tmp", TMP: "/custom/tmp", TEMP: "/custom/tmp" },
    });
    expect(envVars.TMPDIR).toBe("/custom/tmp");
    expect(envVars.TMP).toBe("/custom/tmp");
    expect(envVars.TEMP).toBe("/custom/tmp");
  });

  test("overrides.envVars merges with defaults for copilot", () => {
    const { envVars } = buildPaneCommand("copilot", {
      envVars: { MY_VAR: "hello" },
    });
    // Default copilot env var preserved
    expect(envVars.COPILOT_ALLOW_ALL).toBe("true");
    // Override merged in
    expect(envVars.MY_VAR).toBe("hello");
  });

  test("overrides.chatFlags replaces defaults for copilot", () => {
    const { command } = buildPaneCommand("copilot", {
      chatFlags: ["--custom-flag"],
    });
    expect(command).toContain("--custom-flag");
    // Default flags should be absent
    expect(command).not.toContain("--add-dir");
  });

  test("extraChatFlags appended to copilot command", () => {
    const { command } = buildPaneCommand("copilot", {}, ["--extra-flag"]);
    expect(command).toContain("--extra-flag");
  });

  test("extraChatFlags not appended to opencode command", () => {
    const { command } = buildPaneCommand("opencode", {}, ["--extra-flag"]);
    expect(command).not.toContain("--extra-flag");
  });

  test("copilot: respects COPILOT_CLI_PATH env var for binary resolution", () => {
    const origCliPath = process.env["COPILOT_CLI_PATH"];
    process.env["COPILOT_CLI_PATH"] = "/custom/path/copilot";
    try {
      const { command } = buildPaneCommand("copilot");
      // The command should start with the COPILOT_CLI_PATH binary.
      expect(command.startsWith("/custom/path/copilot ")).toBe(true);
    } finally {
      if (origCliPath === undefined) delete process.env["COPILOT_CLI_PATH"];
      else process.env["COPILOT_CLI_PATH"] = origCliPath;
    }
  });
});

// ---------------------------------------------------------------------------
// waitForServer
// ---------------------------------------------------------------------------

// Three non-empty lines — enough to break the TUI-render loop.
const PANE_CONTENT_READY = "line one\nline two\nline three\n";

// ---------------------------------------------------------------------------
// waitForServer — module-level captures for mock.module cleanup
// ---------------------------------------------------------------------------

// Snapshot the real function values BEFORE any mock.module call.
// We can't hold the module namespace reference because mock.module mutates it
// in-place, so we must copy the property values into a plain object snapshot.
const _tmuxMod = await import("./tmux.ts");
const realTmuxSnapshot = { ..._tmuxMod };
const _portMod = await import("./port-discovery.ts");
const realPortDiscoverySnapshot = { ..._portMod };
let realCopilotSdkSnapshot: Record<string, unknown> | null = null;
try {
  const _copilotMod = await import("@github/copilot-sdk");
  realCopilotSdkSnapshot = { ..._copilotMod };
} catch {
  // optional dependency — not installed in all environments
}

describe("waitForServer", () => {
  // Save and restore Bun.sleep so we can make it instant in async tests.
  let originalSleep: typeof Bun.sleep;

  beforeEach(() => {
    originalSleep = Bun.sleep;
    // Make Bun.sleep a no-op so probe retry loops resolve immediately.
    (globalThis as { Bun: { sleep: (ms: number) => Promise<void> } }).Bun.sleep =
      () => Promise.resolve();
  });

  afterEach(() => {
    (globalThis as { Bun: { sleep: typeof Bun.sleep } }).Bun.sleep =
      originalSleep;
    // Restore module mocks so they don't leak into subsequent test files.
    // Use snapshot copies (not live references) because mock.module mutates
    // the module namespace in-place.
    mock.module("./tmux.ts", () => realTmuxSnapshot);
    mock.module("./port-discovery.ts", () => realPortDiscoverySnapshot);
    if (realCopilotSdkSnapshot !== null) {
      mock.module("@github/copilot-sdk", () => realCopilotSdkSnapshot!);
    }
  });

  test('returns "" immediately for agent "claude" without touching tmux', async () => {
    // No mocks for tmux — any call would throw because real tmux isn't running.
    const result = await waitForServer("claude", "%0");
    expect(result).toBe("");
  });

  test("copilot: throws when getPanePid returns null", async () => {
    mock.module("./tmux.ts", () => ({
      capturePane: () => PANE_CONTENT_READY,
      getPanePid: () => null,
      // preserve other named exports as stubs
      spawnMuxAttach: () => {},
    }));

    let err: Error | undefined;
    try {
      await waitForServer("copilot", "%0");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("failed to resolve agent PID");
  });

  test("copilot: throws when port discovery times out (getListeningPortForPid returns null)", async () => {
    mock.module("./tmux.ts", () => ({
      capturePane: () => PANE_CONTENT_READY,
      getPanePid: () => 12345,
      spawnMuxAttach: () => {},
    }));

    mock.module("./port-discovery.ts", () => ({
      getListeningPortForPid: async () => null,
      PORT_DISCOVERY_TIMEOUT_MS: 100,
    }));

    let err: Error | undefined;
    try {
      await waitForServer("copilot", "%0");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("did not bind a TCP port");
  });

  test("copilot: throws when SDK probe fails (CopilotClient.start rejects)", async () => {
    mock.module("./tmux.ts", () => ({
      capturePane: () => PANE_CONTENT_READY,
      getPanePid: () => 12345,
      spawnMuxAttach: () => {},
    }));

    mock.module("./port-discovery.ts", () => ({
      getListeningPortForPid: async () => 50001,
      PORT_DISCOVERY_TIMEOUT_MS: 100,
    }));

    mock.module("@github/copilot-sdk", () => ({
      CopilotClient: class {
        start() {
          return Promise.reject(new Error("connection refused"));
        }
        listSessions() {
          return Promise.resolve([]);
        }
        stop() {
          return Promise.resolve();
        }
      },
    }));

    // SERVER_PROBE_TIMEOUT_MS is 60_000 but Bun.sleep is mocked to instant,
    // so the loop burns through retries until Date.now() passes the deadline.
    // To avoid a real 60s wall-clock wait we mock Date.now temporarily.
    const realDateNow = Date.now;
    let callCount = 0;
    Date.now = () => {
      callCount++;
      // First few calls (port-deadline checks, probe-deadline setup): allow.
      // After 10 calls assume probe deadline has passed.
      return callCount > 10 ? realDateNow() + 999_999 : realDateNow();
    };

    let err: Error | undefined;
    try {
      try {
        await waitForServer("copilot", "%0");
      } catch (e) {
        err = e as Error;
      }
    } finally {
      Date.now = realDateNow;
    }
    expect(err?.message).toContain("copilot SDK probe did not respond");
  });

  test("copilot: returns localhost:<port> when SDK probe succeeds", async () => {
    mock.module("./tmux.ts", () => ({
      capturePane: () => PANE_CONTENT_READY,
      getPanePid: () => 12345,
      spawnMuxAttach: () => {},
    }));

    mock.module("./port-discovery.ts", () => ({
      getListeningPortForPid: async () => 50001,
      PORT_DISCOVERY_TIMEOUT_MS: 100,
    }));

    mock.module("@github/copilot-sdk", () => ({
      CopilotClient: class {
        start() {
          return Promise.resolve();
        }
        listSessions() {
          return Promise.resolve([]);
        }
        stop() {
          return Promise.resolve();
        }
      },
    }));

    const result = await waitForServer("copilot", "%0");
    expect(result).toBe("localhost:50001");
  });

  test("copilot: probe does not pass useLoggedInUser to CopilotClient (external server owns auth)", async () => {
    mock.module("./tmux.ts", () => ({
      capturePane: () => PANE_CONTENT_READY,
      getPanePid: () => 12345,
      spawnMuxAttach: () => {},
    }));

    mock.module("./port-discovery.ts", () => ({
      getListeningPortForPid: async () => 50002,
      PORT_DISCOVERY_TIMEOUT_MS: 100,
    }));

    let capturedOptions: unknown;
    mock.module("@github/copilot-sdk", () => ({
      CopilotClient: class {
        constructor(opts: unknown) {
          capturedOptions = opts;
        }
        start() {
          return Promise.resolve();
        }
        listSessions() {
          return Promise.resolve([]);
        }
        stop() {
          return Promise.resolve();
        }
      },
    }));

    await waitForServer("copilot", "%0");
    const opts = capturedOptions as Record<string, unknown>;
    expect(opts).toBeDefined();
    // cliUrl must be set — connecting to an existing server
    expect(opts["cliUrl"]).toBe("localhost:50002");
    // useLoggedInUser must NOT be set — external server owns auth
    expect(Object.prototype.hasOwnProperty.call(opts, "useLoggedInUser")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeWorkflow — NoDispatcherError rejects BEFORE any tmux side-effect
// ---------------------------------------------------------------------------

// Snapshot real modules before any mocks so we can restore in afterEach.
const _selfExecMod = await import("../lib/self-exec.ts");
const realSelfExecSnapshot = { ..._selfExecMod };
const _tmuxModForDispatch = await import("./tmux.ts");
const realTmuxSnapshotForDispatch = { ..._tmuxModForDispatch };

describe("executeWorkflow — resolver pre-flight", () => {
  // Track calls to tmux.createSession so we can assert it was never reached.
  let createSessionCallCount: number;

  beforeEach(() => {
    createSessionCallCount = 0;

    // Stub tmux module — any call to createSession increments the counter.
    // All other tmux functions are no-ops; they must never be reached anyway.
    mock.module("./tmux.ts", () => ({
      createSession: (..._args: unknown[]) => {
        createSessionCallCount++;
        return "%0";
      },
      isInsideAtomicSocket: () => false,
      isInsideTmux: () => false,
      switchClient: () => {},
      detachAndAttachAtomic: () => {},
      spawnMuxAttach: () => ({ on: () => {} }),
      capturePane: () => "",
      getPanePid: () => null,
      killSession: () => {},
      killWindow: () => Promise.resolve(),
      createWindow: () => "%1",
    }));

    // Mock resolveDispatcher to throw NoDispatcherError — simulates a
    // compiled-binary install where the SDK's own cli.ts isn't reachable
    // on disk (host-bun resolution fails) and no override was supplied.
    const searchedFor = ["@bastani/atomic-sdk/cli (host-bun)"] as const;

    mock.module("../lib/self-exec.ts", () => ({
      ...realSelfExecSnapshot,
      resolveDispatcher: () => {
        throw new NoDispatcherError({ searchedFor: [...searchedFor] });
      },
    }));
  });

  afterEach(() => {
    // Restore real implementations so subsequent test files are not affected.
    mock.module("../lib/self-exec.ts", () => realSelfExecSnapshot);
    mock.module("./tmux.ts", () => realTmuxSnapshotForDispatch);
  });

  /** Minimal valid WorkflowRunOptions — enough to reach the resolver call. */
  function makeMinimalOptions(): WorkflowRunOptions {
    return {
      definition: {
        __brand: "WorkflowDefinition",
        name: "test-workflow",
        agent: "claude",
        description: "test",
        source: "/fake/workflow.ts",
        inputs: [],
        minSDKVersion: null,
        run: async () => {},
      },
      agent: "claude",
      inputs: {},
      detach: true, // avoid tmux-attach logic; still hits createSession first
    };
  }

  test("rejects with NoDispatcherError when resolver throws", async () => {
    let caught: unknown;
    try {
      await executeWorkflow(makeMinimalOptions());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoDispatcherError);
  });

  test("rejected NoDispatcherError carries the searchedFor array from the resolver", async () => {
    let caught: unknown;
    try {
      await executeWorkflow(makeMinimalOptions());
    } catch (err) {
      caught = err;
    }
    const err = caught as NoDispatcherError;
    expect(err.searchedFor).toEqual(["@bastani/atomic-sdk/cli (host-bun)"]);
  });

  test("tmux.createSession is never called when the resolver throws", async () => {
    try {
      await executeWorkflow(makeMinimalOptions());
    } catch {
      // expected — we only care about the side-effect count
    }
    expect(createSessionCallCount).toBe(0);
  });
});
