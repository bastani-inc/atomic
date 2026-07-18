import { test } from "bun:test";
import assert from "node:assert/strict";
import { StageMessageAdmission } from "../../packages/workflows/src/runs/foreground/stage-runner-message-admission.js";
import { sendStageUserMessage } from "../../packages/workflows/src/runs/foreground/stage-runner-send-user-message.js";
import type { StageSessionEvent } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { flushMicrotasks, makeMockSession } from "./stage-runner-helpers.js";

test("a late end for a synchronously replayed start cannot clear current ownership", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const firstTurn = Promise.withResolvers<void>();
  const secondTurn = Promise.withResolvers<void>();
  let promptStarts = 0;
  const actions: string[] = [];
  const consumed: string[] = [];
  const emit = (event: StageSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) {
      listener({ type: "agent_start" });
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async prompt(text) {
      promptStarts += 1;
      consumed.push(text);
      actions.push("prompt");
      emit({ type: "agent_start" });
      await (promptStarts === 1 ? firstTurn.promise : secondTurn.promise);
    },
    async followUp(text) {
      actions.push("followUp");
      consumed.push(text);
    },
    async steer(text) {
      actions.push("steer");
      consumed.push(text);
    },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  const second = send("second");
  assert.equal(await second, "followUp");
  emit({ type: "agent_end", messages: [] });
  const third = send("third");
  let thirdOutcome: string | undefined;
  void third.then((action) => { thirdOutcome = action; });
  await flushMicrotasks();

  const promptStartsWhileFirstActive = promptStarts;
  firstTurn.resolve();
  secondTurn.resolve();
  await Promise.all([first, third]);

  assert.equal(promptStartsWhileFirstActive, 1);
  assert.equal(thirdOutcome, "followUp");
  assert.deepEqual(actions, ["prompt", "followUp", "followUp"]);
  assert.deepEqual(consumed, ["first", "second", "third"]);
});
