import { describe } from "bun:test";
import {
  assert,
  createStore,
  deferred,
  RESUME_CONTINUATION_PROMPT,
  run,
  test,
  waitForPromptCall,
  workflow,
  type WorkflowDefinition,
} from "./executor-shared.js";
import type { StageContext } from "../../packages/workflows/src/shared/types.js";
import {
  newRecorder,
  runStreamingStage,
  streamingTurnSession,
  type QueuedMessageRecorder,
  type StreamingTurnSession,
} from "./executor-queued-message-helpers.js";

function capturedStageWorkflow(
  name: string,
  stageReady: PromiseWithResolvers<StageContext>,
): WorkflowDefinition {
  return workflow({
    name,
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => {
      const stage = ctx.stage("worker");
      stageReady.resolve(stage);
      await stage.prompt("go");
      return {};
    },
  });
}

async function runStageContextDelivery(input: {
  readonly workflowName: string;
  readonly session: StreamingTurnSession;
  readonly recorder: QueuedMessageRecorder;
  readonly deliver: (stage: StageContext) => Promise<void>;
}): Promise<void> {
  const stageReady = deferred<StageContext>();
  const runPromise = run(capturedStageWorkflow(input.workflowName, stageReady), {}, {
    adapters: { agentSession: { async create() { return input.session; } } },
    store: createStore(),
  });
  const stage = await stageReady.promise;
  await waitForPromptCall(input.recorder.promptCalls, "go");
  assert.equal(stage.isStreaming, true);

  await input.deliver(stage);
  input.session.finishTurn();

  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(input.recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
}

describe("executor — queued follow-up continuation delivery", () => {
  test("SDK-direct follow-up consumed at a turn boundary injects with the readiness gate disabled", async () => {
    const recorder = newRecorder();
    const session = streamingTurnSession(recorder);
    const { runPromise, handle } = await runStreamingStage({
      workflowName: "sdk-direct-follow-up-no-gate-wf",
      session,
      recorder,
      gateEnabled: false,
    });

    const agentSession = handle.agentSession;
    assert.ok(agentSession, "stage handle should expose the SDK AgentSession");
    await agentSession.prompt("check the changelog too", { streamingBehavior: "followUp" });
    assert.deepEqual(recorder.promptCalls, ["go"], "follow-up must remain queued until the turn boundary");
    session.finishTurn();

    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(recorder.sdkPromptCalls, [{ text: "check the changelog too", behavior: "followUp" }]);
    assert.deepEqual(recorder.followUpCalls, [], "SDK-direct delivery must bypass handle.followUp");
    assert.deepEqual(recorder.promptCalls, ["go", RESUME_CONTINUATION_PROMPT]);
  });

  test("ctx.followUp during streaming injects with the readiness gate disabled", async () => {
    const recorder = newRecorder();
    const session = streamingTurnSession(recorder);

    await runStageContextDelivery({
      workflowName: "ctx-follow-up-no-gate-wf",
      session,
      recorder,
      deliver: (stage) => stage.followUp("workflow-author follow-up"),
    });

    assert.deepEqual(recorder.followUpCalls, ["workflow-author follow-up"]);
  });

  test("ctx.sendUserMessage during streaming queues a follow-up and injects with the gate disabled", async () => {
    const recorder = newRecorder();
    const session = streamingTurnSession(recorder);

    await runStageContextDelivery({
      workflowName: "ctx-send-user-message-no-gate-wf",
      session,
      recorder,
      deliver: (stage) => stage.sendUserMessage("workflow-author user message"),
    });

    assert.deepEqual(recorder.sendUserMessageCalls, [
      { text: "workflow-author user message", behavior: "followUp" },
    ]);
  });

  test("the injected continuation prompt does not re-arm itself", async () => {
    const recorder = newRecorder();
    const session = streamingTurnSession(recorder);
    const { runPromise, handle } = await runStreamingStage({
      workflowName: "continuation-prompt-no-rearm-wf",
      session,
      recorder,
      gateEnabled: false,
    });

    const agentSession = handle.agentSession;
    assert.ok(agentSession);
    await agentSession.prompt("one SDK steer", { streamingBehavior: "steer" });
    session.finishTurn();

    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.equal(
      recorder.promptCalls.filter((text) => text === RESUME_CONTINUATION_PROMPT).length,
      1,
    );
  });

  test("pause then resume still does not inject when the readiness gate is disabled", async () => {
    const recorder = newRecorder();
    const session = streamingTurnSession(recorder);
    const { runPromise, handle } = await runStreamingStage({
      workflowName: "pause-resume-no-gate-wf",
      session,
      recorder,
      gateEnabled: false,
    });

    await handle.pause();
    await handle.resume();

    const result = await runPromise;
    assert.equal(result.status, "completed");
    assert.deepEqual(recorder.promptCalls, ["go"]);
  });
});
