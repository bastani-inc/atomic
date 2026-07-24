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
test("ChatSessionHost sends idle Enter through the canonical prompt command", async () => {
  const calls: string[] = [];
  let attached = 0;
  const host = makeHost({
    commands: {
      ensureAttached: async () => {
        attached += 1;
      },
      prompt: async (text) => {
        calls.push(text);
      },
    },
  });

  for (const ch of "hello") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(attached, 1);
  assert.deepEqual(calls, ["hello"]);
  assert.equal(host.inputText(), "");
  host.dispose();
});
test("ChatSessionHost steers via AgentSession.prompt while streaming", async () => {
  const promptCalls: Array<{ text: string; behavior: string | undefined }> = [];
  const agentSession = {
    isStreaming: true,
    prompt: async (text: string, opts?: { streamingBehavior?: string }) => {
      promptCalls.push({ text, behavior: opts?.streamingBehavior });
    },
  } as unknown as AgentSession;
  const host = makeHost({
    getAgentSession: () => agentSession,
    isStreaming: () => true,
  });

  for (const ch of "steer") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(promptCalls, [{ text: "steer", behavior: "steer" }]);
  host.dispose();
});
test("ChatSessionHost treats idle follow-up like normal submit", async () => {
  const prompts: string[] = [];
  const followUps: string[] = [];
  const host = makeHost({
    commands: {
      prompt: async (text) => {
        prompts.push(text);
      },
      followUp: async (text) => {
        followUps.push(text);
      },
    },
  });

  for (const ch of "idle") host.handleInput(ch);
  host.handleInput("\x06");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(prompts, ["idle"]);
  assert.deepEqual(followUps, []);
  host.dispose();
});
test("ChatSessionHost routes streaming follow-up and interrupt through shared chat commands", async () => {
  const followUps: string[] = [];
  let interrupts = 0;
  const host = makeHost({
    isStreaming: () => true,
    commands: {
      followUp: async (text) => {
        followUps.push(text);
      },
      interrupt: async () => {
        interrupts += 1;
      },
    },
  });

  for (const ch of "later") host.handleInput(ch);
  host.handleInput("\x06");
  host.handleInput("\x1b");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(followUps, ["later"]);
  assert.equal(interrupts, 1);
  host.dispose();
});
test("ChatSessionHost parses ! and !! bash commands without prompting", async () => {
  const bashCalls: Array<{ command: string; excludeFromContext: boolean }> = [];
  const prompts: string[] = [];
  const host = makeHost({
    commands: {
      prompt: async (text) => {
        prompts.push(text);
      },
      runBash: async (request) => {
        bashCalls.push({
          command: request.command,
          excludeFromContext: request.excludeFromContext,
        });
        request.onChunk("out");
        return {
          output: "out",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        };
      },
    },
  });

  for (const ch of "!pwd") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();
  for (const ch of "!!whoami") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(bashCalls, [
    { command: "pwd", excludeFromContext: false },
    { command: "whoami", excludeFromContext: true },
  ]);
  assert.deepEqual(prompts, []);
  assert.match(host.renderBody(80, 10).join("\n"), /pwd|whoami|out/);
  host.dispose();
});
test("ChatSessionHost reuses transcript render cache with fresh render settings", () => {
  interface CountEntry {
    role: "custom";
    text: string;
  }

  let renderCount = 0;
  const host = new ChatSessionHost<CountEntry>({
    style: plainStyle,
    editorTheme,
    getChatRenderSettings: () => ({ showImages: true }),
    renderExtraEntry: (entry) => ({
      render: () => {
        renderCount += 1;
        return [entry.text];
      },
      invalidate: () => {},
    }),
  });

  host.appendExtraEntry({ role: "custom", text: "first" });
  host.appendExtraEntry({ role: "custom", text: "second" });
  host.appendExtraEntry({ role: "custom", text: "third" });

  assert.deepEqual(host.renderBody(80, 1), ["third"]);
  assert.equal(renderCount, 3);
  assert.deepEqual(host.renderBody(80, 1), ["third"]);
  assert.equal(renderCount, 3);

  host.invalidate();

  assert.deepEqual(host.renderBody(80, 1), ["third"]);
  assert.equal(renderCount, 6);
  host.dispose();
});
test("ChatSessionHost preserves bare bang input as a normal prompt", async () => {
  const prompts: string[] = [];
  const host = makeHost({
    commands: {
      prompt: async (text) => {
        prompts.push(text);
      },
      runBash: async () => {
        throw new Error("should not run bash");
      },
    },
  });

  host.handleInput("!");
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(prompts, ["!"]);
  host.dispose();
});
test("ChatSessionHost rejects concurrent bash and restores the editor", async () => {
  const bashCalls: string[] = [];
  const host = makeHost({
    isBashRunning: () => true,
    commands: {
      runBash: async (request) => {
        bashCalls.push(request.command);
        return {
          output: "",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        };
      },
    },
  });

  for (const ch of "!pwd") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(bashCalls, []);
  assert.equal(host.inputText(), "!pwd");
  assert.match(host.statusText(), /bash command is already running/i);
  host.dispose();
});
test("ChatSessionHost escape aborts active bash", async () => {
  let abortCalls = 0;
  const host = makeHost({
    isBashRunning: () => true,
    commands: {
      abortBash: () => {
        abortCalls += 1;
      },
    },
  });

  host.handleInput("\x1b");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(abortCalls, 1);
  assert.match(host.statusText(), /cancelled/i);
  host.dispose();
});
test("ChatSessionHost holds queued messages in place before interrupting", async () => {
  let pauseQueueCalls = 0;
  let clearQueueCalls = 0;
  let interrupts = 0;
  const agentSession = {
    pauseQueuedMessages: () => {
      pauseQueueCalls += 1;
    },
    queuedMessagesPaused: false,
    resumeQueuedMessages: async () => false,
    clearQueue: () => {
      clearQueueCalls += 1;
    },
  } as unknown as AgentSession;
  const host = makeHost({
    getAgentSession: () => agentSession,
    isStreaming: () => true,
    commands: {
      interrupt: async () => {
        interrupts += 1;
      },
    },
  });

  host.applyAgentEvent({
    type: "queue_update",
    steering: ["steer one"],
    followUp: ["follow later"],
  } as never);
  for (const ch of "draft") host.handleInput(ch);
  await host.interrupt();

  assert.equal(pauseQueueCalls, 1);
  assert.equal(clearQueueCalls, 0);
  assert.equal(interrupts, 1);
  assert.equal(host.inputText(), "draft");
  assert.match(host.renderPendingMessages(80).join("\n"), /Steering: steer one/);
  assert.match(host.renderPendingMessages(80).join("\n"), /Follow-up: follow later/);
  host.dispose();
});
test("ChatSessionHost clears busy state when auto retry finishes unsuccessfully", () => {
  const host = makeHost();
  host.applyAgentEvent({ type: "auto_retry_start" } as never);
  assert.equal(host.isStreaming(), true);

  host.applyAgentEvent({
    type: "auto_retry_end",
    success: false,
    attempt: 2,
    finalError: "nope",
  } as never);

  assert.equal(host.isStreaming(), false);
  assert.equal(host.hasAnimationTick(), false);
  host.dispose();
});
test("ChatSessionHost keeps running bash entries in running state until completion", async () => {
  let resolveBash: ((value: {
    output: string;
    exitCode: number;
    cancelled: boolean;
    truncated: boolean;
  }) => void) | undefined;
  const host = makeHost({
    commands: {
      runBash: async (request) => {
        request.onChunk("partial");
        return await new Promise((resolve) => {
          resolveBash = resolve;
        });
      },
    },
  });

  for (const ch of "!sleep 1") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.match(host.renderBody(80, 10).join("\n"), /Running/);
  resolveBash?.({ output: "done", exitCode: 0, cancelled: false, truncated: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.doesNotMatch(host.renderBody(80, 10).join("\n"), /Running/);
  host.dispose();
});
test("ChatSessionHost dedupes repeated optimistic prompts independently", async () => {
  const host = makeHost({
    commands: {
      prompt: async () => {},
    },
  });

  for (const ch of "again") host.handleInput(ch);
  host.handleInput("\r");
  for (const ch of "again") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  host.applyAgentEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "again" }] } } as never);
  host.applyAgentEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "again" }] } } as never);

  const rendered = host.renderBody(80, 20).join("\n");
  assert.equal((rendered.match(/again/g) ?? []).length, 2);
  host.dispose();
});
test("ChatSessionHost does not swallow a later matching user event after prompt failure", async () => {
  const host = makeHost({
    commands: {
      prompt: async () => {
        throw new Error("prompt failed");
      },
    },
  });

  for (const ch of "yes") host.handleInput(ch);
  host.handleInput("\r");
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const changed = host.applyAgentEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "yes" }] } } as never);

  assert.equal(changed, true);
  host.dispose();
});
test("ChatSessionHost does not duplicate tool output echoed as a toolResult message", () => {
  const host = makeHost();
  const answerText = "User has answered your questions: \"What is your favorite color?\"=\"Blue\".";
  const echoedMessageText = `${answerText} echoed snapshot`;

  host.applyAgentEvent({
    type: "tool_execution_start",
    toolCallId: "ask-1",
    toolName: "ask_user_question",
    args: { questions: [] },
  } as never);
  host.applyAgentEvent({
    type: "tool_execution_end",
    toolCallId: "ask-1",
    toolName: "ask_user_question",
    result: { content: [{ type: "text", text: answerText }] },
    isError: false,
  } as never);
  host.applyAgentEvent({
    type: "message_start",
    message: {
      role: "toolResult",
      toolCallId: "ask-1",
      toolName: "ask_user_question",
      content: [{ type: "text", text: echoedMessageText }],
      isError: false,
    },
  } as never);

  const rendered = host.renderBody(100, 20).join("\n");
  assert.equal((rendered.match(/User has answered your questions/g) ?? []).length, 1);
  assert.match(rendered, /Blue/);
  assert.doesNotMatch(rendered, /echoed snapshot/);
  host.dispose();
});
test("ChatSessionHost tolerates malformed queue updates", () => {
  const host = makeHost();
  host.applyAgentEvent({ type: "queue_update" } as never);
  assert.doesNotThrow(() => host.renderPendingMessages(80));
  assert.deepEqual(host.renderPendingMessages(80), []);
  host.dispose();
});
test("ChatSessionHost queues prompts during compaction and flushes after success", async () => {
  const prompts: string[] = [];
  const followUps: string[] = [];
  const host = makeHost({
    getActionKeyDisplay: (action) => (action === "app.message.dequeue" ? "⌥↑" : action),
    commands: {
      prompt: async (text) => {
        prompts.push(text);
      },
      followUp: async (text) => {
        followUps.push(text);
      },
    },
  });

  host.applyAgentEvent({ type: "compaction_start", reason: "manual" } as never);
  for (const ch of "first") host.handleInput(ch);
  host.handleInput("\r");
  for (const ch of "second") host.handleInput(ch);
  host.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(prompts, []);
  assert.match(host.renderPendingMessages(80).join("\n"), /Queued: first|⌥↑/);

  host.applyAgentEvent({
    type: "compaction_end",
    reason: "manual",
    result: {},
    aborted: false,
    willRetry: false,
  } as never);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(prompts, ["first"]);
  assert.deepEqual(followUps, ["second"]);
  host.dispose();
});
