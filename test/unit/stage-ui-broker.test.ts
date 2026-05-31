import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { StageUiBroker, type StageCustomUiRequest, type StagePromptResolvedEvent } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const COLOR_ARGS = {
  questions: [
    {
      question: "What is your favorite color?",
      options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
    },
  ],
};

type BuiltResult = {
  answers: Array<{ kind: string; answer: string | null }>;
  cancelled: boolean;
};

function setupStage() {
  const store = createStore();
  store.recordRunStart({
    id: "run-1",
    name: "wf",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
  });
  store.recordStageStart("run-1", {
    id: "stage-1",
    name: "ask",
    status: "running",
    parentIds: [],
    toolEvents: [],
  });
  return { store, broker: new StageUiBroker(store) };
}

describe("StageUiBroker", () => {
  test("uses collision-resistant request ids", async () => {
    const { broker } = setupStage();
    let requestId = "";
    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));
    const unregister = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        requestId = request.id;
        broker.resolve(request, "ok");
      },
    });

    assert.equal(await pending, "ok");
    assert.match(requestId, /^stage-ui-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    unregister();
  });

  test("rejects and clears duplicate pending custom UI requests", async () => {
    const { broker, store } = setupStage();
    const first = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));

    await assert.rejects(
      broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      })),
      /already has a pending custom UI request/,
    );
    assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");

    const unregister = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        broker.resolve(request, "first");
      },
    });
    assert.equal(await first, "first");
    assert.equal(store.runs()[0]?.stages[0]?.status, "running");
    unregister();
  });

  test("aborted requests reject, clear pending state, and notify mounted hosts", async () => {
    const { broker, store } = setupStage();
    const controller = new AbortController();
    let shownRequest: StageCustomUiRequest | undefined;
    let hiddenRequestId = "";
    const unregister = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        shownRequest = request;
      },
      hideCustomUi(request) {
        hiddenRequestId = request.id;
      },
    });
    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }), undefined, controller.signal);

    assert.ok(shownRequest);
    assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");
    controller.abort(new Error("cancelled by test"));

    await assert.rejects(pending, /cancelled by test/);
    assert.equal(hiddenRequestId, shownRequest.id);
    assert.equal(store.runs()[0]?.stages[0]?.status, "running");

    unregister();

    const afterAbort = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));
    const unregister2 = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        broker.resolve(request, "next");
      },
    });
    assert.equal(await afterAbort, "next");
    unregister2();
  });

  test("host unregister keeps the pending request and re-displays it on re-register", async () => {
    const { broker, store } = setupStage();
    let shownRequest: StageCustomUiRequest | undefined;
    const unregister = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        shownRequest = request;
      },
    });
    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));

    assert.ok(shownRequest);
    // Detaching the host stops *displaying* the request; it must NOT cancel it.
    // The stage stays awaiting_input and the request is re-displayed when a
    // host re-registers.
    unregister();
    assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");

    let reshown: StageCustomUiRequest | undefined;
    const unregisterNext = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        reshown = request;
      },
    });
    // The same still-pending request is shown again; answering it resolves the
    // ORIGINAL pending promise.
    assert.ok(reshown);
    assert.equal(reshown!.id, shownRequest!.id);
    broker.resolve(reshown!, "answered");
    assert.equal(await pending, "answered");
    assert.equal(store.runs()[0]?.stages[0]?.status, "running");
    unregisterNext();
  });

  test("request aborts if the signal flips while the host is being shown", async () => {
    const { broker, store } = setupStage();
    const controller = new AbortController();
    const unregister = broker.registerHost("run-1", "stage-1", {
      showCustomUi() {
        controller.abort(new Error("aborted during show"));
      },
    });

    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }), undefined, controller.signal);

    await assert.rejects(pending, /aborted during show/);
    assert.equal(store.runs()[0]?.stages[0]?.status, "running");
    unregister();
  });

  test("existing host show failures reject and clear pending custom UI requests", async () => {
    const { broker, store } = setupStage();
    const unregister = broker.registerHost("run-1", "stage-1", {
      showCustomUi() {
        throw new Error("show failed");
      },
    });

    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));

    await assert.rejects(pending, /show failed/);
    assert.equal(store.runs()[0]?.stages[0]?.status, "running");

    unregister();
    const next = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));
    const unregisterNext = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        broker.resolve(request, "next");
      },
    });
    assert.equal(await next, "next");
    unregisterNext();
  });

  test("registering a host that throws while showing rejects a queued request", async () => {
    const { broker, store } = setupStage();
    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));

    const unregister = broker.registerHost("run-1", "stage-1", {
      showCustomUi() {
        throw new Error("register show failed");
      },
    });

    await assert.rejects(pending, /register show failed/);
    assert.equal(store.runs()[0]?.stages[0]?.status, "running");
    unregister();
  });

  describe("headless answering", () => {
    test("answerStagePrompt resolves the pending request, surfaces the descriptor, and notifies listeners", async () => {
      const { broker, store } = setupStage();
      const adapter = buildStagePromptAdapter("prompt-1", "ask_user_question", COLOR_ARGS, 1)!;
      const resolved: StagePromptResolvedEvent[] = [];
      const unsubscribe = broker.onStagePromptResolved((event) => {
        resolved.push(event);
      });
      // Adapter is provided before the request (mirrors the executor watcher
      // firing on tool_execution_start ahead of ctx.ui.custom()).
      broker.provideStagePrompt("run-1", "stage-1", adapter);

      const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }));

      // Snapshot now exposes the structured prompt for `workflow send` / status.
      assert.deepEqual(broker.peekStagePrompt("run-1", "stage-1")?.id, "prompt-1");
      assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");
      assert.equal(store.runs()[0]?.stages[0]?.inputRequest?.id, "prompt-1");

      const ok = broker.answerStagePrompt("run-1", "stage-1", { text: "blue" });
      assert.equal(ok, true);

      const result = (await pending) as BuiltResult;
      assert.equal(result.cancelled, false);
      assert.equal(result.answers[0]!.kind, "option");
      assert.equal(result.answers[0]!.answer, "Blue");

      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]?.runId, "run-1");
      assert.equal(resolved[0]?.stageId, "stage-1");
      assert.equal(resolved[0]?.prompt.id, "prompt-1");
      assert.equal(resolved[0]?.prompt.kind, "ask_user_question");
      assert.equal(typeof resolved[0]?.answeredAt, "number");
      unsubscribe();

      // Resolution clears both the broker adapter and the snapshot descriptor,
      // while retaining the resolved prompt id so a raced duplicate headless
      // answer can be reported as already handled instead of as a missing
      // store pending prompt.
      assert.equal(broker.peekStagePrompt("run-1", "stage-1"), undefined);
      assert.equal(broker.wasStagePromptResolved("run-1", "stage-1", "prompt-1"), true);
      assert.equal(broker.wasStagePromptResolved("run-1", "stage-1", "other-prompt"), false);
      assert.equal(store.runs()[0]?.stages[0]?.status, "running");
      assert.equal(store.runs()[0]?.stages[0]?.inputRequest, undefined);
    });

    test("a new prompt clears the previously resolved prompt id", async () => {
      const { broker } = setupStage();
      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("old", "ask_user_question", COLOR_ARGS, 1)!);
      const oldPending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }));
      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Red" }), true);
      await oldPending;
      assert.equal(broker.wasStagePromptResolved("run-1", "stage-1", "old"), true);

      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("new", "ask_user_question", COLOR_ARGS, 1)!);
      assert.equal(broker.wasStagePromptResolved("run-1", "stage-1", "old"), false);
    });

    test("a repeated prompt id clears the prior resolved marker for a fresh gate", async () => {
      const { broker } = setupStage();
      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("same", "ask_user_question", COLOR_ARGS, 1)!);
      const firstPending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }));
      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Red" }), true);
      await firstPending;
      assert.equal(broker.wasStagePromptResolved("run-1", "stage-1", "same"), true);

      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("same", "ask_user_question", COLOR_ARGS, 1)!);
      assert.equal(broker.wasStagePromptResolved("run-1", "stage-1", "same"), false);

      const secondPending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }));
      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Blue" }), true);
      const result = (await secondPending) as BuiltResult;
      assert.equal(result.answers[0]!.answer, "Blue");
    });

    test("adapter provided after the request still answers and back-fills the descriptor", async () => {
      const { broker, store } = setupStage();
      const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }));
      // No adapter yet → nothing to peek/answer.
      assert.equal(broker.peekStagePrompt("run-1", "stage-1"), undefined);
      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Red" }), false);

      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!);
      assert.equal(store.runs()[0]?.stages[0]?.inputRequest?.id, "p");

      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Red" }), true);
      const result = (await pending) as BuiltResult;
      assert.equal(result.answers[0]!.answer, "Red");
    });

    test("answerStagePrompt is a no-op without a pending request", () => {
      const { broker, store } = setupStage();
      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!);
      // Descriptor recorded, but no ctx.ui.custom() request is pending yet.
      assert.equal(broker.peekStagePrompt("run-1", "stage-1"), undefined);
      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Red" }), false);
      assert.equal(store.runs()[0]?.stages[0]?.inputRequest?.id, "p");
    });

    test("clearStagePrompt removes the descriptor and disables answering", async () => {
      const { broker, store } = setupStage();
      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!);
      const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }));
      assert.equal(store.runs()[0]?.stages[0]?.inputRequest?.id, "p");

      broker.clearStagePrompt("run-1", "stage-1");
      assert.equal(store.runs()[0]?.stages[0]?.inputRequest, undefined);
      assert.equal(broker.peekStagePrompt("run-1", "stage-1"), undefined);
      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Red" }), false);

      // The underlying request is still pending and resolvable the normal way.
      const unregister = broker.registerHost("run-1", "stage-1", {
        showCustomUi(request) {
          broker.resolve(request, "manual");
        },
      });
      assert.equal(await pending, "manual");
      unregister();
    });

    test("rejecting or aborting a brokered prompt does not notify resolved listeners", async () => {
      const { broker } = setupStage();
      const controller = new AbortController();
      const resolved: StagePromptResolvedEvent[] = [];
      const unsubscribe = broker.onStagePromptResolved((event) => {
        resolved.push(event);
      });

      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!);
      const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }), undefined, controller.signal);
      controller.abort(new Error("cancelled"));

      await assert.rejects(pending, /cancelled/);
      assert.deepEqual(resolved, []);
      unsubscribe();
    });

    test("resolved listener unsubscribe prevents later notifications", async () => {
      const { broker } = setupStage();
      let calls = 0;
      const unsubscribe = broker.onStagePromptResolved(() => {
        calls += 1;
      });
      unsubscribe();

      broker.provideStagePrompt("run-1", "stage-1", buildStagePromptAdapter("p", "ask_user_question", COLOR_ARGS, 1)!);
      const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
        render: () => [],
        invalidate: () => {},
      }));

      assert.equal(broker.answerStagePrompt("run-1", "stage-1", { text: "Red" }), true);
      await pending;
      assert.equal(calls, 0);
    });
  });

  test("replacing a host hides stale mounted UI and routes pending request to the new host", async () => {
    const { broker } = setupStage();
    let staleHidden = false;
    let firstShowCount = 0;
    const pending = broker.requestCustomUi("run-1", "stage-1", () => ({
      render: () => [],
      invalidate: () => {},
    }));
    const unregisterFirst = broker.registerHost("run-1", "stage-1", {
      showCustomUi() {
        firstShowCount += 1;
      },
      hideCustomUi() {
        staleHidden = true;
        throw new Error("hide failed");
      },
    });
    const unregisterSecond = broker.registerHost("run-1", "stage-1", {
      showCustomUi(request) {
        broker.resolve(request, "new-host");
      },
    });

    assert.equal(firstShowCount, 1);
    assert.equal(staleHidden, true);
    assert.equal(await pending, "new-host");
    unregisterFirst();
    unregisterSecond();
  });
});
