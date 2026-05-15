/**
 * Unit tests for `StageChatView`.
 *
 * Verifies:
 *  - Idle stage: Enter sends `handle.prompt(text)`.
 *  - Running stage: Enter sends `handle.steer(text)`.
 *  - ctrl+f sends `handle.followUp(text)`.
 *  - ctrl+p triggers `handle.pause()` and flips localPaused.
 *  - After pause, Enter routes through `handle.resume(text)`.
 *  - Ctrl+D calls `onDetach`; Escape calls `onClose`.
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
import type { EditorComponent } from "@earendil-works/pi-tui";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { initTheme, SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";

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
): { handle: StageControlHandle; state: HandleState; emit: (event: AgentSessionEvent) => void } {
  let listener: ((e: AgentSessionEvent) => void) | undefined;
  const handle: StageControlHandle = {
    runId: "run-1",
    stageId: "stage-a",
    stageName: "review-a",
    status: "running",
    sessionId: undefined,
    sessionFile: undefined,
    get isStreaming() {
      return state.isStreaming;
    },
    messages,
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
    },
    async resume(message?: string) {
      state.resumeCalls.push(message);
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

describe("StageChatView", () => {
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

  test("running Enter calls handle.steer by default", async () => {
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
    for (const ch of "redirect") view.handleInput(ch);
    view.handleInput("\r");
    await flush();
    await flush();
    assert.deepEqual(state.steerCalls, ["redirect"]);
    assert.equal(state.promptCalls.length, 0);
    view.dispose();
  });

  test("ctrl+f sends a follow-up", async () => {
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
    view.handleInput("\x06");
    await flush();
    await flush();
    assert.deepEqual(state.followUpCalls, ["afterwards"]);
    view.dispose();
  });

  test("ctrl+p calls handle.pause and flips localPaused", async () => {
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
    view.handleInput("\x10");
    await flush();
    await flush();
    assert.equal(state.pauseCalls, 1);
    assert.equal(view._isLocalPaused, true);
    view.dispose();
  });

  test("Enter after pause sends handle.resume(text)", async () => {
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
    view.handleInput("\x10");
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

  test("Ctrl+D calls onDetach", () => {
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
    view.handleInput("\x04");
    assert.equal(detached, 1);
    view.dispose();
  });

  test("Escape calls onClose", () => {
    const store = createStore();
    setupRun(store, "run-1", "stage-a");
    const { handle } = makeHandle();
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
    assert.equal(closed, 1);
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
    assert.match(rendered, /2 messages/);
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

  test("Escape interrupts streaming stages instead of closing", async () => {
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
});
