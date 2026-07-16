import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import {
  RESUME_CONTINUATION_PROMPT,
  createStageControlRegistry,
  createStore,
  deferred,
  mockSession,
  resumeRun,
  run,
  Type,
  workflow,
  type StageSessionRuntime,
} from "./executor-shared.js";

const RUN_ID = "wf-live-empty-resume-chain";
const INITIAL_PROMPT = "Produce the complete scope.";
const PARTIAL_TEXT = "Clean working tree. Let me inspect the remaining changes.";
const COMPLETE_TEXT = "Complete scope: all relevant workflow resume paths were inspected.";

describe("executor — live chain resume", () => {
  test("empty-message quit and resume completes the interrupted stage before durable handoff", async () => {
    const backend = new InMemoryDurableBackend();
    const registry = createStageControlRegistry();
    const store = createStore();
    const pauseAcknowledged = deferred();
    const stage1PromptCalls: string[] = [];
    const stage2PromptCalls: string[] = [];
    let stage1Text = PARTIAL_TEXT;
    let rejectInterruptedTurn: ((error: Error) => void) | undefined;
    let sessionIndex = 0;

    const stage1Session: StageSessionRuntime = {
      ...mockSession(),
      async prompt(text: string) {
        stage1PromptCalls.push(text);
        if (text === INITIAL_PROMPT) {
          await new Promise<void>((_resolve, reject) => {
            rejectInterruptedTurn = reject;
          });
          return;
        }
        if (text === RESUME_CONTINUATION_PROMPT) {
          stage1Text = COMPLETE_TEXT;
        }
      },
      async abort() {
        const reject = rejectInterruptedTurn;
        rejectInterruptedTurn = undefined;
        reject?.(new Error("AbortError"));
        pauseAcknowledged.resolve();
      },
      dispose() {},
      getLastAssistantText() { return stage1Text; },
    };

    const stage2Session: StageSessionRuntime = {
      ...mockSession(),
      sessionFile: "/tmp/atomic-1829-stage-2.ndjson",
      sessionId: "issue-1829-stage-2",
      isStreaming: false,
      async prompt(text: string) { stage2PromptCalls.push(text); },
      async abort() {},
      getLastAssistantText() { return `Stage 2 received: ${stage2PromptCalls.at(-1) ?? ""}`; },
    };

    const definition = workflow({
      name: "live-empty-resume-chain",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        const results = await ctx.chain([
          { name: "scope", prompt: INITIAL_PROMPT },
          { name: "downstream", prompt: "{previous}" },
        ]);
        return { result: results[1]!.text };
      },
    });

    const runPromise = run(definition, {}, {
      runId: RUN_ID,
      durableBackend: backend,
      store,
      stageControlRegistry: registry,
      confirmStageReadiness: async () => true,
      adapters: {
        agentSession: {
          async create() {
            sessionIndex += 1;
            return sessionIndex === 1 ? stage1Session : stage2Session;
          },
        },
      },
    });

    while (stage1PromptCalls.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const quit = quitRun(RUN_ID, { store, stageControlRegistry: registry });
    assert.equal(quit.ok, true);
    await pauseAcknowledged.promise;

    const resumed = resumeRun(RUN_ID, { store, stageControlRegistry: registry });
    assert.equal(resumed.ok, true);

    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(stage1PromptCalls, [INITIAL_PROMPT, RESUME_CONTINUATION_PROMPT]);
    assert.deepEqual(stage2PromptCalls, [COMPLETE_TEXT]);

    const scopeStage = store.runs()[0]?.stages.find((stage) => stage.name === "scope");
    assert.equal(scopeStage?.result, COMPLETE_TEXT);
    const durableScope = backend.getStageOutput(RUN_ID, "stage:task:scope:1");
    assert.equal(
      typeof durableScope === "object" && durableScope !== null && "text" in durableScope
        ? durableScope.text
        : undefined,
      COMPLETE_TEXT,
    );
    assert.equal(JSON.stringify(backend.listCheckpoints(RUN_ID)).includes(PARTIAL_TEXT), false);
    assert.equal(stage2PromptCalls.some((prompt) => prompt.includes(PARTIAL_TEXT)), false);
  });
});
