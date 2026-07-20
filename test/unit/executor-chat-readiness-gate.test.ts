import { afterEach, describe } from "bun:test";
import {
  assert,
  createStageControlRegistry,
  createStore,
  mockSession,
  run,
  RESUME_CONTINUATION_PROMPT,
  sleep,
  stageUiBroker,
  test,
  Type,
  workflow,
  type CreateAgentSessionOptions,
  type StageSessionRuntime,
  type ToolDefinition,
} from "./executor-shared.js";
import { READINESS_GATE_ADVANCE_LABEL } from "../../packages/workflows/src/runs/foreground/executor.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { StageInputRequest, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

interface PendingReadiness {
  readonly runId: string;
  readonly stage: StageSnapshot;
  readonly request: StageInputRequest;
}

async function waitForReadiness(previousPromptId?: string): Promise<PendingReadiness> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    for (const runSnapshot of store.runs()) {
      const stage = runSnapshot.stages.find(
        (candidate) =>
          candidate.status === "awaiting_input" &&
          candidate.inputRequest?.kind === "readiness_gate" &&
          candidate.inputRequest.id !== previousPromptId,
      );
      if (stage?.inputRequest) {
        return { runId: runSnapshot.id, stage, request: stage.inputRequest };
      }
    }
    await sleep(5);
  }
  throw new Error("brokered readiness gate did not appear");
}

function chatSession(events: string[]): StageSessionRuntime {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  let lastAssistantText = "";

  return {
    ...mockSession(),
    async prompt(text: string) {
      if (text === "ask the user") {
        emit({ type: "tool_execution_start", toolCallId: "chat-call", toolName: "ask_user_question" });
        emit({
          type: "tool_execution_end",
          toolCallId: "chat-call",
          toolName: "ask_user_question",
          result: {
            details: {
              answers: [{ questionIndex: 0, question: "Continue?", kind: "chat", answer: "Chat about this" }],
              cancelled: false,
            },
          },
        });
        lastAssistantText = "Absolutely — here is the conversational response.";
        events.push(`assistant:${lastAssistantText}`);
      } else {
        events.push(`user-turn:${text}`);
        lastAssistantText = "Additional stage-chat response.";
        events.push(`assistant:${lastAssistantText}`);
      }
      emit({ type: "agent_end", messages: [] });
    },
    subscribe(listener) {
      const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
      listeners.add(typed);
      return () => listeners.delete(typed);
    },
    getLastAssistantText() {
      return lastAssistantText;
    },
  };
}

