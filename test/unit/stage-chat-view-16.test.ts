import { test } from "bun:test";
import type { AgentSessionEvent } from "@bastani/atomic";
import {
  assert,
  createStore,
  deriveGraphTheme,
  flush,
  makeHandle,
  setupRun,
  StageChatView,
  stripAnsi,
  submitStageChatText,
} from "./stage-chat-view-helpers.js";

function renderText(view: StageChatView): string {
  return stripAnsi(view.render(96).join("\n"));
}

test("stage termination then prompt keeps Working visible through the new agent turn", async () => {
  const store = createStore();
  setupRun(store, "run-1", "stage-a", "running");
  const { handle, state, emit } = makeHandle();
  let releaseAttach!: () => void;
  let releasePrompt!: () => void;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  handle.ensureAttached = async () => {
    await attachGate;
  };
  handle.prompt = async (text) => {
    state.promptCalls.push(text);
    await promptGate;
  };
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

  try {
    assert.doesNotMatch(renderText(view), /Working/);
    emit({ type: "agent_start" } as AgentSessionEvent);
    assert.match(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, true);

    const runningStage = store.runs()[0]!.stages[0]!;
    store.recordStageEnd("run-1", {
      ...runningStage,
      status: "completed",
      endedAt: Date.now(),
      durationMs: 1,
    });
    assert.doesNotMatch(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, false);

    submitStageChatText(view, "keep spinner alive");

    assert.match(renderText(view), /keep spinner alive/);
    assert.match(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, true);
    assert.deepEqual(state.promptCalls, []);

    releaseAttach();
    await flush();
    assert.deepEqual(state.promptCalls, ["keep spinner alive"]);
    emit({ type: "agent_start" } as AgentSessionEvent);
    emit({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    } as AgentSessionEvent);
    assert.match(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, true);

    emit({
      type: "tool_execution_update",
      toolCallId: "read-1",
      partialResult: {
        content: [{ type: "text", text: "reading" }],
        details: {},
      },
    } as AgentSessionEvent);
    assert.match(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, true);

    releasePrompt();
    await flush();
    await flush();
    assert.match(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, true);

    emit({ type: "turn_end" } as AgentSessionEvent);
    emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
    await flush();
    assert.doesNotMatch(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, false);
  } finally {
    releaseAttach();
    releasePrompt();
    view.dispose();
  }
});

test("terminal stage prompt preflight settles without a stuck spinner when no turn starts", async () => {
  const store = createStore();
  setupRun(store, "run-1", "stage-a", "completed");
  const { handle, state } = makeHandle();
  let releaseAttach!: () => void;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  handle.ensureAttached = async () => {
    await attachGate;
  };
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

  try {
    submitStageChatText(view, "no turn starts");
    assert.match(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, true);

    releaseAttach();
    await flush();
    await flush();
    assert.deepEqual(state.promptCalls, ["no turn starts"]);
    assert.doesNotMatch(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, false);
  } finally {
    releaseAttach();
    view.dispose();
  }
});

test("terminal stage prompt failure clears the preflight spinner and timer", async () => {
  const store = createStore();
  setupRun(store, "run-1", "stage-a", "completed");
  const { handle } = makeHandle();
  let releaseAttach!: () => void;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  handle.ensureAttached = async () => {
    await attachGate;
  };
  handle.prompt = async () => {
    throw new Error("prompt rejected");
  };
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

  try {
    submitStageChatText(view, "failing prompt");
    assert.match(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, true);

    releaseAttach();
    await flush();
    await flush();
    assert.match(renderText(view), /prompt rejected/);
    assert.doesNotMatch(renderText(view), /Working/);
    assert.equal(view._hasAnimationTick, false);
  } finally {
    releaseAttach();
    view.dispose();
  }
});
