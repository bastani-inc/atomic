import { afterEach, beforeEach, describe, test } from "bun:test";
import { Key } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { aggregateWorkflowRootRunId } from "../../packages/workflows/src/runs/background/workflow-lifecycle-aggregate.js";
import { workflowInterruptAction, workflowPauseAction, workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { workflowStageResult, workflowTranscriptResult } from "../../packages/workflows/src/extension/workflow-tool-inspection.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { topLevelExpandedSnapshots } from "../../packages/workflows/src/extension/workflow-targets.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createStageControlRegistry, stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";

function stage(id: string, name = id): StageSnapshot {
  return { id, name, status: "running", parentIds: [], toolEvents: [], attachable: true };
}

function run(overrides: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "name" | "stages">): RunSnapshot {
  return {
    inputs: {},
    status: "running",
    startedAt: 1,
    ...overrides,
  };
}

function seedSiblingChildren(targetStore: Store = store): void {
  targetStore.recordRunStart(run({
    id: "root-run",
    name: "root",
    stages: [
      {
        ...stage("workflow:left", "left import"),
        workflowChildRun: { alias: "left", workflow: "worker", runId: "child-left" },
      },
      {
        ...stage("workflow:right", "right import"),
        workflowChildRun: { alias: "right", workflow: "worker", runId: "child-right" },
      },
    ],
  }));
  targetStore.recordRunStart(run({
    id: "child-left",
    name: "worker",
    parentRunId: "root-run",
    parentStageId: "workflow:left",
    rootRunId: "root-run",
    stages: [stage("shared", "duplicate name"), stage("left-only", "repeated name")],
  }));
  targetStore.recordRunStart(run({
    id: "child-right",
    name: "worker",
    parentRunId: "root-run",
    parentStageId: "workflow:right",
    rootRunId: "root-run",
    stages: [stage("shared", "duplicate name"), stage("right-only", "repeated name")],
  }));
}

interface HandleCalls {
  pauses: number;
  resumes: string[];
  prompts: string[];
}

function liveHandle(runId: string, stageId: string, calls: HandleCalls): StageControlHandle {
  const state: { status: "running" | "paused" } = { status: "running" };
  return {
    runId,
    stageId,
    stageName: stageId,
    get status() { return state.status; },
    sessionId: undefined,
    sessionFile: undefined,
    isStreaming: false,
    messages: [],
    async ensureAttached() {},
    async prompt(text) { calls.prompts.push(text); },
    async steer() {},
    async followUp() {},
    async pause() { calls.pauses += 1; state.status = "paused"; },
    async resume(message) { calls.resumes.push(message ?? ""); state.status = "running"; },
    subscribe() { return () => {}; },
  };
}

beforeEach(() => {
  store.clear();
  stageControlRegistry.clear();
  seedSiblingChildren();
});

afterEach(() => {
  stageControlRegistry.clear();
  setDurableBackend(undefined);
  store.clear();
});

describe("nested workflow stage target routing", () => {
  test("duplicate child-local stage IDs are ambiguous instead of first-matched", () => {
    const result = resolveStageTarget("root-run", "shared");

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(
      result.message,
      'Ambiguous stage identifier "shared" matches: worker:duplicate name (child-le/shared), worker:duplicate name (child-ri/shared)',
    );
  });

  test("exact virtual IDs and unique local IDs retain the owning child run", () => {
    assert.deepEqual(resolveStageTarget("root-run", "child-right:shared"), {
      ok: true,
      runId: "child-right",
      stageId: "shared",
    });
    assert.deepEqual(resolveStageTarget("root-run", "left-only"), {
      ok: true,
      runId: "child-left",
      stageId: "left-only",
    });
  });

  test("repeated names and ambiguous prefixes retain the existing ambiguity path", () => {
    const byName = resolveStageTarget("root-run", "repeated name");
    assert.equal(byName.ok, false);
    if (!byName.ok) {
      assert.match(byName.message, /^Ambiguous stage identifier "repeated name" matches: /);
      assert.match(byName.message, /child-le\/left-on/);
      assert.match(byName.message, /child-ri\/right-on/);
    }

    const byPrefix = resolveStageTarget("root-run", "child-r");
    assert.equal(byPrefix.ok, false);
    if (!byPrefix.ok) {
      assert.match(byPrefix.message, /^Ambiguous stage identifier "child-r" matches: /);
      assert.match(byPrefix.message, /child-ri\/shared/);
      assert.match(byPrefix.message, /child-ri\/right-on/);
    }
  });

  test("attach detach restores the exact sibling owner when local stage IDs collide", () => {
    const localStore = createStore();
    seedSiblingChildren(localStore);
    const pane = new WorkflowAttachPane({
      store: localStore,
      graphTheme: deriveGraphTheme({}),
      runId: "root-run",
      initialAttachRunId: "child-right",
      initialAttachStageId: "shared",
      onClose: () => {},
    });

    assert.equal(
      localStore.runs().find((candidate) => candidate.id === "child-right")?.stages[0]?.attached,
      true,
    );
    pane.handleInput(Key.ctrl("x"));
    assert.equal(pane._mode, "graph");
    pane.handleInput(Key.enter);

    assert.equal(pane._mode, "stage-chat");
    assert.equal(
      localStore.runs().find((candidate) => candidate.id === "child-left")?.stages[0]?.attached,
      undefined,
    );
    assert.equal(
      localStore.runs().find((candidate) => candidate.id === "child-right")?.stages[0]?.attached,
      true,
    );
    pane.dispose();
  });

  test("ownerless attach does not first-match an ambiguous child-local stage ID", () => {
    const localStore = createStore();
    seedSiblingChildren(localStore);
    const pane = new WorkflowAttachPane({
      store: localStore,
      graphTheme: deriveGraphTheme({}),
      runId: "root-run",
      initialAttachStageId: "shared",
      onClose: () => {},
    });

    assert.equal(pane._mode, "graph");
    assert.equal(pane._hasChatView, false);
    assert.deepEqual(localStore.runs().flatMap((run) => run.stages).filter((stage) => stage.attached), []);

    assert.equal(
      localStore.runs().find((candidate) => candidate.id === "child-left")?.stages[0]?.attached,
      undefined,
    );
    assert.equal(
      localStore.runs().find((candidate) => candidate.id === "child-right")?.stages[0]?.attached,
      undefined,
    );
    pane.dispose();
  });

  test("aggregate root traversal follows the child's reciprocal owner instead of a stale first claim", () => {
    const localStore = createStore();
    localStore.recordRunStart(run({
      id: "stale-parent",
      name: "stale",
      stages: [{
        ...stage("stale-boundary"),
        workflowChildRun: { alias: "stale", workflow: "worker", runId: "leaf-run" },
      }],
    }));
    localStore.recordRunStart(run({
      id: "root-owner",
      name: "root-owner",
      stages: [{
        ...stage("root-boundary"),
        status: "completed",
        workflowChild: {
          alias: "middle",
          workflow: "middle",
          runId: "middle-run",
          status: "completed",
          outputs: {},
        },
      }],
    }));
    localStore.recordRunStart(run({
      id: "middle-run",
      name: "middle",
      parentRunId: "root-owner",
      parentStageId: "root-boundary",
      rootRunId: "root-owner",
      stages: [{
        ...stage("leaf-boundary"),
        workflowChildRun: { alias: "leaf", workflow: "worker", runId: "leaf-run" },
      }],
    }));
    localStore.recordRunStart(run({
      id: "leaf-run",
      name: "leaf",
      parentRunId: "middle-run",
      parentStageId: "leaf-boundary",
      rootRunId: "root-owner",
      stages: [stage("work")],
    }));

    assert.equal(aggregateWorkflowRootRunId(localStore, "leaf-run"), "root-owner");
  });

  test("aggregate root uses the status-authoritative child reference when live and replay refs conflict", () => {
    const localStore = createStore();
    localStore.recordRunStart(run({
      id: "root-owner",
      name: "root-owner",
      stages: [{
        ...stage("completed-boundary"),
        status: "completed",
        workflowChild: {
          alias: "replay",
          workflow: "worker",
          runId: "replay-child",
          status: "completed",
          outputs: {},
        },
        workflowChildRun: { alias: "stale-live", workflow: "worker", runId: "stale-live-child" },
      }],
    }));
    for (const id of ["replay-child", "stale-live-child"]) {
      localStore.recordRunStart(run({
        id,
        name: id,
        parentRunId: "root-owner",
        parentStageId: "completed-boundary",
        rootRunId: "root-owner",
        stages: [stage("work")],
      }));
    }

    assert.equal(aggregateWorkflowRootRunId(localStore, "replay-child"), "root-owner");
    assert.equal(aggregateWorkflowRootRunId(localStore, "stale-live-child"), "stale-live-child");
  });

  test("aggregate root rejects a present root mismatch while accepting an omitted legacy root", () => {
    const localStore = createStore();
    localStore.recordRunStart(run({
      id: "root-owner",
      name: "root-owner",
      stages: [
        {
          ...stage("legacy-boundary"),
          workflowChildRun: { alias: "legacy", workflow: "worker", runId: "legacy-child" },
        },
        {
          ...stage("mismatch-boundary"),
          workflowChildRun: { alias: "mismatch", workflow: "worker", runId: "mismatch-child" },
        },
      ],
    }));
    localStore.recordRunStart(run({
      id: "legacy-child",
      name: "legacy-child",
      parentRunId: "root-owner",
      parentStageId: "legacy-boundary",
      stages: [stage("work")],
    }));
    localStore.recordRunStart(run({
      id: "mismatch-child",
      name: "mismatch-child",
      parentRunId: "root-owner",
      parentStageId: "mismatch-boundary",
      rootRunId: "unrelated-root",
      stages: [stage("work")],
    }));

    assert.equal(aggregateWorkflowRootRunId(localStore, "legacy-child"), "root-owner");
    assert.equal(aggregateWorkflowRootRunId(localStore, "mismatch-child"), "mismatch-child");
  });

  test("aggregate root uses live refs only for active boundaries and none for failed or skipped boundaries", () => {
    const localStore = createStore();
    localStore.recordRunStart(run({
      id: "root-owner",
      name: "root-owner",
      stages: [
        { ...stage("active"), workflowChildRun: { alias: "live", workflow: "worker", runId: "live" },
          workflowChild: { alias: "stale", workflow: "worker", runId: "stale", status: "completed", outputs: {} } },
        { ...stage("failed"), status: "failed", workflowChildRun: { alias: "failed", workflow: "worker", runId: "failed" } },
        { ...stage("skipped"), status: "skipped", workflowChildRun: { alias: "skipped", workflow: "worker", runId: "skipped" } },
      ],
    }));
    for (const [id, parentStageId] of [["live", "active"], ["stale", "active"], ["failed", "failed"], ["skipped", "skipped"]]) {
      localStore.recordRunStart(run({ id, name: id, parentRunId: "root-owner", parentStageId,
        rootRunId: "root-owner", stages: [stage("work")] }));
    }

    assert.equal(aggregateWorkflowRootRunId(localStore, "live"), "root-owner");
    assert.equal(aggregateWorkflowRootRunId(localStore, "stale"), "stale");
    assert.equal(aggregateWorkflowRootRunId(localStore, "failed"), "failed");
    assert.equal(aggregateWorkflowRootRunId(localStore, "skipped"), "skipped");
  });

  test("public controls and inspection route an exact virtual ID to the true child owner", async () => {
    const leftCalls: HandleCalls = { pauses: 0, resumes: [], prompts: [] };
    const rightCalls: HandleCalls = { pauses: 0, resumes: [], prompts: [] };
    stageControlRegistry.register(liveHandle("child-left", "shared", leftCalls));
    stageControlRegistry.register(liveHandle("child-right", "shared", rightCalls));
    const target = { runId: "root-run", stageId: "child-right:shared" };

    const inspected = workflowStageResult({ action: "stage", ...target });
    assert.equal(inspected.action, "stage");
    if (inspected.action !== "stage") return;
    assert.equal(inspected.runId, "child-right");
    assert.equal(inspected.stage?.id, "shared");

    const transcript = workflowTranscriptResult({ action: "transcript", ...target });
    assert.equal(transcript.action, "transcript");
    if (transcript.action !== "transcript") return;
    assert.equal(transcript.runId, "child-right");
    assert.equal(transcript.stageId, "shared");
    assert.equal(transcript.source, "live");

    const sent = await workflowSendAction({ action: "send", ...target, text: "right only" });
    assert.deepEqual({ runId: sent.runId, stageId: sent.stageId, status: sent.status }, {
      runId: "child-right",
      stageId: "shared",
      status: "ok",
    });
    assert.deepEqual(leftCalls.prompts, []);
    assert.deepEqual(rightCalls.prompts, ["right only"]);

    const paused = await workflowPauseAction({ action: "pause", ...target });
    assert.equal(paused.action, "pause");
    assert.equal("runId" in paused ? paused.runId : undefined, "child-right");
    assert.equal(leftCalls.pauses, 0);
    assert.equal(rightCalls.pauses, 1);

    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: "root-run",
      rootWorkflowId: "root-run",
      name: "root",
      inputs: {},
      createdAt: 1,
      status: "running",
    });
    setDurableBackend(backend);
    const resumed = await workflowResumeAction(
      { action: "resume", ...target, message: "continue right" },
      {
        getRuntime: () => { throw new Error("runtime should not be used for a live paused stage"); },
        policy: {} as never,
        ensureWorkflowResourcesLoaded: () => {},
      },
    );
    assert.equal(resumed.action, "resume");
    assert.equal("runId" in resumed ? resumed.runId : undefined, "child-right");
    assert.deepEqual(rightCalls.resumes, ["continue right"]);

    const interrupted = await workflowInterruptAction({ action: "interrupt", ...target });
    assert.equal(interrupted.action, "interrupt");
    assert.equal("runId" in interrupted ? interrupted.runId : undefined, "child-right");
    assert.equal(leftCalls.pauses, 0);
    assert.equal(rightCalls.pauses, 2);
  });

  test("every public control surface reports ambiguity instead of routing duplicate local IDs", async () => {
    const target = { runId: "root-run", stageId: "shared" };
    const expected = 'Ambiguous stage identifier "shared" matches: worker:duplicate name (child-le/shared), worker:duplicate name (child-ri/shared)';
    const pause = await workflowPauseAction({ action: "pause", ...target });
    const interrupt = await workflowInterruptAction({ action: "interrupt", ...target });
    const resume = await workflowResumeAction(
      { action: "resume", ...target },
      {
        getRuntime: () => { throw new Error("ambiguous target must not reach runtime"); },
        policy: {} as never,
        ensureWorkflowResourcesLoaded: () => {},
      },
    );
    const send = await workflowSendAction({ action: "send", ...target, text: "do not deliver" });
    const inspected = workflowStageResult({ action: "stage", ...target });
    const transcript = workflowTranscriptResult({ action: "transcript", ...target });

    assert.equal("message" in pause ? pause.message : undefined, expected);
    assert.equal("message" in interrupt ? interrupt.message : undefined, expected);
    assert.equal("message" in resume ? resume.message : undefined, expected);
    assert.equal(send.message, expected);
    assert.equal(inspected.action === "stage" ? inspected.error : undefined, expected);
    assert.equal(
      transcript.action === "transcript" ? transcript.entries[0]?.text : undefined,
      expected,
    );
  });

  test("post-mortem revival dependencies are resolved for the nested stage owner", async () => {
    const nestedStage = store.runs().find((run) => run.id === "child-right")?.stages[0];
    assert.ok(nestedStage);
    store.recordStageEnd("child-right", { ...nestedStage, status: "completed", result: "done" });
    let dependencyRunId: string | undefined;

    const result = await workflowSendAction(
      {
        action: "send",
        runId: "root-run",
        stageId: "child-right:shared",
        text: "continue retained chat",
      },
      {
        resolvePostMortemDeps: (runId) => {
          dependencyRunId = runId;
          return {
            registry: createStageControlRegistry(),
            adapters: {
              agentSession: {
                async create() { throw new Error("missing retained session must not create an agent"); },
              },
            },
            cwd: process.cwd(),
          };
        },
      },
    );

    assert.equal(dependencyRunId, "child-right");
    assert.equal(result.runId, "child-right");
    assert.equal(result.stageId, "shared");
    assert.equal(result.status, "noop");
  });

  test("top-level expanded listings exclude both child and grandchild implementation runs", () => {
    store.recordRunStart(run({
      id: "grandchild-run",
      name: "grandchild",
      parentRunId: "child-right",
      parentStageId: "shared",
      rootRunId: "root-run",
      stages: [stage("grandchild-stage")],
    }));

    assert.deepEqual(topLevelExpandedSnapshots().map((snapshot) => snapshot.id), ["root-run"]);
  });
});
