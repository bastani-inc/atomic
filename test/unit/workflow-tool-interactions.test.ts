// @ts-nocheck -- intentional white-box GraphView input coverage
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { workflowInterruptAction, workflowPauseAction, workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { computeLayout, NODE_H, NODE_W } from "../../packages/workflows/src/tui/layout.js";
import { defaultTheme } from "./overlay-graph-helpers.js";

function recordToolOnly(target = createStore(), status: "running" | "completed" = "running") {
  target.recordRunStart({
    id: "tool-interaction-run", name: "tool interaction", inputs: {}, status,
    stages: [], toolNodes: [{
      kind: "tool", id: "tool:publish", name: "publish-api", argsHash: "hash", ordinal: 1,
      parentIds: [], status: status === "running" ? "running" : "completed", attachable: false,
    }],
    startedAt: 1,
    ...(status === "completed" ? { endedAt: 2 } : {}),
  });
  return target;
}

function clickForSingleNode(stage, width = 96, rows = 32): string {
  const [node] = computeLayout([stage], { orientation: "vertical" });
  const marginRows = 1;
  const panelRows = rows - marginRows * 2;
  const bodyRows = panelRows - 6;
  const totalGraphRows = node.y + NODE_H;
  const topPad = totalGraphRows <= bodyRows ? Math.min(3, Math.max(0, Math.floor((bodyRows - totalGraphRows) / 2))) : 0;
  const graphInner = Math.max(1, Math.max(40, width) - 4);
  const canvasWidth = node.x + NODE_W;
  const leftMargin = Math.max(2, canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2);
  const col = leftMargin + node.x + 2;
  const row = marginRows + 3 + topPad + node.y + 2;
  return `\x1b[<0;${col + 1};${row + 1}M`;
}

beforeEach(() => { store.clear(); stageControlRegistry.clear(); });
afterEach(() => { store.clear(); stageControlRegistry.clear(); });

describe("non-attachable tool interactions", () => {
  test("keyboard, direct mouse, and switcher activation never attach a tool", () => {
    const localStore = recordToolOnly();
    const graph = expandWorkflowGraph(localStore.snapshot(), "tool-interaction-run");
    const attached: string[] = [];
    const view = new GraphView({
      mode: "overlay", runId: "tool-interaction-run", store: localStore, graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach: (_runId, stageId) => attached.push(stageId),
    });

    view.render(96);
    assert.equal(view.handleInput("\r"), true, "keyboard activation");
    assert.equal(view.handleInput(clickForSingleNode(graph.renderStages[0]!)), true, "direct mouse activation");
    assert.equal(view.handleInput("/"), true);
    for (const char of "publish-api") view.handleInput(char);
    assert.equal(view.handleInput("\r"), true, "switcher activation");
    assert.deepEqual(attached, []);
    view.dispose();
  });

  test("keyboard, mouse, and switcher activation open a retained completed stage", () => {
    const localStore = createStore();
    localStore.recordRunStart({
      id: "postmortem-run", name: "postmortem", inputs: {}, status: "completed", startedAt: 1, endedAt: 2,
      stages: [{
        id: "retained-stage", name: "retained-stage", status: "completed", parentIds: [],
        toolEvents: [], attachable: false, sessionFile: "/tmp/retained-session.jsonl",
      }],
    });
    const graph = expandWorkflowGraph(localStore.snapshot(), "postmortem-run");
    const attached: string[] = [];
    const view = new GraphView({
      mode: "overlay", runId: "postmortem-run", store: localStore, graphTheme: defaultTheme,
      getViewportRows: () => 32,
      onStageAttach: (runId, stageId) => attached.push(`${runId}/${stageId}`),
    });

    view.render(96);
    view.handleInput("\r");
    view.handleInput(clickForSingleNode(graph.renderStages[0]!));
    view.handleInput("/");
    for (const char of "retained-stage") view.handleInput(char);
    view.handleInput("\r");
    assert.deepEqual(attached, [
      "postmortem-run/retained-stage",
      "postmortem-run/retained-stage",
      "postmortem-run/retained-stage",
    ]);
    view.dispose();
  });

  test("textual stage/chat/control targeting cannot resolve or create a handle for a tool", async () => {
    recordToolOnly(store, "completed");
    for (const target of ["tool:publish", "publish-api"]) {
      const resolved = resolveStageTarget("tool-interaction-run", target);
      assert.equal(resolved.ok, false, `${target} must not resolve as a stage`);
    }

    let postMortemCreates = 0;
    const sent = await workflowSendAction(
      { action: "send", runId: "tool-interaction-run", stageId: "tool:publish", text: "chat" },
      { resolvePostMortemDeps: () => { postMortemCreates += 1; throw new Error("must not create"); } },
    );
    const paused = await workflowPauseAction({ action: "pause", runId: "tool-interaction-run", stageId: "tool:publish" });
    let overlayOpens = 0;
    const commandErrors: string[] = [];
    await handleRunControlCommand(
      "attach",
      ["tool-interaction-run", "tool:publish"],
      {},
      { info() {}, error(message) { commandErrors.push(message); } },
      {
        pi: {},
        overlay: { open() { overlayOpens += 1; } },
        runtimeForContext: () => ({ prepareDurableResumable: async () => [] }),
        ensureWorkflowResourcesLoaded() {},
      },
    );
    const interrupted = await workflowInterruptAction({ action: "interrupt", runId: "tool-interaction-run", stageId: "tool:publish" });

    assert.equal(sent.status, "noop");
    assert.equal(paused.status, "noop");
    assert.equal(interrupted.status, "noop");
    assert.match(`${sent.message}\n${paused.message}\n${interrupted.message}`, /Stage not found/);
    assert.equal(postMortemCreates, 0);
    const resumed = await workflowResumeAction(
      { action: "resume", runId: "tool-interaction-run", stageId: "tool:publish" },
      {
        getRuntime: () => ({ prepareDurableResumable: async () => [] }),
        policy: {},
        ensureWorkflowResourcesLoaded() {},
      },
    );
    assert.equal(resumed.status, "noop");
    assert.match(commandErrors.join("\n"), /Stage not found/);
    assert.equal(overlayOpens, 0);
    assert.deepEqual(stageControlRegistry.forRun("tool-interaction-run"), []);
  });
});