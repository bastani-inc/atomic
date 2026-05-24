import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { StageUiBroker, type StageCustomUiRequest } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

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

  test("host unregister rejects a pending custom UI request", async () => {
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
    unregister();

    await assert.rejects(pending, /custom UI host unregistered/);
    assert.equal(store.runs()[0]?.stages[0]?.status, "running");

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
