import { test } from "bun:test";
import assert from "node:assert/strict";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";

test("stage-control prompt does not reject after handled input was authorized", async () => {
  const handlingStarted = Promise.withResolvers<void>();
  const finishHandling = Promise.withResolvers<void>();
  let terminal = false;
  let sideEffects = 0;
  const runtime = {
    runId: "run-handled-race",
    stageId: "stage-handled-race",
    name: "handled race",
    stageSnapshot: { status: "running", sessionId: "session-handled-race" },
    state: { liveHandleReleased: false },
    innerCtx: {
      __sessionMeta: () => ({ sessionId: "session-handled-race", sessionFile: undefined }),
      subscribe: () => () => {},
      async __sendUserMessage(_text: string, _options: undefined, beforeDelivery: () => void) {
        beforeDelivery();
        handlingStarted.resolve();
        await finishHandling.promise;
        sideEffects += 1;
        return "handled" as const;
      },
    },
    throwIfStageMutationBlocked() {
      if (terminal) throw new DOMException("workflow exited", "AbortError");
    },
    captureStageSessionMeta() {},
  };
  const handle = createStageControlHandle(runtime as never);

  const delivery = handle.prompt("handled input");
  await handlingStarted.promise;
  terminal = true;
  finishHandling.resolve();

  await delivery;
  assert.equal(sideEffects, 1);
});
