import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { getMessageText } from "../../packages/coding-agent/test/suite/harness.ts";
import {
  assert,
  createStageControlRegistry,
  createStore,
  deferred,
  run,
  test,
  workflow,
} from "./executor-shared.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";

test("transient native release failure keeps durable workflow pause retryable", async () => {
  const harness = await createHarness();
  const unhandledRejections: object[] = [];
  const onUnhandledRejection: NodeJS.UnhandledRejectionListener = (reason) => {
    unhandledRejections.push(reason instanceof Object ? reason : new Error(String(reason)));
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const initialProviderStarted = deferred();
    harness.setResponses([
      async (_context, options) => {
        initialProviderStarted.resolve();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("release retry interrupted");
      },
      fauxAssistantMessage("runner-owned delivery accepted"),
      fauxAssistantMessage("native held delivery accepted"),
      fauxAssistantMessage("unexpected duplicate delivery"),
    ]);
    const registry = createStageControlRegistry();
    const store = createStore();
    const sawStage = deferred<{ runId: string; stageId: string }>();
    const definition = workflow({
      name: "pause-release-retry",
      description: "",
      inputs: {},
      outputs: {},
      run: async (ctx) => {
        await ctx.stage("retryable-pause").prompt("start retryable pause");
        return {};
      },
    });
    const runPromise = run(definition, {}, {
      adapters: { agentSession: { async create() { return harness.session; } } },
      store,
      stageControlRegistry: registry,
      onStageStart: (runId, stage) => sawStage.resolve({ runId, stageId: stage.id }),
    });
    const [{ runId, stageId }] = await Promise.all([sawStage.promise, initialProviderStarted.promise]);
    const handle = registry.get(runId, stageId);
    assert.ok(handle?.sendUserMessage);
    await handle.pause();

    await harness.session.steer("native work held through failed release");
    let runnerDeliverySettled = false;
    const runnerDelivery = handle.sendUserMessage("runner delivery held through failed release")
      .finally(() => { runnerDeliverySettled = true; });
    const releaseError = new Error("transient native release failure");
    const productionResume = harness.session.resumeQueuedMessages.bind(harness.session);
    let resumeAttempts = 0;
    harness.session.resumeQueuedMessages = async () => {
      resumeAttempts += 1;
      if (resumeAttempts === 1) throw releaseError;
      return productionResume();
    };

    await assert.rejects(handle.resume(), (error) => error === releaseError);
    const pausedRun = store.runs().find((candidate) => candidate.id === runId);
    assert.equal(handle.status, "paused");
    assert.equal(pausedRun?.status, "paused");
    assert.equal(pausedRun?.stages.find((stage) => stage.id === stageId)?.status, "paused");
    assert.equal(harness.session.queuedMessagesPaused, true);
    assert.equal(harness.session.agent.hasQueuedMessages(), false);
    assert.equal(runnerDeliverySettled, false);
    assert.equal(resumeAttempts, 1);

    await handle.resume();
    const [deliveryAction, result] = await Promise.all([runnerDelivery, runPromise]);
    await Bun.sleep(10);

    assert.equal(deliveryAction, "prompt");
    assert.equal(result.status, "completed");
    assert.equal(harness.session.queuedMessagesPaused, false);
    assert.equal(resumeAttempts, 2);
    assert.equal(harness.session.messages.filter(
      (message) => message.role === "user" && getMessageText(message) === "runner delivery held through failed release",
    ).length, 1);
    assert.equal(harness.session.messages.filter(
      (message) => message.role === "user" && getMessageText(message) === "native work held through failed release",
    ).length, 1);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    harness.cleanup();
  }
});
