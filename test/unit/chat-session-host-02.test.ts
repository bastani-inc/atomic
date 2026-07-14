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
import { createVerbatimCompactionMessage, VERBATIM_COMPACTION_PREFIX } from "../../packages/coding-agent/src/core/messages.ts";

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
test("ChatSessionHost refreshes successful compacted transcripts exactly once for every reason", () => {
  const details = {
    strategy: "verbatim-lines",
    rung: "planned",
    stats: {
      linesBefore: 4,
      linesDeleted: 1,
      linesKept: 3,
      rangeCount: 1,
      tokensBefore: 100,
      tokensAfter: 50,
      percentReduction: 50,
    },
  };
  const boundaryMessage = createVerbatimCompactionMessage(
    "[User]: retained",
    100,
    new Date(1).toISOString(),
    details,
  );
  const extensionLookalike = {
    role: "custom",
    customType: "compaction",
    content: [{ type: "text", text: `${VERBATIM_COMPACTION_PREFIX}extension host state` }],
    display: true,
    details,
    timestamp: 2,
  };

  for (const reason of ["manual", "threshold", "overflow"] as const) {
    const agentSession = { messages: [boundaryMessage, extensionLookalike] } as AgentSession;
    const host = makeHost({
      getAgentSession: () => agentSession,
      getCwd: () => process.cwd(),
      renderExtraEntry: (entry): Component => ({
        render: () => [`extra:${entry.text}`],
        invalidate: () => {},
      }),
    });
    host.appendMessages([{ role: "user", content: "pre-compaction", timestamp: 0 }] as never);
    host.appendExtraEntry({ role: "notice", kind: "workflowNotice", text: "preserved" } as never);
    const structuralExtra = { role: "system", kind: "system", text: "must survive" };
    host.appendExtraEntry(structuralExtra as never);

    host.applyAgentEvent({
      type: "compaction_end",
      reason,
      result: {},
      aborted: false,
      willRetry: false,
    } as never);

    const boundaries = host.entries().filter(
      (entry) => entry.role === "custom" && entry.kind === "custom" && entry.message.customType === "compaction",
    );
    assert.equal(boundaries.length, 2);
    assert.equal(host.renderBody(200, 20).join("\n").match(/✻ Context compacted/g)?.length, 1);
    assert.match(host.renderBody(200, 20).join("\n"), /extension host state/);
    assert.equal(host.entries().filter((entry) => entry.role === "notice").length, 1);
    assert.equal(host.entries().includes(structuralExtra), true);
    assert.match(host.renderBody(200, 20).join("\n"), /extra:must survive/);
    host.applyAgentEvent({
      type: "compaction_end",
      reason,
      result: {},
      aborted: false,
      willRetry: false,
    } as never);
    assert.equal(
      host.entries().filter(
        (entry) => entry.role === "custom" && entry.kind === "custom" && entry.message.customType === "compaction",
      ).length,
      2,
    );
    assert.equal(host.entries().includes(structuralExtra), true);
    assert.match(host.renderBody(200, 20).join("\n"), /extra:must survive/);
    assert.equal(host.renderBody(200, 20).join("\n").match(/✻ Context compacted/g)?.length, 1);
    assert.match(host.renderBody(200, 20).join("\n"), /extension host state/);
    host.dispose();
  }
});

test("ChatSessionHost does not refresh compacted transcripts for aborts or errors", () => {
  const agentSession = {
    messages: [{ role: "custom", customType: "compaction", content: "boundary", display: true, timestamp: 1 }],
  } as AgentSession;
  for (const event of [
    { type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false },
    { type: "compaction_end", reason: "overflow", result: {}, aborted: false, willRetry: false, errorMessage: "failed" },
  ]) {
    const host = makeHost({ getAgentSession: () => agentSession });
    host.appendMessages([{ role: "user", content: "unchanged", timestamp: 0 }] as never);
    host.applyAgentEvent(event as never);
    assert.equal(host.entries().filter((entry) => entry.role === "custom").length, 0);
    assert.equal(host.entries().filter((entry) => entry.role === "user").length, 1);
    host.dispose();
  }
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
