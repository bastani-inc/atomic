import { test } from "bun:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { StageMessageAdmission } from "../../packages/workflows/src/runs/foreground/stage-runner-message-admission.js";
import { sendStageUserMessage } from "../../packages/workflows/src/runs/foreground/stage-runner-send-user-message.js";
import type { StageSessionEvent } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { makeMockSession } from "./stage-runner-helpers.js";

test("a tagged late replay end cannot clear current ownership", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const turns = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let promptStarts = 0;
  const actions: string[] = [];
  const consumed: string[] = [];
  const emit = (event: StageSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) {
      listener({ type: "agent_start", turnId: "replayed-turn" });
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async prompt(text) {
      const index = promptStarts++;
      consumed.push(text);
      actions.push("prompt");
      emit({ type: "agent_start", turnId: `current-${index}` });
      starts[index]?.resolve();
      await turns[index]?.promise;
    },
    async followUp(text) { actions.push("followUp"); consumed.push(text); },
    async steer(text) { actions.push("steer"); consumed.push(text); },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  await starts[0]!.promise;
  assert.equal(await send("second"), "followUp");

  emit({ type: "agent_end", turnId: "replayed-turn", messages: [] });
  assert.equal(await send("third"), "followUp");

  emit({ type: "agent_end", turnId: "current-0", messages: [] });
  const fourth = send("fourth");
  await starts[1]!.promise;
  turns[0]!.resolve();
  assert.equal(await first, "prompt");
  assert.equal(await send("during fourth"), "followUp");
  emit({ type: "agent_end", turnId: "current-1", messages: [] });
  turns[1]!.resolve();

  assert.equal(await fourth, "prompt");
  assert.equal(promptStarts, 2);
  assert.deepEqual(actions, ["prompt", "followUp", "followUp", "prompt", "followUp"]);
  assert.deepEqual(consumed, ["first", "second", "third", "fourth", "during fourth"]);
});

test("an untagged late replay end cannot clear current ownership", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const turns = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
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
      const index = promptStarts++;
      actions.push("prompt");
      consumed.push(text);
      emit({ type: "agent_start" });
      await turns[index]?.promise;
    },
    async followUp(text) { actions.push("followUp"); consumed.push(text); },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  assert.equal(await send("second"), "followUp");
  emit({ type: "agent_end", messages: [] });
  const third = send("third");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(promptStarts, 1);
  assert.deepEqual(actions, ["prompt", "followUp", "followUp"]);
  turns[0]!.resolve();
  turns[1]!.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(consumed, ["first", "second", "third"]);
});

test("an untagged replay without a later old end cannot consume the current end", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const allowCurrentEnd = Promise.withResolvers<void>();
  const currentEnded = Promise.withResolvers<void>();
  const finishBookkeeping = Promise.withResolvers<void>();
  const secondTurn = Promise.withResolvers<void>();
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let promptStarts = 0;
  const actions: string[] = [];
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
    async prompt() {
      const index = promptStarts++;
      actions.push("prompt");
      emit({ type: "agent_start" });
      starts[index]?.resolve();
      if (index === 0) {
        await allowCurrentEnd.promise;
        emit({ type: "agent_end" } as StageSessionEvent);
        currentEnded.resolve();
        await finishBookkeeping.promise;
        return;
      }
      await secondTurn.promise;
      emit({ type: "agent_end" } as StageSessionEvent);
    },
    async followUp() { actions.push("followUp"); },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  await starts[0]!.promise;
  assert.equal(await send("during"), "followUp");
  allowCurrentEnd.resolve();
  await currentEnded.promise;

  const afterEnd = send("after-end");
  await starts[1]!.promise;
  assert.equal(promptStarts, 2);
  finishBookkeeping.resolve();
  secondTurn.resolve();

  assert.equal(await first, "prompt");
  assert.equal(await afterEnd, "prompt");
  assert.deepEqual(actions, ["prompt", "followUp", "prompt"]);
});

test("an untagged end clears the sole tagged current generation", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const turns = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let promptStarts = 0;
  const actions: string[] = [];
  const emit = (event: StageSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async prompt() {
      const index = promptStarts++;
      actions.push("prompt");
      emit(index === 0 ? { type: "agent_start", turnId: "current" } : { type: "agent_start" });
      starts[index]?.resolve();
      await turns[index]?.promise;
    },
    async followUp() { actions.push("followUp"); },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  await starts[0]!.promise;
  assert.equal(await send("during"), "followUp");
  emit({ type: "agent_end", messages: [] });
  const afterEnd = send("after-end");
  await starts[1]!.promise;

  assert.equal(promptStarts, 2);
  assert.deepEqual(actions, ["prompt", "followUp", "prompt"]);
  turns[0]!.resolve();
  turns[1]!.resolve();
  await Promise.all([first, afterEnd]);
});

