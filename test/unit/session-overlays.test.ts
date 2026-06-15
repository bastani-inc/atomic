import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  openKillConfirm,
  openWorkflowQuitConfirm,
  type ConfirmUiSurface,
  type UiSurface,
} from "../../packages/workflows/src/tui/session-overlays.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function workflowRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "run-12345678",
    name: "Test workflow",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

const theme = deriveGraphTheme({});

test("openWorkflowQuitConfirm fail-opens when custom UI rejects before mounting", async () => {
  const ui: UiSurface = {
    custom: () => Promise.reject(new Error("custom unavailable")),
  };

  assert.equal(await openWorkflowQuitConfirm(ui, [workflowRun()], theme), undefined);
});

test("openWorkflowQuitConfirm fail-opens when custom UI resolves without invoking the factory", async () => {
  let customCalls = 0;
  const ui: UiSurface = {
    custom: async (factory, options) => {
      customCalls += 1;
      assert.equal(options.overlay, true);
      void factory;
      return undefined;
    },
  };

  const result = await openWorkflowQuitConfirm(ui, [workflowRun()], theme);

  assert.equal(result, undefined);
  assert.equal(customCalls, 1);
});

test("openWorkflowQuitConfirm keeps mounted custom UI cancel-by-default behavior", async () => {
  const ui: UiSurface = {
    custom: (factory) => {
      const component = factory({ requestRender: () => undefined }, {}, {}, () => undefined);
      if (component instanceof Promise) throw new Error("test factory should be sync");
      if (typeof component.handleInput !== "function") throw new Error("test component should handle input");
      component.handleInput("enter");
      return undefined;
    },
  };

  assert.equal(await openWorkflowQuitConfirm(ui, [workflowRun()], theme), false);
});

test("openKillConfirm resolves false when custom UI rejects before mounting", async () => {
  const ui: ConfirmUiSurface = {
    custom: () => Promise.reject(new Error("custom unavailable")),
  };

  assert.equal(await openKillConfirm(ui, workflowRun(), theme), false);
});

test("openKillConfirm resolves false when custom UI resolves without invoking the factory", async () => {
  let confirmCalls = 0;
  const ui: ConfirmUiSurface = {
    custom: async () => undefined,
    confirm: async () => {
      confirmCalls += 1;
      return true;
    },
  };

  assert.equal(await openKillConfirm(ui, workflowRun(), theme), false);
  assert.equal(confirmCalls, 0);
});
