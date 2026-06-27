import { beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import factory, { type ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { PiCustomOverlayFactoryTui } from "../../packages/workflows/src/extension/wiring.js";

type SessionBeforeShutdownHandler = (event?: { readonly reason?: string }, ctx?: ShutdownContext) => Promise<unknown> | unknown;
interface CustomComponent {
  handleInput?: (data: string) => void;
}

interface ShutdownContext {
  readonly hasUI?: boolean;
  readonly ui?: {
    readonly custom?: (
      factory: (
        tui: PiCustomOverlayFactoryTui,
        theme: unknown,
        keys: unknown,
        done: (result: undefined) => void,
      ) => CustomComponent,
      options?: { readonly overlay?: boolean; readonly overlayOptions?: object },
    ) => unknown;
    readonly notify?: (message: string, type?: string) => void;
  };
}

function workflowRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "run-1",
    name: "Test workflow",
    inputs: {},
    status: "running",
    stages: [],
    startedAt: Date.now(),
    ...overrides,
  };
}

function sessionBeforeShutdownHandler(): SessionBeforeShutdownHandler {
  const handlers = new Map<string, SessionBeforeShutdownHandler>();
  const pi: ExtensionAPI = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    on: (event, handler) => {
      handlers.set(event, handler as SessionBeforeShutdownHandler);
    },
    disableAsyncDiscovery: true,
  };
  factory(pi);
  const handler = handlers.get("session_before_shutdown");
  if (handler === undefined) assert.fail("session_before_shutdown handler was not registered");
  return handler;
}

beforeEach(() => {
  store.clear();
});

test("session_before_shutdown does not prompt for a graph-quit resumable run", async () => {
  store.recordRunStart(workflowRun({
    status: "paused",
    exitReason: "quit",
    resumable: true,
  }));
  const handler = sessionBeforeShutdownHandler();
  let customCalls = 0;

  const result = await handler({ reason: "quit" }, {
    ui: {
      custom: () => {
        customCalls += 1;
        return undefined;
      },
      notify: () => undefined,
    },
  });

  assert.equal(result, undefined);
  assert.equal(customCalls, 0);
});

test("session_before_shutdown still prompts for paused runs that are not graph-quit resumable", async () => {
  store.recordRunStart(workflowRun({
    status: "paused",
    resumable: true,
  }));
  const handler = sessionBeforeShutdownHandler();
  let customCalls = 0;

  const result = await handler({ reason: "quit" }, {
    ui: {
      custom: (componentFactory) => {
        customCalls += 1;
        const component: CustomComponent = componentFactory({ requestRender: () => undefined }, {}, {}, () => undefined);
        component.handleInput?.("n");
        return undefined;
      },
      notify: () => undefined,
    },
  });

  assert.deepEqual(result, { cancel: true });
  assert.equal(customCalls, 1);
});
