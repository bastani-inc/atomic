// @ts-nocheck
import { beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import {
  ChatSessionHost,
  type AgentSession,
  type ChatSessionHostOpts,
  type ChatSessionHostStyle,
} from "../../packages/coding-agent/src/index.ts";
import type { Component, EditorTheme } from "@earendil-works/pi-tui";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

beforeAll(() => {
  initTheme("dark", false);
});

const plainStyle: ChatSessionHostStyle = {
  dim: (text) => text,
  text: (text) => text,
  textMuted: (text) => text,
  accent: (text) => text,
  accentBold: (text) => text,
  rule: (_hex, text) => text,
  cursor: () => "▌",
  blank: (width) => " ".repeat(width),
  editorRuleColor: () => "#ffffff",
};

const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
    normal: (text: string) => text,
  },
} as EditorTheme;

function makeHost(
  overrides: Partial<ChatSessionHostOpts> = {},
): ChatSessionHost<never> {
  return new ChatSessionHost({
    style: plainStyle,
    editorTheme,
    ...overrides,
  });
}

test("ChatSessionHost clears busy state when model fallback fails", () => {
  const host = makeHost();
  host.applyAgentEvent({ type: "model_fallback_start", from: "a", to: "b", reason: "retryable", attempt: 1 } as never);
  assert.equal(host.isStreaming(), true);

  host.applyAgentEvent({
    type: "model_fallback_end",
    success: false,
    from: "a",
    to: "b",
    finalError: "fallback auth failed",
  } as never);

  assert.equal(host.isStreaming(), false);
  assert.equal(host.hasAnimationTick(), false);
  host.dispose();
});
test("ChatSessionHost preserves compaction queued messages when flush fails", async () => {
  const statusMessages: string[] = [];
  const host = makeHost({
    getActionKeyDisplay: (action) => (action === "app.message.dequeue" ? "⌥↑" : action),
    commands: {
      prompt: async () => {
        throw new Error("prompt unavailable");
      },
      followUp: async () => {},
    },
    showStatus: (message) => statusMessages.push(message),
  });

  host.applyAgentEvent({ type: "compaction_start", reason: "manual" } as never);
  for (const ch of "first") host.handleInput(ch);
  host.handleInput("\r");
  for (const ch of "second") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  host.applyAgentEvent({
    type: "compaction_end",
    reason: "manual",
    result: {},
    aborted: false,
    willRetry: false,
  } as never);
  await Promise.resolve();
  await Promise.resolve();

  const pending = host.renderPendingMessages(80).join("\n");
  assert.match(pending, /first/);
  assert.match(pending, /second/);
  assert.equal(host.restoreQueuedMessagesToEditor(), true);
  assert.equal(host.inputText(), "first\n\nsecond");
  assert.doesNotMatch(host.statusText(), /Restored .*queued message/);
  assert.deepEqual(
    statusMessages.filter((message) => /Restored .*queued message/.test(message)),
    [],
  );
  host.dispose();
});
test("ChatSessionHost delegates handled slash commands before prompt routing", async () => {
  const handled: string[] = [];
  const prompts: string[] = [];
  const host = makeHost({
    commands: {
      handleSlashCommand: async (text) => {
        handled.push(text);
        return true;
      },
      prompt: async (text) => {
        prompts.push(text);
      },
    },
  });

  for (const ch of "/compact now") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(handled, ["/compact now"]);
  assert.deepEqual(prompts, []);
  host.dispose();
});
test("ChatSessionHost renders extra entries through the supplied renderer even if they have a kind field", () => {
  type ExtraEntry = { role: "notice"; kind: "workflowNotice"; text: string };
  const host = new ChatSessionHost<ExtraEntry>({
    style: plainStyle,
    editorTheme,
    renderExtraEntry: (entry): Component => ({
      render: () => [`extra:${entry.kind}:${entry.text}`],
      invalidate: () => {},
    }),
  });

  host.appendExtraEntry({ role: "notice", kind: "workflowNotice", text: "hello" });

  assert.match(host.renderBody(80, 4).join("\n"), /extra:workflowNotice:hello/);
  host.dispose();
});
