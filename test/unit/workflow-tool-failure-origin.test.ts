import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  registerLifecycleNoticeRenderer,
  type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

interface SentNotice {
  readonly content?: string;
  readonly details?: WorkflowLifecycleNoticeDetails;
}

interface CardComponent {
  render(width: number): string[];
}

function renderLifecycleCard(details: WorkflowLifecycleNoticeDetails): string {
  let renderer: ((payload: unknown) => unknown) | undefined;
  registerLifecycleNoticeRenderer({
    rendererHost: {},
    registerMessageRenderer(_event, registered) { renderer = registered as (payload: unknown) => unknown; },
  });
  assert.notEqual(renderer, undefined);
  return (renderer?.({ details }) as CardComponent).render(80).join("\n");
}

function installFailureNotices(store: ReturnType<typeof createStore>): { sent: SentNotice[]; unsubscribe: () => void } {
  const sent: SentNotice[] = [];
  const unsubscribe = installWorkflowLifecycleNotifications({
    store,
    config: { enabled: true, notifyOn: ["failed"] },
    state: createWorkflowLifecycleNotificationState(),
    seedExisting: false,
    sendMessage(message) { sent.push(message as SentNotice); },
  });
  return { sent, unsubscribe };
}

async function runImmediateFailures(firstError: unknown, secondError: unknown) {
  const store = createStore();
  const { sent, unsubscribe } = installFailureNotices(store);
  const result = await run(workflow({
    name: "ambiguous tool errors", description: "", inputs: {}, outputs: {},
    run: async (ctx) => {
      void ctx.tool("first-ambiguous", {}, async () => { throw firstError; });
      void ctx.tool("second-ambiguous", {}, async () => { throw secondError; });
      return {};
    },
  }), {}, { store });
  unsubscribe();
  return { result, sent, store };
}

async function runSimultaneousSameValueFailures(shared: unknown) {
  const awaitedEntered = Promise.withResolvers<void>();
  const laterEntered = Promise.withResolvers<void>();
  const awaitedRelease = Promise.withResolvers<void>();
  const laterRelease = Promise.withResolvers<void>();
  const store = createStore();
  const { sent, unsubscribe } = installFailureNotices(store);
  const pending = run(workflow({
    name: "simultaneous same-value failures", description: "", inputs: {}, outputs: {},
    run: async (ctx) => {
      const awaited = ctx.tool("awaited-first", {}, async () => {
        awaitedEntered.resolve();
        await awaitedRelease.promise;
        throw shared;
      });
      void ctx.tool("later-unawaited", {}, async () => {
        laterEntered.resolve();
        await laterRelease.promise;
        throw shared;
      });
      await awaited;
      return {};
    },
  }), {}, { store });

  await Promise.all([awaitedEntered.promise, laterEntered.promise]);
  awaitedRelease.resolve();
  laterRelease.resolve();
  const result = await pending;
  unsubscribe();
  return { result, sent, store };
}


async function runCaughtThenThrowSameValue(shared: unknown) {
  const store = createStore();
  const { sent, unsubscribe } = installFailureNotices(store);
  const result = await run(workflow({
    name: "independent same-value body failure", description: "", inputs: {}, outputs: {},
    run: async (ctx) => {
      try {
        await ctx.tool("caught-same-value", {}, async () => { throw shared; });
      } catch {}
      throw shared;
    },
  }), {}, { store });
  unsubscribe();
  return { result, sent, store };
}