test("an authoritative start from a pre-existing async source releases admission", async () => {
  const source = new AsyncResource("adapter-events");
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const turn = Promise.withResolvers<void>();
  let promptStarts = 0;
  const actions: string[] = [];
  const emit = (event: StageSessionEvent): void => {
    source.runInAsyncScope(() => { for (const listener of listeners) listener(event); });
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt() { promptStarts += 1; actions.push("prompt"); await turn.promise; },
    async followUp() { actions.push("followUp"); },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  emit({ type: "agent_start", turnId: "current" });
  assert.equal(await send("second"), "followUp");
  assert.equal(promptStarts, 1);
  assert.deepEqual(actions, ["prompt", "followUp"]);
  turn.resolve();
  await first;
  source.emitDestroy();
});

test("an external untagged current end outranks an unmatched replay when current start is tagged", async () => {
  const source = new AsyncResource("adapter-events");
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const turns = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let promptStarts = 0;
  const emit = (event: StageSessionEvent): void => {
    source.runInAsyncScope(() => { for (const listener of listeners) listener(event); });
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) {
      listener({ type: "agent_start" });
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async prompt() {
      const index = promptStarts++;
      emit(index === 0 ? { type: "agent_start", turnId: "current" } : { type: "agent_start" });
      starts[index]?.resolve();
      await turns[index]?.promise;
    },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  await starts[0]!.promise;
  emit({ type: "agent_end", messages: [] });
  const afterEnd = send("after-end");
  await starts[1]!.promise;
  assert.equal(promptStarts, 2);
  turns[0]!.resolve();
  turns[1]!.resolve();
  await Promise.all([first, afterEnd]);
  source.emitDestroy();
});

test("a tagged end clears the sole current generation when its start omitted turnId", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const turns = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let promptStarts = 0;
  const emit = (event: StageSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt() {
      const index = promptStarts++;
      emit({ type: "agent_start" });
      starts[index]?.resolve();
      await turns[index]?.promise;
    },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  await starts[0]!.promise;
  emit({ type: "agent_end", turnId: "current", messages: [] });
  const afterEnd = send("after-end");
  await starts[1]!.promise;
  assert.equal(promptStarts, 2);
  turns[0]!.resolve();
  turns[1]!.resolve();
  await Promise.all([first, afterEnd]);
});

test("successful delivery settlement retains publicly owned turn until agent_end", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const actions: string[] = [];
  const emit = (event: StageSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async sendUserMessage(_content, options) {
      const action = options?.deliverAs ?? "prompt";
      actions.push(action);
      options?.__workflowDelivery?.delivered?.(action);
      if (action === "prompt") emit({ type: "agent_start", turnId: "current" });
    },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  assert.equal(await send("first"), "prompt");
  assert.equal(await send("second"), "followUp");
  assert.deepEqual(actions, ["prompt", "followUp"]);
  emit({ type: "agent_end", turnId: "current", messages: [] });
  admission.dispose();
});

test("a mismatched tagged stale end cannot clear the sole tagged owner", async () => {
  const listeners = new Set<(event: StageSessionEvent) => void>();
  const turn = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let promptStarts = 0;
  const actions: string[] = [];
  const emit = (event: StageSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const { session } = makeMockSession({
    get isStreaming() { return false; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt() {
      promptStarts += 1;
      actions.push("prompt");
      emit({ type: "agent_start", turnId: "new-owner" });
      started.resolve();
      await turn.promise;
    },
    async followUp() { actions.push("followUp"); },
  });
  const admission = new StageMessageAdmission();
  const send = (text: string) => admission.run((release) =>
    sendStageUserMessage(session, text, undefined, undefined, release, admission));

  const first = send("first");
  await started.promise;
  emit({ type: "agent_end", turnId: "old-owner", messages: [] });
  assert.equal(await send("during"), "followUp");
  assert.equal(promptStarts, 1);
  assert.deepEqual(actions, ["prompt", "followUp"]);
  emit({ type: "agent_end", turnId: "new-owner", messages: [] });
  turn.resolve();
  await first;
});
