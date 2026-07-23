// @ts-nocheck
/**
 * Unit tests for `WorkflowAttachPane` post-mortem handle revival.
 *
 * Verifies:
 *  - a completed stage with no process-local handle revives an interactive
 *    post-mortem handle through `resolvePostMortemHandle`, and prompts reach it;
 *  - a live registry handle short-circuits revival (resolver not consulted);
 *  - an unavailable stage (resolver returns undefined) stays read-only.
 *
 * cross-ref: src/tui/workflow-attach-pane.ts, src/runs/foreground/postmortem-stage-chat.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStore, store as globalStore } from "../../packages/workflows/src/shared/store.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createPostMortemHandleResolver } from "../../packages/workflows/src/extension/postmortem-deps.js";
import type { AgentSession } from "@bastani/atomic";
function setupCompletedRun(store: ReturnType<typeof createStore>, runId: string) {
  store.recordRunStart({ id: runId, name: "test-wf", inputs: {}, status: "completed", stages: [], startedAt: 1 });
  store.recordStageStart(runId, {
    id: "stage-a",
    name: "A",
    status: "completed",
    parentIds: [],
    toolEvents: [],
    result: "done",
    sessionFile: "/tmp/a.jsonl",
    attachable: false,
  });
}

function makeHandle(runId: string, stageId: string, promptCalls: string[]): StageControlHandle {
  return {
    runId,
    stageId,
    stageName: `stage-${stageId}`,
    status: "completed",
    sessionId: undefined,
    sessionFile: "/tmp/a.jsonl",
    isStreaming: false,
    messages: [] as AgentSession["messages"],
    async ensureAttached() {},
    async prompt(text: string) { promptCalls.push(text); },
    async steer() {},
    async followUp() {},
    async pause() {},
    async resume() {},
    subscribe() { return () => {}; },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function submit(chatView: { handleInput(data: string): boolean }, text: string): void {
  for (const ch of text) chatView.handleInput(ch);
  chatView.handleInput("\r");
}

describe("WorkflowAttachPane post-mortem revival", () => {
  test("revives a post-mortem handle when the registry misses", async () => {
    const store = createStore();
    setupCompletedRun(store, "run-1");
    const registry = createStageControlRegistry();
    const promptCalls: string[] = [];
    const resolverCalls: Array<[string, string]> = [];
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      resolvePostMortemHandle: (runId, stageId) => {
        resolverCalls.push([runId, stageId]);
        return { ok: true, handle: makeHandle(runId, stageId, promptCalls) };
      },
      onClose: () => {},
      initialAttachStageId: "stage-a",
    });
    assert.deepEqual(resolverCalls, [["run-1", "stage-a"]]);
    const chatView = (pane as unknown as { chatView: { handleInput(data: string): boolean } | null }).chatView;
    assert.ok(chatView, "expected an interactive stage chat");
    submit(chatView, "follow up question");
    await flush();
    assert.deepEqual(promptCalls, ["follow up question"]);
    pane.dispose();
  });

  test("uses the live registry handle and never consults the resolver", () => {
    const store = createStore();
    setupCompletedRun(store, "run-1");
    const registry = createStageControlRegistry();
    const promptCalls: string[] = [];
    registry.register(makeHandle("run-1", "stage-a", promptCalls));
    let resolverCalls = 0;
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      resolvePostMortemHandle: () => { resolverCalls += 1; return undefined; },
      onClose: () => {},
      initialAttachStageId: "stage-a",
    });
    assert.equal(resolverCalls, 0);
    assert.equal(pane._mode, "stage-chat");
    pane.dispose();
  });

  test("keeps a read-only archive when the stage is not revivable", () => {
    const store = createStore();
    setupCompletedRun(store, "run-1");
    const registry = createStageControlRegistry();
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: registry,
      resolvePostMortemHandle: () => undefined,
      onClose: () => {},
      initialAttachStageId: "stage-a",
    });
    assert.equal(pane._mode, "stage-chat");
    assert.equal(pane._hasChatView, true);
    pane.dispose();
  });

  test("renders the post-mortem unavailability reason instead of a generic archive", () => {
    const store = createStore();
    setupCompletedRun(store, "run-1");
    const pane = new WorkflowAttachPane({
      store,
      graphTheme: deriveGraphTheme({}),
      runId: "run-1",
      stageControlRegistry: createStageControlRegistry(),
      resolvePostMortemHandle: () => ({ ok: false, reason: "invalid_session" }),
      onClose: () => {},
      initialAttachStageId: "stage-a",
    });

    const rendered = pane.render(40).join("\n");
    const visible = rendered.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
    assert.match(visible, /SESSION UNAVAILABLE/);
    assert.match(visible, /The retained session is missing, unreadable, or invalid\. Check that the session file still exists and is readable\./);
    assert.doesNotMatch(visible, /archived transcript/);
    pane.dispose();
  });

  test.serial("the extension resolver preserves invalid-session reasons", () => {
    globalStore.clear();
    try {
      setupCompletedRun(globalStore, "resolver-run");
      const resolver = createPostMortemHandleResolver({
        adapters: { agentSession: { async create() { throw new Error("must not create"); } } },
        resolveDefaultStageSessionDir: () => undefined,
      });

      assert.deepEqual(
        resolver("resolver-run", "stage-a"),
        { ok: false, reason: "invalid_session" },
      );
    } finally {
      globalStore.clear();
    }
  });
});
