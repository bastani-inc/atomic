import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

interface SentNotice {
  readonly content?: string;
  readonly details?: WorkflowLifecycleNoticeDetails;
}

function install() {
  const store = createStore();
  const sent: SentNotice[] = [];
  const unsubscribe = installWorkflowLifecycleNotifications({
    store,
    config: { enabled: true, notifyOn: ["completed", "failed"] },
    state: createWorkflowLifecycleNotificationState(),
    seedExisting: false,
    sendMessage(message) { sent.push(message as SentNotice); },
  });
  return { store, sent, unsubscribe };
}

describe("ctx.tool lifecycle notices", () => {
  test("real tool-only success emits exactly one completion without empty-graph text", async () => {
    const { store, sent, unsubscribe } = install();
    let calls = 0;
    const result = await run(workflow({
      name: "tool lifecycle success", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("publish-success", {}, async () => { calls += 1; return "ok"; });
        return {};
      },
    }), {}, { store, durableBackend: new InMemoryDurableBackend() });
    unsubscribe();

    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.kind, "completed");
    assert.doesNotMatch(sent[0]?.content ?? "", /without creating any workflow|empty.graph/i);
  });

  test("real tool failure emits one notice with original error and tool identity", async () => {
    const { store, sent, unsubscribe } = install();
    const result = await run(workflow({
      name: "tool lifecycle failure", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("publish-failure", {}, async () => { throw new Error("remote publish rejected"); });
        return {};
      },
    }), {}, { store, durableBackend: new InMemoryDurableBackend() });
    unsubscribe();

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /remote publish rejected/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.kind, "failed");
    assert.equal(sent[0]?.details?.toolName, "publish-failure");
    assert.equal(sent[0]?.details?.toolNodeId, result.toolNodes?.[0]?.id);
    assert.equal(sent[0]?.details?.failedStageId, undefined);
    assert.match(sent[0]?.content ?? "", /publish-failure.*remote publish rejected/);
    assert.equal(store.runs()[0]?.failedStageId, undefined);
  });
});