describe("executor — chat answer readiness integration", () => {
  afterEach(() => store.clear());

  test("chat acknowledgement -> Not ready -> stage chat -> re-gate -> Ready -> dependent", async () => {
    store.clear();
    const events: string[] = [];
    const registry = createStageControlRegistry();
    let sessionCount = 0;
    const definition = workflow({
      name: "chat-readiness-reproduction",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("interactive").prompt("ask the user");
        await ctx.stage("dependent").prompt("dependent work");
        return {};
      },
    });

    const runPromise = run(definition, {}, {
      store,
      stageControlRegistry: registry,
      usePromptNodesForUi: true,
      adapters: {
        agentSession: {
          async create() {
            sessionCount += 1;
            if (sessionCount === 1) return chatSession(events);
            return {
              ...mockSession(),
              async prompt() {
                events.push("dependent:completed");
              },
            };
          },
        },
      },
    });

    const firstGate = await waitForReadiness();
    assert.deepEqual(events, ["assistant:Absolutely — here is the conversational response."]);
    assert.equal(firstGate.stage.status, "awaiting_input");
    assert.equal(firstGate.request.kind, "readiness_gate");
    assert.equal(stageUiBroker.peekStagePrompt(firstGate.runId, firstGate.stage.id)?.id, firstGate.request.id);

    const notReady = firstGate.request.questions[0]?.options[1]?.label;
    assert.ok(notReady);
    assert.equal(
      stageUiBroker.answerStagePrompt(firstGate.runId, firstGate.stage.id, { optionLabels: [notReady] }, {
        answerSource: "workflow_tool",
      }),
      true,
    );
    await sleep(0);

    const handle = registry.get(firstGate.runId, firstGate.stage.id);
    assert.ok(handle, "interactive stage remains available for a genuine chat turn");
    await handle.prompt("Please explore one more point.");

    const secondGate = await waitForReadiness(firstGate.request.id);
    assert.deepEqual(events, [
      "assistant:Absolutely — here is the conversational response.",
      "user-turn:Please explore one more point.",
      "assistant:Additional stage-chat response.",
    ]);
    assert.equal(secondGate.stage.status, "awaiting_input");
    assert.equal(secondGate.request.kind, "readiness_gate");

    events.push("readiness:ready");
    assert.equal(
      stageUiBroker.answerStagePrompt(secondGate.runId, secondGate.stage.id, {
        optionLabels: [READINESS_GATE_ADVANCE_LABEL],
      }),
      true,
    );

    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(events.slice(-2), ["readiness:ready", "dependent:completed"]);
    const stages = store.runs()[0]!.stages;
    assert.deepEqual(stages.map((stage) => [stage.name, stage.status]), [
      ["interactive", "completed"],
      ["dependent", "completed"],
    ]);
    assert.equal(stages[0]?.inputRequest, undefined);
  });


  test("a follow-up-turn chat answer keeps re-brokering after Not ready", async () => {
    const localStore = createStore();
    const registry = createStageControlRegistry();
    const gateStages: string[] = [];
    const turns: string[] = [];
    const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
    const emit = (event: { type: string; [key: string]: unknown }): void => {
      for (const listener of [...listeners]) listener(event);
    };
    const session: StageSessionRuntime = {
      ...mockSession(),
      async prompt(text: string) {
        turns.push(text);
        if (text === "initial" || text === "chat-answer-turn") {
          const chat = text === "chat-answer-turn";
          const callId = chat ? "follow-up-chat" : "initial-option";
          emit({ type: "tool_execution_start", toolCallId: callId, toolName: "ask_user_question" });
          emit({
            type: "tool_execution_end",
            toolCallId: callId,
            toolName: "ask_user_question",
            result: {
              details: {
                answers: [{
                  questionIndex: 0,
                  question: "Continue?",
                  kind: chat ? "chat" : "option",
                  answer: chat ? "typed follow-up" : "structured choice",
                }],
                cancelled: false,
              },
            },
          });
        }
        emit({ type: "agent_end", messages: [] });
      },
      subscribe(listener) {
        const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
        listeners.add(typed);
        return () => listeners.delete(typed);
      },
    };
    const definition = workflow({
      name: "follow-up-chat-readiness",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("interactive").prompt("initial");
        await ctx.stage("dependent").prompt("dependent");
        return {};
      },
    });

    const result = await run(definition, {}, {
      store: localStore,
      stageControlRegistry: registry,
      adapters: { agentSession: { async create() { return session; } } },
      confirmStageReadiness: async ({ runId, stageId, stageName }) => {
        gateStages.push(stageName);
        if (gateStages.length <= 2) {
          const nextTurn = gateStages.length === 1 ? "chat-answer-turn" : "plain-turn";
          setTimeout(() => { void registry.get(runId, stageId)?.prompt(nextTurn); }, 0);
          return false;
        }
        return true;
      },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(gateStages, ["interactive", "interactive", "interactive"]);
    assert.deepEqual(turns, ["initial", "chat-answer-turn", "plain-turn", "dependent"]);
  });

  test("resume-continuation chat answers remain in the re-gate flow", async () => {
    const localStore = createStore();
    const registry = createStageControlRegistry();
    const gateStages: string[] = [];
    const turns: string[] = [];
    const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
    const emit = (event: { type: string; [key: string]: unknown }): void => {
      for (const listener of [...listeners]) listener(event);
    };
    const emitUserMessage = (text: string): void => emit({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    });
    const emitQuestionAnswer = (chat: boolean): void => {
      const callId = chat ? "continuation-chat" : "initial-option";
      emit({ type: "tool_execution_start", toolCallId: callId, toolName: "ask_user_question" });
      emit({
        type: "tool_execution_end",
        toolCallId: callId,
        toolName: "ask_user_question",
        result: {
          details: {
            answers: [{ kind: chat ? "chat" : "option", answer: chat ? "typed continuation" : "choice" }],
            cancelled: false,
          },
        },
      });
    };
    let continuationCount = 0;
    const session: StageSessionRuntime = {
      ...mockSession(),
      async prompt(text: string) {
        turns.push(text);
        if (text === "initial") emitQuestionAnswer(false);
        if (text === "arming-turn") {
          emitUserMessage("turn prompt");
          emitUserMessage("consumed queued message");
        }
        if (text === RESUME_CONTINUATION_PROMPT) {
          continuationCount += 1;
          if (continuationCount === 1) {
            emitQuestionAnswer(true);
            emitUserMessage("continuation prompt");
            emitUserMessage("queued during chat acknowledgement");
          }
        }
        emit({ type: "agent_end", messages: [] });
      },
      subscribe(listener) {
        const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
        listeners.add(typed);
        return () => listeners.delete(typed);
      },
    };
    const definition = workflow({
      name: "resume-continuation-chat-readiness",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("interactive").prompt("initial");
        await ctx.stage("dependent").prompt("dependent");
        return {};
      },
    });

    const result = await run(definition, {}, {
      store: localStore,
      stageControlRegistry: registry,
      adapters: { agentSession: { async create() { return session; } } },
      confirmStageReadiness: async ({ runId, stageId, stageName }) => {
        gateStages.push(stageName);
        if (gateStages.length <= 2) {
          const nextTurn = gateStages.length === 1 ? "arming-turn" : "plain-turn";
          setTimeout(() => { void registry.get(runId, stageId)?.prompt(nextTurn); }, 0);
          return false;
        }
        return true;
      },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(gateStages, ["interactive", "interactive", "interactive"]);
    assert.deepEqual(turns, [
      "initial",
      "arming-turn",
      RESUME_CONTINUATION_PROMPT,
      RESUME_CONTINUATION_PROMPT,
      "plain-turn",
      "dependent",
    ]);
  });
  test("terminal schema finalization does not reopen readiness", async () => {
    const gateStages: string[] = [];
    const definition = workflow({
      name: "schema-chat-finalization",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("schema", {
          schema: Type.Object({ approved: Type.Boolean() }),
        }).prompt("finalize");
        return {};
      },
    });

    const result = await run(definition, {}, {
      store,
      confirmStageReadiness: async ({ stageName }) => {
        gateStages.push(stageName);
        return true;
      },
      adapters: {
        agentSession: {
          async create(options: CreateAgentSessionOptions) {
            const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
            const structuredTool = options.customTools?.find(
              (tool): tool is ToolDefinition => tool.name === "structured_output",
            );
            assert.ok(structuredTool);
            return {
              ...mockSession(),
              async prompt() {
                for (const listener of listeners) {
                  listener({ type: "tool_execution_start", toolCallId: "chat", toolName: "ask_user_question" });
                  listener({
                    type: "tool_execution_end",
                    toolCallId: "chat",
                    toolName: "ask_user_question",
                    result: { details: { answers: [{ kind: "chat", answer: "Chat about this" }] } },
                  });
                }
                await structuredTool.execute(
                  "structured",
                  { approved: true },
                  undefined,
                  undefined,
                  {} as Parameters<ToolDefinition["execute"]>[4],
                );
              },
              subscribe(listener) {
                const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
                listeners.add(typed);
                return () => listeners.delete(typed);
              },
            };
          },
        },
      },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(gateStages, []);
  });
});
