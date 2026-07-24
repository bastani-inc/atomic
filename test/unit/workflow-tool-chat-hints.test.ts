// @ts-nocheck -- focused GraphView rendering/input contract coverage
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { defaultTheme, visibleText } from "./overlay-graph-helpers.js";

const STAGE_FOOTER = "ctrl+x return to main chat  ·  ↵ open stage chat  ·  ↑↓←→ navigate  ·  / stages";
const TOOL_FOOTER = "ctrl+x return to main chat  ·  ↑↓←→ navigate  ·  / stages";
const STAGE_SWITCHER = "↑↓ select · ↵ open stage chat · esc close";
const TOOL_SWITCHER = "↑↓ select · esc close";

function stage(
  id: string,
  parentIds: readonly string[] = [],
  overrides: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    id,
    name: id,
    status: "running",
    parentIds,
    toolEvents: [],
    attachable: true,
    ...overrides,
  };
}

function tool(id = "tool:publish", name = "publish-api"): ToolNodeSnapshot {
  return {
    kind: "tool",
    id,
    name,
    argsHash: "hash",
    ordinal: 1,
    parentIds: [],
    status: "running",
    executionOrder: 1,
    attachable: false,
  };
}

function viewFor(stages: StageSnapshot[], tools: ToolNodeSnapshot[] = []): GraphView {
  const localStore = createStore();
  localStore.recordRunStart({
    id: "hint-run",
    name: "hint run",
    inputs: {},
    status: "running",
    stages,
    toolNodes: tools,
    startedAt: 1,
  });
  return new GraphView({
    mode: "overlay",
    runId: "hint-run",
    store: localStore,
    graphTheme: defaultTheme,
    getViewportRows: () => 32,
    onStageAttach() {},
  });
}

describe("tool graph chat hints", () => {
  test("wide footer advertises chat only for the focused attachable stage target", () => {
    const stageView = viewFor([stage("stage")]);
    const stageText = visibleText(stageView.render(120));
    assert.ok(stageText.includes(STAGE_FOOTER));

    stageView.expandedGraph.targets.clear();
    const missingTargetText = visibleText(stageView.render(120));
    assert.ok(missingTargetText.includes(TOOL_FOOTER));
    assert.doesNotMatch(missingTargetText, /↵ (?:open )?stage chat/);

    const toolView = viewFor([], [tool()]);
    const toolText = visibleText(toolView.render(120));
    assert.ok(toolText.includes(TOOL_FOOTER));
    assert.doesNotMatch(toolText, /↵ (?:open )?stage chat/);

    const nonAttachableView = viewFor([stage("summary", [], { attachable: false })]);
    const nonAttachableText = visibleText(nonAttachableView.render(120));
    assert.ok(nonAttachableText.includes(TOOL_FOOTER));
    assert.doesNotMatch(nonAttachableText, /↵ (?:open )?stage chat/);

    const compactToolText = visibleText(toolView.render(40));
    assert.match(compactToolText, /ctrl\+x\s+return to main chat/i);
    assert.doesNotMatch(compactToolText, /stage chat/);
    stageView.dispose();
    toolView.dispose();
    nonAttachableView.dispose();
  });

  test("mixed graph footer updates when focus moves between a tool and stage", () => {
    const toolNode = tool();
    const stageNode = stage("review", [toolNode.id], { executionOrder: 2 });
    const view = viewFor([stageNode], [toolNode]);

    const toolFocused = visibleText(view.render(120));
    assert.ok(toolFocused.includes(TOOL_FOOTER));
    assert.doesNotMatch(toolFocused, /↵ open stage chat/);

    view.handleInput("\x1b[B");
    const stageFocused = visibleText(view.render(120));
    assert.ok(stageFocused.includes(STAGE_FOOTER));
    view.dispose();
  });

  test("switcher hints update for the selected tool or stage at wide and compact widths", () => {
    const toolNode = tool();
    const stageNode = stage("review", [toolNode.id], { executionOrder: 2 });
    const view = viewFor([stageNode], [toolNode]);
    view.handleInput("/");

    const wideTool = visibleText(view.render(120));
    assert.ok(wideTool.includes(TOOL_SWITCHER));
    assert.doesNotMatch(wideTool, /↵ open stage chat/);
    const compactTool = visibleText(view.render(40));
    assert.match(compactTool, /esc close/);
    assert.doesNotMatch(compactTool, /↵ stage chat/);

    view.handleInput("\x1b[B");
    const wideStage = visibleText(view.render(120));
    assert.ok(wideStage.includes(STAGE_SWITCHER));
    const compactStage = visibleText(view.render(40));
    assert.match(compactStage, /↵ stage chat · esc close/);

    view.handleInput("\x1b[A");
    assert.ok(visibleText(view.render(120)).includes(TOOL_SWITCHER));
    view.dispose();
  });

  test("awaiting-stage card keeps its own response hint", () => {
    const view = viewFor([stage("answer", [], {
      status: "awaiting_input",
      awaitingInputSince: 2,
    })]);
    assert.match(visibleText(view.render(120)), /↵ enter to respond/);
    view.dispose();
  });
});