describe("ctx.tool failure origin", () => {
  test("multiple failures attribute the selected first admission independent of settlement order", async () => {
    const store = createStore();
    const { sent, unsubscribe } = installFailureNotices(store);
    const persisted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        persisted.push({ type, payload });
        return `entry-${persisted.length}`;
      },
      setLabel(_entryId: string, _label: string): void {},
    };
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    const pending = run(workflow({
      name: "selected tool origin", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        void ctx.tool("first-admitted", {}, async () => { await firstRelease.promise; throw new Error("FIRST_ERROR"); });
        void ctx.tool("second-admitted", {}, async () => { await secondRelease.promise; throw new Error("SECOND_ERROR"); });
        return {};
      },
    }), {}, { store, persistence });

    secondRelease.resolve();
    await Bun.sleep(0);
    firstRelease.resolve();
    const result = await pending;
    unsubscribe();

    const firstNodeId = result.toolNodes?.[0]?.id;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /FIRST_ERROR/);
    assert.equal(store.runs()[0]?.failedToolNodeId, firstNodeId);
    const inspection = inspectRun(result.runId, { store });
    assert.equal(inspection.ok && inspection.detail.failedToolNodeId, firstNodeId);
    assert.equal(result.failedToolNodeId, firstNodeId);
    const runEnd = persisted.find((entry) => entry.type === "workflow.run.end");
    assert.equal(runEnd?.payload["failedToolNodeId"], firstNodeId);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.toolNodeId, firstNodeId);
    assert.equal(sent[0]?.details?.toolName, "first-admitted");
    assert.match(sent[0]?.content ?? "", /tool first-admitted.*FIRST_ERROR/);
    assert.doesNotMatch(sent[0]?.content ?? "", /second-admitted/);
    const card = renderLifecycleCard(sent[0]!.details!);
    assert.match(card, /tool\s+first-admitted/);
    assert.match(card, /FIRST_ERROR/);
    assert.doesNotMatch(card, /second-admitted|SECOND_ERROR/);
  });

  test("duplicate error messages do not confuse selected tool identity", async () => {
    const { result, sent, store } = await runImmediateFailures(new Error("duplicate"), new Error("duplicate"));
    assert.equal(store.runs()[0]?.failedToolNodeId, result.toolNodes?.[0]?.id);
    assert.equal(sent[0]?.details?.toolName, "first-ambiguous");
    assert.match(sent[0]?.content ?? "", /tool first-ambiguous.*duplicate/);
  });

  test("a reused Error object does not confuse selected tool identity", async () => {
    const shared = new Error("shared rejection");
    const { result, sent, store } = await runImmediateFailures(shared, shared);
    assert.equal(store.runs()[0]?.failedToolNodeId, result.toolNodes?.[0]?.id);
    assert.equal(sent[0]?.details?.toolName, "first-ambiguous");
  });

  test("a non-Error rejection retains the selected tool identity", async () => {
    const { result, sent, store } = await runImmediateFailures("raw rejection", "later raw rejection");
    assert.equal(store.runs()[0]?.failedToolNodeId, result.toolNodes?.[0]?.id);
    assert.equal(sent[0]?.details?.toolName, "first-ambiguous");
    assert.match(sent[0]?.content ?? "", /tool first-ambiguous.*raw rejection/);
  });


  test("reused Error failures omit an ambiguous catch-path tool origin", async () => {
    const shared = new Error("shared awaited rejection");
    const store = createStore();
    const { sent, unsubscribe } = installFailureNotices(store);
    const result = await run(workflow({
      name: "reused awaited error", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        try {
          await ctx.tool("first-caught", {}, async () => { throw shared; });
        } catch {}
        await ctx.tool("second-uncaught", {}, async () => { throw shared; });
        return {};
      },
    }), {}, { store });
    unsubscribe();

    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolName, undefined);
    assert.equal(sent[0]?.details?.toolNodeId, undefined);
    assert.match(sent[0]?.content ?? "", /shared awaited rejection/);
    assert.doesNotMatch(sent[0]?.content ?? "", /tool (first-caught|second-uncaught)/);
  });

  test("reused primitive failures omit an ambiguous catch-path tool origin", async () => {
    const shared = "shared primitive rejection";
    const store = createStore();
    const { sent, unsubscribe } = installFailureNotices(store);
    const result = await run(workflow({
      name: "reused awaited primitive", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        try {
          await ctx.tool("first-primitive", {}, async () => { throw shared; });
        } catch {}
        await ctx.tool("second-primitive", {}, async () => { throw shared; });
        return {};
      },
    }), {}, { store });
    unsubscribe();

    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolName, undefined);
    assert.equal(sent[0]?.details?.toolNodeId, undefined);
    assert.match(sent[0]?.content ?? "", /shared primitive rejection/);
    assert.doesNotMatch(sent[0]?.content ?? "", /tool (first-primitive|second-primitive)/);
  });

  test("an ordinary awaited tool rejection omits terminal tool origin", async () => {
    const shared = new Error("shared concurrent rejection");
    const firstRelease = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const store = createStore();
    const pending = run(workflow({
      name: "reused concurrent error", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        void ctx.tool("first-delayed", {}, async () => {
          await firstRelease.promise;
          throw shared;
        });
        await ctx.tool("second-awaited", {}, async () => {
          secondEntered.resolve();
          throw shared;
        });
        return {};
      },
    }), {}, { store });

    await secondEntered.promise;
    await Bun.sleep(0);
    assert.deepEqual(store.runs()[0]?.toolNodes?.map((node) => [node.name, node.status]), [
      ["first-delayed", "running"],
      ["second-awaited", "failed"],
    ]);
    firstRelease.resolve();
    const result = await pending;

    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
  });


  test("already-observed same-value failures omit an ambiguous tool origin", async () => {
    const shared = new Error("shared observation order");
    const awaitedEntered = Promise.withResolvers<void>();
    const awaitedRelease = Promise.withResolvers<void>();
    const store = createStore();
    const { sent, unsubscribe } = installFailureNotices(store);
    const pending = run(workflow({
      name: "reused observation order", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        const awaited = ctx.tool("awaited-first", {}, async () => {
          awaitedEntered.resolve();
          await awaitedRelease.promise;
          throw shared;
        });
        void ctx.tool("later-unawaited", {}, async () => { throw shared; });
        await awaited;
        return {};
      },
    }), {}, { store });

    await awaitedEntered.promise;
    await Bun.sleep(0);
    assert.deepEqual(store.runs()[0]?.toolNodes?.map((node) => [node.name, node.status]), [
      ["awaited-first", "running"],
      ["later-unawaited", "failed"],
    ]);
    awaitedRelease.resolve();
    const result = await pending;
    unsubscribe();

    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolName, undefined);
    assert.equal(sent[0]?.details?.toolNodeId, undefined);
    assert.match(sent[0]?.content ?? "", /shared observation order/);
    assert.doesNotMatch(sent[0]?.content ?? "", /tool (awaited-first|later-unawaited)/);
  });

  for (const [label, shared] of [
    ["Error", new Error("same-turn shared rejection")],
    ["primitive", "same-turn shared rejection"],
  ] as const) {
    test(`same-turn ${label} failures omit an ambiguous catch-path tool origin`, async () => {
      const { result, sent, store } = await runSimultaneousSameValueFailures(shared);

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /same-turn shared rejection/);
      assert.deepEqual(result.toolNodes?.map((node) => [node.name, node.status]), [
        ["awaited-first", "failed"],
        ["later-unawaited", "failed"],
      ]);
      assert.equal(result.failedToolNodeId, undefined);
      assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
      assert.equal(sent[0]?.details?.toolNodeId, undefined);
      assert.equal(sent[0]?.details?.toolName, undefined);
      assert.doesNotMatch(sent[0]?.content ?? "", /tool (awaited-first|later-unawaited)/);
    });
  }
  test("catching and rethrowing the same rejection cannot prove terminal tool origin", async () => {
    const shared = new Error("rethrow same rejection");
    const store = createStore();
    const result = await run(workflow({
      name: "same rejection rethrow", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        try {
          await ctx.tool("rethrow-origin", {}, async () => { throw shared; });
        } catch (error) {
          throw error;
        }
        return {};
      },
    }), {}, { store });

    assert.match(result.error ?? "", /rethrow same rejection/);
    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
  });
  test("an independent body throw reusing a caught tool Error has no tool origin", async () => {
    const { result, sent, store } = await runCaughtThenThrowSameValue(new Error("independent shared Error"));

    assert.match(result.error ?? "", /independent shared Error/);
    assert.deepEqual(result.toolNodes?.map((node) => [node.name, node.status]), [["caught-same-value", "failed"]]);
    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolName, undefined);
    assert.doesNotMatch(sent[0]?.content ?? "", /tool caught-same-value/);
  });
  test("an independent body throw reusing a caught tool primitive has no tool origin", async () => {
    const { result, sent, store } = await runCaughtThenThrowSameValue("independent shared primitive");

    assert.match(result.error ?? "", /independent shared primitive/);
    assert.equal(result.toolNodes?.[0]?.status, "failed");
    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolName, undefined);
    assert.doesNotMatch(sent[0]?.content ?? "", /tool caught-same-value/);
  });
  test("an uncaught body error has no false origin from a caught failed tool", async () => {
    const store = createStore();
    const { sent, unsubscribe } = installFailureNotices(store);
    const result = await run(workflow({
      name: "body precedence", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        try {
          await ctx.tool("caught-unrelated", {}, async () => { throw new Error("tool loses"); });
        } catch {}
        throw new Error("body wins");
      },
    }), {}, { store });
    unsubscribe();

    assert.match(result.error ?? "", /body wins/);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolName, undefined);
    assert.doesNotMatch(sent[0]?.content ?? "", /caught-unrelated/);
  });

  test("a selected stage failure keeps stage origin and excludes an unrelated failed tool", async () => {
    const store = createStore();
    const { sent, unsubscribe } = installFailureNotices(store);
    const result = await run(workflow({
      name: "stage precedence", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        try {
          await ctx.tool("caught-before-stage", {}, async () => { throw new Error("tool loses"); });
        } catch {}
        await ctx.stage("selected-stage").prompt("fail");
        return {};
      },
    }), {}, {
      store,
      adapters: { prompt: { prompt: async () => { throw new Error("stage wins"); } } },
    });
    unsubscribe();

    const snapshot = store.runs()[0];
    assert.match(result.error ?? "", /stage wins/);
    assert.equal(snapshot?.failedStageId, snapshot?.stages[0]?.id);
    assert.equal(snapshot?.failedToolNodeId, undefined);
    assert.equal(sent[0]?.details?.toolNodeId, undefined);
    assert.equal(sent[0]?.details?.stageName, "selected-stage");
    assert.match(sent[0]?.content ?? "", /stage selected-stage.*stage wins/);
  });

  test("workflow API validation failure has no false origin from a caught failed tool", async () => {
    const store = createStore();
    const result = await run(workflow({
      name: "validation precedence", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        try {
          await ctx.tool("caught-before-validation", {}, async () => { throw new Error("tool loses"); });
        } catch {}
        await ctx.workflow({} as never);
        return {};
      },
    }), {}, { store });

    assert.match(result.error ?? "", /requires a workflow definition/i);
    assert.equal(result.failedToolNodeId, undefined);
    assert.equal(store.runs()[0]?.failedToolNodeId, undefined);
  });


  test("child ordinary tool rejection stays visible while the parent uses its failed boundary", async () => {
    const store = createStore();
    const child = workflow({
      name: "tool-failed-child", description: "", inputs: {}, outputs: {},
      run: async (ctx) => {
        await ctx.tool("child-failure", {}, async () => { throw new Error("child publish failed"); });
        return {};
      },
    });
    const parent = workflow({
      name: "tool-failed-parent", description: "", inputs: {}, outputs: {},
      run: async (ctx) => { await ctx.workflow(child, { stageName: "child-boundary" }); return {}; },
    });
    const result = await run(parent, {}, { store });

    const parentSnapshot = store.runs().find((candidate) => candidate.id === result.runId);
    const childSnapshot = store.runs().find((candidate) => candidate.parentRunId === result.runId);
    assert.equal(childSnapshot?.failedToolNodeId, undefined);
    assert.equal(parentSnapshot?.failedStageId, parentSnapshot?.stages[0]?.id);
    assert.equal(parentSnapshot?.failedToolNodeId, undefined);
    assert.equal(result.failedToolNodeId, undefined);
  });
  test("persisted tool identity renders by node id when failed topology is unavailable", () => {
    const store = createStore();
    const { sent, unsubscribe } = installFailureNotices(store);
    store.recordRunStart({ id: "restored-failure", name: "restored", inputs: {}, status: "running", stages: [], startedAt: 1 });
    store.recordRunEnd("restored-failure", "failed", undefined, "restored error", {
      failedToolNodeId: "tool:restored",
    });
    unsubscribe();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.toolNodeId, "tool:restored");
    assert.equal(sent[0]?.details?.toolName, undefined);
    assert.match(sent[0]?.content ?? "", /tool tool:restored.*restored error/);
  });
});
