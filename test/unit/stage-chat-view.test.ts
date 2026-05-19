/**
 * Unit tests for `StageChatView`.
 *
 * Verifies:
 *  - Idle stage: Enter sends `handle.prompt(text)`.
 *  - Running stage: Enter sends `handle.steer(text)`.
 *  - ctrl+f sends `handle.followUp(text)`.
 *  - Escape interrupts a streaming stage using the coding-agent chat contract.
 *  - After pause, Enter routes through `handle.resume(text)`.
 *  - Ctrl+D calls `onDetach`; Escape on inspect-only settled/Ctrl+C call `onClose`.
 *
 * cross-ref: src/tui/stage-chat-view.ts
 */

import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { CURSOR_MARKER, type EditorComponent } from "@earendil-works/pi-tui";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { initTheme, SessionManager, type AgentSession, type AgentSessionEvent } from "@bastani/atomic";

beforeAll(() => {
  initTheme("dark", false);
});

interface HandleState {
  promptCalls: Array<string>;
  steerCalls: Array<string>;
  followUpCalls: Array<string>;
  pauseCalls: number;
  resumeCalls: Array<string | undefined>;
  isStreaming: boolean;
}

function makeHandle(
  state: HandleState = {
    promptCalls: [],
    steerCalls: [],
    followUpCalls: [],
    pauseCalls: 0,
    resumeCalls: [],
    isStreaming: false,
  },
  messages: AgentSession["messages"] = [],
  status: StageControlHandle["status"] = "running",
  agentSession?: AgentSession,
): { handle: StageControlHandle; state: HandleState; emit: (event: AgentSessionEvent) => void } {
  let listener: ((e: AgentSessionEvent) => void) | undefined;
  let handleStatus = status;
  const handle: StageControlHandle = {
    runId: "run-1",
    stageId: "stage-a",
    stageName: "review-a",
    get status() {
      return handleStatus;
    },
    sessionId: undefined,
    sessionFile: undefined,
    get isStreaming() {
      return state.isStreaming;
    },
    messages,
    agentSession,
    async ensureAttached() {},
    async prompt(text: string) {
      state.promptCalls.push(text);
    },
    async steer(text: string) {
      state.steerCalls.push(text);
    },
    async followUp(text: string) {
      state.followUpCalls.push(text);
    },
    async pause() {
      state.pauseCalls += 1;
      handleStatus = "paused";
    },
    async resume(message?: string) {
      state.resumeCalls.push(message);
      handleStatus = "running";
    },
    subscribe(l) {
      listener = l;
      void listener; // silence unused
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    handle,
    state,
    emit: (event: AgentSessionEvent) => listener?.(event),
  };
}

function setupRun(
  store: ReturnType<typeof createStore>,
  runId: string,
  stageId: string,
  status: "pending" | "running" | "paused" | "blocked" | "completed" | "failed" = "running",
) {
  store.recordRunStart({
    id: runId,
    name: "test-wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  store.recordStageStart(runId, {
    id: stageId,
    name: "review-a",
    status,
    parentIds: [],
    toolEvents: [],
  });
}

async function flush(): Promise<void> {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

function fakeFooterAgentSession(isStreaming = false): AgentSession {
  return {
    state: {
      model: {
        id: "gpt-5.5",
        provider: "openai-codex",
        reasoning: true,
        contextWindow: 200000,
      },
      thinkingLevel: "high",
    },
    sessionManager: {
      getCwd: () => "/home/alilavaee/Documents/projects/atomic",
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 1200,
              output: 3400,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 4600,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 },
            },
          },
        },
      ],
    },
    modelRegistry: {
      isUsingOAuth: () => false,
    },
    getContextUsage: () => ({ tokens: 46800, contextWindow: 200000, percent: 23.4 }),
    isStreaming,
  } as unknown as AgentSession;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function assistantTextMessage(text: string): AgentSession["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("StageChatView", () => {
  test("header duration freezes while the stage is paused", () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 71_000;
      const store = createStore();
      store.recordRunStart({
        id: "run-1",
        name: "test-wf",
        inputs: {},
        status: "running",
        stages: [],
        startedAt: 1_000,
      });
      store.recordStageStart("run-1", {
        id: "stage-a",
        name: "review-a",
        status: "paused",
        parentIds: [],
        toolEvents: [],
        startedAt: 1_000,
        pausedAt: 11_000,
      });
      const { handle } = makeHandle(undefined, [], "paused");
      const view = new StageChatView({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageId: "stage-a",
        workflowName: "test-wf",
        handle,
        onDetach: () => {},
        onClose: () => {},
      });

      const rendered = stripAnsi(view.render(96).join("\n"));
      assert.match(rendered, /10s/);
      assert.doesNotMatch(rendered, /1m 10s/);
      view.dispose();
    } finally {
      Date.now = originalNow;
    }
  });

  test("uses coding-agent CustomEditor when pi overlay host objects are provided", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle, state } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      piTui: {
        requestRender: () => {},
        terminal: { rows: 40, columns: 96 },
      } as never,
      piKeybindings: makeFakeKeybindings(),
    });

    assert.match(view.render(96).join("\n"), /❯/);
    for (const ch of "hello") view.handleInput(ch);
    assert.equal(view._inputBuffer, "hello");
    assert.match(view.render(96).join("\n"), /hello/);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.promptCalls, ["hello"]);
    assert.equal(view._inputBuffer, "");
    view.dispose();
  });

  test("propagates focus to the nested pi editor for hardware cursor placement", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      piTui: {
        requestRender: () => {},
        terminal: { rows: 40, columns: 96 },
      } as never,
      piKeybindings: makeFakeKeybindings(),
    });

    assert.match(view.render(96).join("\n"), new RegExp(CURSOR_MARKER));
    view.focused = false;
    assert.doesNotMatch(view.render(96).join("\n"), new RegExp(CURSOR_MARKER));
    view.dispose();
  });

  test("inherits the host extension editor factory when provided", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle, state } = makeHandle();
    class ExtensionEditor implements EditorComponent {
      onSubmit?: (text: string) => void;
      onChange?: (text: string) => void;
      private text = "";
      getText(): string { return this.text; }
      setText(text: string): void { this.text = text; this.onChange?.(text); }
      handleInput(data: string): void {
        if (data === "\r" || data === "\n") {
          this.onSubmit?.(this.text);
          return;
        }
        this.text += data;
        this.onChange?.(this.text);
      }
      render(width: number): string[] { return [`EXT-EDITOR:${this.text}`.padEnd(width, " ")]; }
      invalidate(): void {}
    }
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      piTui: {
        requestRender: () => {},
        terminal: { rows: 40, columns: 96 },
      } as never,
      piKeybindings: makeFakeKeybindings(),
      piEditorFactory: () => new ExtensionEditor(),
    });

    assert.match(view.render(96).join("\n"), /EXT-EDITOR/);
    for (const ch of "hello") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.promptCalls, ["hello"]);
    view.dispose();
  });

  test("idle Enter calls handle.prompt", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle, state } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    for (const ch of "hello") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.promptCalls, ["hello"]);
    assert.equal(state.steerCalls.length, 0);
    view.dispose();
  });

  test("streaming Enter queues steering without clearing the live transcript", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, state, emit } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    });
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    } as unknown as AgentSessionEvent);
    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
      },
    } as unknown as AgentSessionEvent);

    for (const ch of "redirect") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();

    assert.deepEqual(state.steerCalls, ["redirect"]);
    assert.equal(state.promptCalls.length, 0);
    assert.equal(view._transcript.some((entry) => entry.role === "user" && entry.text === "redirect"), false);
    assert.equal(view._transcript.at(-1)?.role, "assistant");
    assert.equal(view._transcript.at(-1)?.text, "partial answer");

    emit({
      type: "queue_update",
      steering: ["redirect"],
      followUp: [],
    } as unknown as AgentSessionEvent);
    assert.match(stripAnsi(view.render(96).join("\n")), /Steering: redirect/);

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial answer continued" }],
      },
    } as unknown as AgentSessionEvent);
    assert.equal(view._transcript.at(-1)?.role, "assistant");
    assert.equal(view._transcript.at(-1)?.text, "partial answer continued");
    assert.equal(view._transcript.some((entry) => entry.role === "user" && entry.text === "redirect"), false);

    emit({ type: "queue_update", steering: [], followUp: [] } as unknown as AgentSessionEvent);
    emit({
      type: "message_start",
      message: { role: "user", content: "redirect" },
    } as unknown as AgentSessionEvent);
    emit({
      type: "message_end",
      message: { role: "user", content: "redirect" },
    } as unknown as AgentSessionEvent);
    assert.equal(view._transcript.filter((entry) => entry.role === "user" && entry.text === "redirect").length, 1);
    assert.doesNotMatch(stripAnsi(view.render(96).join("\n")), /Steering: redirect/);
    view.dispose();
  });

  test("streaming Enter uses AgentSession prompt steering when available", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const promptCalls: Array<{
      text: string;
      streamingBehavior: "steer" | "followUp" | undefined;
    }> = [];
    const agentSession = {
      isStreaming: true,
      prompt: async (
        text: string,
        options?: { streamingBehavior?: "steer" | "followUp" },
      ) => {
        promptCalls.push({ text, streamingBehavior: options?.streamingBehavior });
      },
    } as unknown as AgentSession;
    const { handle, state } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    }, [], "running", agentSession);
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    for (const ch of "redirect") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(promptCalls, [{ text: "redirect", streamingBehavior: "steer" }]);
    assert.deepEqual(state.steerCalls, []);
    assert.deepEqual(state.promptCalls, []);
    assert.equal(view._transcript.some((entry) => entry.role === "user" && entry.text === "redirect"), false);
    view.dispose();
  });

  test("streaming UI state steers even if the handle has not caught up", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, state, emit } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: false,
    });
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    emit({ type: "agent_start" } as unknown as AgentSessionEvent);
    for (const ch of "redirect") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.steerCalls, ["redirect"]);
    assert.deepEqual(state.promptCalls, []);
    view.dispose();
  });

  test("ctrl+f variants send a follow-up", async () => {
    const ctrlFVariants = ["\x06", "\x1b[102;5u", "\x1b[102;5:1u", "\x1b[27;5;102~"];

    for (const key of ctrlFVariants) {
      const store = createStore();
      setupRun(store, "run-1", "stage-a");
      const { handle, state } = makeHandle();
      const view = new StageChatView({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageId: "stage-a",
        workflowName: "test-wf",
        handle,
        onDetach: () => {},
        onClose: () => {},
      });
      for (const ch of "afterwards") view.handleInput(ch);
      view.handleInput(key);
      await flush();
      await flush();
      assert.deepEqual(state.followUpCalls, ["afterwards"], JSON.stringify(key));
      view.dispose();
    }
  });

  test("Escape interrupts a pending streaming stage without replacing the chat UI", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle, state } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    }, [], "pending");
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    view.handleInput("\x1b");
    await flush();
    await flush();
    assert.equal(state.pauseCalls, 1);
    assert.equal(view._isLocalPaused, true);
    const rendered = view.render(96).join("\n");
    assert.doesNotMatch(rendered, /PAUSED/);
    assert.doesNotMatch(rendered, /type a message to resume/i);
    assert.match(rendered, /❯/);
    view.dispose();
  });

  test("Enter on an initially paused stage resumes with the typed message", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "paused");
    const { handle, state } = makeHandle(undefined, [], "paused");
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    for (const ch of "go on") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.resumeCalls, ["go on"]);
    assert.deepEqual(state.promptCalls, []);
    assert.deepEqual(state.steerCalls, []);
    view.dispose();
  });

  test("idle attached stage renders no welcome panel and keeps a cursor in the editor", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    const rendered = view.render(96).join("\n");
    assert.doesNotMatch(rendered, /Attached to/);
    assert.doesNotMatch(rendered, /This stage is idle/);
    assert.doesNotMatch(rendered, /type a message to start this stage/i);
    assert.match(rendered, /❯/);
    assert.match(rendered, /\x1b\[7m \x1b\[0m/);
    view.dispose();
  });

  test("live pi editor path renders an empty composer without placeholder text", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      piTui: {
        requestRender: () => {},
        terminal: { rows: 40, columns: 96 },
      } as never,
      piKeybindings: makeFakeKeybindings(),
    });
    const emptyRendered = view.render(96).join("\n");
    assert.match(emptyRendered, /❯/);
    assert.doesNotMatch(emptyRendered, /type a message to start this stage/i);
    for (const ch of "hello") view.handleInput(ch);
    const rendered = view.render(96).join("\n");
    assert.match(rendered, /hello/);
    assert.doesNotMatch(rendered, /type a message to start this stage/i);
    view.dispose();
  });

  test("renders pi-style spacing between a full transcript and the streaming loader", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "running");
    const messages = Array.from({ length: 30 }, (_, i) => assistantTextMessage(`msg-${i}`));
    const { handle } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    }, messages);
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    const lines = view.render(96).map(stripAnsi);
    const workingIndex = lines.findIndex((line) => line.includes("Working"));
    assert.ok(workingIndex > 1, "expected working spinner after transcript");
    const previousContent = lines.slice(0, workingIndex).findLast((line) => line.trim() !== "");
    assert.match(previousContent ?? "", /msg-\d+/);
    assert.equal(lines[workingIndex - 1]?.trim(), "");
    assert.match(lines[workingIndex] ?? "", /^\s+\S Working/);
    view.dispose();
  });

  test("attached live sessions render the usage ribbon above the chatbox and only the coding-agent footer below it", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "running");
    const { handle } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    });
    const handleWithSession: StageControlHandle = {
      ...handle,
      agentSession: fakeFooterAgentSession(true),
    };
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle: handleWithSession,
      footerData: {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 2,
        onBranchChange: () => () => {},
      },
      onDetach: () => {},
      onClose: () => {},
    });
    const lines = view.render(120).map(stripAnsi);
    const rendered = lines.join("\n");
    assert.match(rendered, /\$0\.123/);
    assert.match(rendered, /23\.4%\/200k/);
    assert.match(rendered, /Working/);
    assert.doesNotMatch(rendered, /╌/);

    const workingIndex = lines.findIndex((line) => line.includes("Working"));
    const usageIndex = lines.findIndex((line) => line.includes("$0.123"));
    const promptIndex = lines.findIndex((line) => line.includes("❯"));
    const identityIndex = lines.findIndex((line) => line.includes("esc to interrupt"));
    const commandsIndex = lines.findIndex((line) => line.includes("esc pause"));
    assert.ok(workingIndex >= 0, "expected working spinner line");
    assert.ok(usageIndex > workingIndex, "expected usage below working line");
    assert.ok(promptIndex > usageIndex, "expected composer below usage line");
    assert.equal(identityIndex, promptIndex + 2);
    assert.equal(commandsIndex, -1);
    assert.doesNotMatch(lines[identityIndex] ?? "", /steer|follow-up/);
    assert.doesNotMatch(rendered, /pageup\/pagedown|ctrl\+d|follow-up|steer/);
    view.dispose();
  });

  test("Enter after Escape pause sends handle.resume(text)", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, state } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    });
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    view.handleInput("\x1b");
    await flush();
    await flush();
    assert.equal(view._isLocalPaused, true);
    for (const ch of "go on") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.resumeCalls, ["go on"]);
    assert.equal(view._isLocalPaused, false);
    view.dispose();
  });

  test("blocked Enter is a no-op", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    store.recordStageBlocked("run-1", "stage-a", "review-a");
    const { handle, state } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    });
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    for (const ch of "ignored") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.promptCalls, []);
    assert.deepEqual(state.steerCalls, []);
    assert.deepEqual(state.resumeCalls, []);
    assert.equal(view._inputBuffer, "");
    assert.match(view.render(80).join("\n"), /BLOCKED/);
    view.dispose();
  });

  test("Ctrl+D variants call onDetach", () => {
    const ctrlDVariants = [
      "\x04",
      "\x1b[100;5u",
      "\x1b[100;5:1u",
      "\x1b[27;5;100~",
    ];

    for (const key of ctrlDVariants) {
      const store = createStore();
      setupRun(store, "run-1", "stage-a");
      const { handle } = makeHandle();
      let detached = 0;
      const view = new StageChatView({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageId: "stage-a",
        workflowName: "test-wf",
        handle,
        onDetach: () => {
          detached += 1;
        },
        onClose: () => {},
      });
      view.handleInput(key);
      assert.equal(detached, 1, JSON.stringify(key));
      view.dispose();
    }
  });

  test("Ctrl+D variants close a paused stage chat", () => {
    const ctrlDVariants = [
      "\x04",
      "\x1b[100;5u",
      "\x1b[100;5:1u",
      "\x1b[27;5;100~",
    ];

    for (const key of ctrlDVariants) {
      const store = createStore();
      setupRun(store, "run-1", "stage-a", "paused");
      const { handle } = makeHandle(undefined, [], "paused");
      let detached = 0;
      let closed = 0;
      const view = new StageChatView({
        store,
        graphTheme: deriveGraphTheme({}),
        runId: "run-1",
        stageId: "stage-a",
        workflowName: "test-wf",
        handle,
        onDetach: () => {
          detached += 1;
        },
        onClose: () => {
          closed += 1;
        },
      });
      view.handleInput(key);
      assert.equal(closed, 1, JSON.stringify(key));
      assert.equal(detached, 0, JSON.stringify(key));
      view.dispose();
    }
  });

  test("Escape variants and Ctrl+C variants on settled stages call onClose", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "completed");
    let closed = 0;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      onDetach: () => {},
      onClose: () => {
        closed += 1;
      },
    });
    const closeKeys = [
      "\x1b",
      "\x1b[27u",
      "\x1b[27;1;27~",
      "\x03",
      "\x1b[99;5u",
      "\x1b[99;5:1u",
      "\x1b[27;5;99~",
    ];
    for (const key of closeKeys) {
      view.handleInput(key);
    }
    assert.equal(closed, closeKeys.length);
    view.dispose();
  });

  test("completed stages with a live handle keep the normal chat composer", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "completed");
    const { handle, state } = makeHandle(undefined, [], "completed");
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    const rendered = view.render(96).join("\n");
    assert.match(rendered, /❯/);
    assert.match(rendered, /\x1b\[7m \x1b\[0m/);
    assert.doesNotMatch(rendered, /COMPLETED/);
    assert.doesNotMatch(rendered, /stage settled/);

    for (const ch of "new question") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.promptCalls, ["new question"]);
    view.dispose();
  });

  test("Escape interrupts a completed stage ad-hoc chat without closing or workflow pause UI", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "completed");
    const { handle, state } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    }, [], "completed");
    let closed = 0;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {
        closed += 1;
      },
    });

    view.handleInput("\x1b");
    await flush();
    await flush();
    assert.equal(state.pauseCalls, 1);
    assert.equal(closed, 0);
    assert.equal(store.runs()[0]?.stages[0]?.status, "completed");
    const rendered = view.render(96).join("\n");
    assert.doesNotMatch(rendered, /PAUSED/);
    assert.match(rendered, /❯/);
    view.dispose();
  });

  test("Escape closes a non-streaming stage chat instead of entering workflow pause UI", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "running");
    const { handle, state } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: false,
    }, [], "running");
    let closed = 0;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {
        closed += 1;
      },
    });

    view.handleInput("\x1b");
    await flush();
    await flush();
    assert.equal(state.pauseCalls, 0);
    assert.equal(view._isLocalPaused, false);
    assert.equal(closed, 1);
    view.dispose();
  });

  test("inherits custom message renderers from parent chat settings", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const customMessage: AgentSession["messages"][number] = {
      role: "custom",
      customType: "workflow-note",
      content: "custom rendered from SDK history",
      display: true,
      timestamp: Date.now(),
    };
    const { handle } = makeHandle(undefined, [customMessage]);
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      getChatRenderSettings: () => ({
        getCustomMessageRenderer: () => () => ({
          render: () => ["PARENT-CUSTOM-RENDERER"],
          invalidate: () => {},
        }),
      }),
    });
    assert.match(view.render(96).join("\n"), /PARENT-CUSTOM-RENDERER/);
    view.dispose();
  });

  test("updates inherited chat settings without remounting", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const assistantMessage: AgentSession["messages"][number] = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private chain" }],
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
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const { handle } = makeHandle(undefined, [assistantMessage]);
    let hidden = false;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      getChatRenderSettings: () => ({
        hideThinkingBlock: hidden,
        hiddenThinkingLabel: "Parent hidden thinking",
      }),
    });

    assert.match(view.render(96).join("\n"), /private chain/);
    hidden = true;
    const rendered = view.render(96).join("\n");
    assert.match(rendered, /Parent hidden thinking/);
    assert.doesNotMatch(rendered, /private chain/);
    view.dispose();
  });

  test("inherits hidden thinking settings from parent chat settings", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const assistantMessage: AgentSession["messages"][number] = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private chain" }],
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
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const { handle } = makeHandle(undefined, [assistantMessage]);
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      getChatRenderSettings: () => ({
        hideThinkingBlock: true,
        hiddenThinkingLabel: "Parent hidden thinking",
      }),
    });
    const rendered = view.render(96).join("\n");
    assert.match(rendered, /Parent hidden thinking/);
    assert.doesNotMatch(rendered, /private chain/);
    view.dispose();
  });

  test("renders custom SDK snapshot messages instead of crashing", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const customMessage: AgentSession["messages"][number] = {
      role: "custom",
      customType: "workflow-note",
      content: "custom rendered from SDK history",
      display: true,
      timestamp: Date.now(),
    };
    const { handle } = makeHandle(undefined, [customMessage]);
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    const text = view.render(96).join("\n");
    assert.match(text, /custom rendered from SDK history/);
    view.dispose();
  });

  test("loads persisted session messages when reopening a settled stage without a live handle", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "completed");
    const sessionDir = mkdtempSync(join(tmpdir(), "atomic-stage-session-"));
    const manager = SessionManager.create(process.cwd(), sessionDir);
    const userMessage: Parameters<SessionManager["appendMessage"]>[0] = {
      role: "user",
      content: [{ type: "text", text: "persisted prompt" }],
      timestamp: Date.now(),
    };
    const assistantMessage: Parameters<SessionManager["appendMessage"]>[0] = {
      role: "assistant",
      content: [{ type: "text", text: "persisted answer" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    manager.appendMessage(userMessage);
    manager.appendMessage(assistantMessage);
    const sessionFile = manager.getSessionFile();
    assert.equal(typeof sessionFile, "string");
    store.recordStageSession("run-1", "stage-a", {
      sessionId: manager.getSessionId(),
      sessionFile,
    });

    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      onDetach: () => {},
      onClose: () => {},
    });

    const rendered = view.render(96).join("\n");
    assert.match(rendered, /persisted prompt/);
    assert.match(rendered, /persisted answer/);
    assert.doesNotMatch(rendered, /pi-workflows\/test-wf\/review-a/);
    view.dispose();
  });

  test("reopens persisted tool calls with their original arguments", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "completed");
    const sessionDir = mkdtempSync(join(tmpdir(), "atomic-stage-session-tools-"));
    const manager = SessionManager.create(process.cwd(), sessionDir);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo persisted" } }],
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
    } as Parameters<SessionManager["appendMessage"]>[0]);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "persisted\n" }],
      isError: false,
      timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0]);
    store.recordStageSession("run-1", "stage-a", {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
    });

    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      onDetach: () => {},
      onClose: () => {},
    });

    const rendered = view.render(96).join("\n");
    assert.match(rendered, /\$ echo persisted/);
    assert.doesNotMatch(rendered, /\$ \.\.\./);
    assert.match(rendered, /persisted/);
    view.dispose();
  });

  test("requests render and accumulates SDK assistant text deltas", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    let renders = 0;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      requestRender: () => { renders += 1; },
    });

    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
      message: { role: "assistant", content: [{ type: "text", text: "hel" }] },
    } as unknown as AgentSessionEvent);
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    } as unknown as AgentSessionEvent);

    assert.equal(renders, 2);
    assert.equal(view._transcript.at(-1)?.text, "hello");
    assert.match(view.render(96).join("\n"), /hello/);
    view.dispose();
  });

  test("renders assistant markdown like the pi chat", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "# Plan\n\n- **Read** files\n- Use `rg`" }],
      },
    } as unknown as AgentSessionEvent);

    const rendered = view.render(96).join("\n");
    assert.match(rendered, /Plan/);
    assert.match(rendered, /Read/);
    assert.match(rendered, /rg/);
    assert.doesNotMatch(rendered, /# Plan/);
    assert.doesNotMatch(rendered, /\*\*Read\*\*/);
    view.dispose();
  });

  test("requests render and accumulates SDK thinking deltas", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    let renders = 0;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      requestRender: () => { renders += 1; },
    });

    emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "reason" },
      message: { role: "assistant", content: [] },
    } as unknown as AgentSessionEvent);
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "ing" },
      message: { role: "assistant", content: [] },
    } as unknown as AgentSessionEvent);

    assert.equal(renders, 2);
    assert.equal(view._transcript.at(-1)?.role, "thinking");
    assert.equal(view._transcript.at(-1)?.text, "reasoning");
    view.dispose();
  });

  test("maps full SDK assistant message snapshots and tool calls", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    } as unknown as AgentSessionEvent);
    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", id: "t-snapshot", name: "read", arguments: { path: "src/index.ts" } },
        ],
      },
    } as unknown as AgentSessionEvent);

    assert.equal(view._transcript.some((entry) => entry.role === "thinking" && entry.text === "checking"), true);
    assert.equal(view._transcript.some((entry) => entry.role === "assistant" && entry.text === "I will inspect it."), true);
    assert.equal(view._transcript.some((entry) => entry.role === "tool" && entry.toolCallId === "t-snapshot"), true);
    assert.match(view.render(96).join("\n"), /I will inspect it/);
    assert.match(view.render(96).join("\n"), /read/);
    view.dispose();
  });

  test("deduplicates locally submitted user messages echoed by SDK", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    for (const ch of "hello") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    emit({
      type: "message_start",
      message: { role: "user", content: "hello" },
    } as unknown as AgentSessionEvent);
    assert.equal(view._transcript.filter((entry) => entry.role === "user" && entry.text === "hello").length, 1);
    view.dispose();
  });

  test("agent lifecycle starts and stops the Pi-style animation tick", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    assert.equal(view._hasAnimationTick, false);
    emit({ type: "agent_start" } as unknown as AgentSessionEvent);
    assert.equal(view._hasAnimationTick, true);
    emit({ type: "agent_end" } as unknown as AgentSessionEvent);
    assert.equal(view._hasAnimationTick, false);
    view.dispose();
  });

  test("Escape pauses streaming stages instead of closing", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, state } = makeHandle({
      promptCalls: [],
      steerCalls: [],
      followUpCalls: [],
      pauseCalls: 0,
      resumeCalls: [],
      isStreaming: true,
    });
    let closed = 0;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => { closed += 1; },
    });
    view.handleInput("\x1b");
    await flush();
    await flush();
    assert.equal(state.pauseCalls, 1);
    assert.equal(closed, 0);
    view.dispose();
  });

  test("tracks SDK tool execution events by toolCallId", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    let renders = 0;
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      requestRender: () => { renders += 1; },
    });

    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } } as unknown as AgentSessionEvent);
    assert.equal(view._transcript.at(-1)?.role, "tool");
    assert.equal(view._transcript.at(-1)?.text.includes("bash"), true);

    emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }], details: {} },
      isError: false,
    } as unknown as AgentSessionEvent);

    assert.equal(renders, 2);
    const entry = view._transcript.at(-1);
    assert.equal(entry?.role, "tool");
    assert.equal(entry?.text.includes("ok"), true);
    const renderedLines = view.render(96);
    assert.match(renderedLines.join("\n"), /ok/);
    const toolLine = renderedLines.find((line) => line.includes("$ ls"));
    assert.notEqual(toolLine, undefined);
    view.dispose();
  });

  test("legacy workflow tool_call events preserve args in the tool block", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    emit({
      type: "tool_call",
      toolCallId: "legacy-1",
      name: "bash",
      args: { command: "echo legacy" },
    } as unknown as AgentSessionEvent);

    const rendered = stripAnsi(view.render(96).join("\n"));
    assert.match(rendered, /\$ echo legacy/);
    assert.doesNotMatch(rendered, /\$ \.\.\./);
    view.dispose();
  });

  test("renders toolcall_end call contents when workflow event snapshots are stale", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-stale", name: "bash", arguments: {} }],
      },
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t-stale", name: "bash", arguments: { command: "echo from-workflow" } },
      },
    } as unknown as AgentSessionEvent);
    emit({ type: "tool_execution_start", toolCallId: "t-stale", toolName: "bash" } as unknown as AgentSessionEvent);

    const rendered = stripAnsi(view.render(96).join("\n"));
    assert.match(rendered, /\$ echo from-workflow/);
    assert.doesNotMatch(rendered, /\$ \.\.\./);
    view.dispose();
  });

  test("marks pending tool rows as errors when assistant turn aborts", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 10" } } as unknown as AgentSessionEvent);
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "Operation aborted",
      },
    } as unknown as AgentSessionEvent);

    const entry = view._transcript.find((item) => item.role === "tool");
    assert.equal(entry?.role, "tool");
    assert.equal(entry?.state, "error");
    assert.equal(entry?.output, "Operation aborted");
    assert.match(view.render(96).join("\n"), /Operation aborted/);
    view.dispose();
  });

  test("uses pi SDK compaction event names for status and animation", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle, emit } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    emit({ type: "compaction_start", reason: "manual" } as unknown as AgentSessionEvent);
    assert.equal(view._hasAnimationTick, true);
    assert.match(view.render(96).join("\n"), /compacting context/);
    emit({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false } as unknown as AgentSessionEvent);
    assert.equal(view._hasAnimationTick, false);
    view.dispose();
  });

  test("renders the constant 32-line frame when no viewport provider is wired", () => {
    // Fallback path: direct unit renders without a host-provided
    // viewport accessor get the legacy VIEW_LINE_COUNT rectangle.
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    const lines = view.render(96);
    assert.equal(lines.length, 32);
    view.dispose();
  });

  test("expands the chat surface to the reported viewport row count", () => {
    // Full-screen overlay: when the host surfaces terminal.rows
    // through `getViewportRows`, the renderer must paint that many
    // lines so the popup fills the terminal.
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      getViewportRows: () => 44,
    });
    const lines = view.render(96);
    assert.equal(lines.length, 44);
    view.dispose();
  });

  test("transcript body grows with the viewport so more entries stay visible", async () => {
    // The transcript body is `viewportRows - HEADER - INPUT - FOOTER`.
    // A larger viewport must surface more transcript entries inside
    // the body band; the fixed 32-row default would clip them.
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle, state } = makeHandle();

    // Seed enough transcript entries that the 32-row body truncates; a
    // larger viewport must render strictly more message content even now
    // that Pi user-message boxes consume multiple terminal rows each.
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
      getViewportRows: () => 60,
    });
    for (let i = 0; i < 30; i++) {
      for (const ch of `msg-${i}`) view.handleInput(ch);
      view.handleInput("\r");
      await flush();
      await flush();
    }
    // Sanity: stub handle recorded each prompt.
    assert.equal(state.promptCalls.length, 30);

    const wideText = view.render(96).join("\n");
    const wideOccurrences = wideText.split("\n").filter((line) => line.includes("msg-")).length;
    const narrow = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });
    for (const entry of view._transcript) {
      for (const ch of entry.text) narrow.handleInput(ch);
      narrow.handleInput("\r");
      await flush();
      await flush();
    }
    const narrowOccurrences = narrow.render(96).join("\n").split("\n").filter((line) => line.includes("msg-")).length;
    assert.ok(wideOccurrences > narrowOccurrences, `expected wider viewport to show more entries (${wideOccurrences} <= ${narrowOccurrences})`);
    narrow.dispose();
    view.dispose();
  });

  test("PageUp and PageDown scroll attached chat history", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    for (let i = 0; i < 18; i++) {
      for (const ch of `scroll-msg-${i}`) view.handleInput(ch);
      view.handleInput("\r");
      await flush();
      await flush();
    }

    const bottomText = view.render(96).join("\n");
    assert.match(bottomText, /scroll-msg-17/);
    assert.doesNotMatch(bottomText, /scroll-msg-0/);
    assert.ok(view._lastBodyMaxScroll > 0);

    view.handleInput("\x1b[5~");
    const offsetAfterPageUp = view._bodyScrollFromBottom;
    const olderText = view.render(96).join("\n");
    assert.ok(offsetAfterPageUp > 0);
    assert.notEqual(olderText, bottomText);

    view.handleInput("\x1b[6~");
    view.render(96);
    assert.equal(view._bodyScrollFromBottom, 0);
    view.dispose();
  });

  test("mouse wheel scrolls history without typing SGR bytes into the editor", async () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a", "pending");
    const { handle } = makeHandle();
    const view = new StageChatView({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageId: "stage-a",
      workflowName: "test-wf",
      handle,
      onDetach: () => {},
      onClose: () => {},
    });

    for (let i = 0; i < 18; i++) {
      for (const ch of `wheel-msg-${i}`) view.handleInput(ch);
      view.handleInput("\r");
      await flush();
      await flush();
    }
    view.render(96);

    view.handleInput("\x1b[<64;10;10M");
    view.render(96);
    assert.ok(view._bodyScrollFromBottom > 0);

    const before = view._inputBuffer;
    view.handleInput("\x1b[<0;10;10M");
    assert.equal(view._inputBuffer, before);
    view.dispose();
  });
});
