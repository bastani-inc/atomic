/**
 * Regression tests for issue #1957 — host-session replacement (`/new`,
 * `/resume`, `/fork`, `/reload`) must not stop the process-scoped DBOS
 * executor. Only actual process exit (`quit`) shuts DBOS down, and a stopped
 * backend must never be handed out or admit new workflow runs.
 */

import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DbosDurableBackend,
  type ConfiguredDbosDurability,
  type DbosSdkHandle,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import {
  DbosShutdownError,
  dbosLifecycleState,
  resetDbosLifecycleForTests,
  shutdownDbos,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import {
  getDurableBackend,
  initializeDurableBackend,
  setDurableBackend,
} from "../../packages/workflows/src/durable/factory.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { registerWorkflowLifecycleHandlers } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { launchDetachedUntilStartup } from "../../packages/workflows/src/runs/background/startup-admission.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";

const DBOS_NOT_LAUNCHED_MESSAGE = "`DBOS.launch()` must be called before running workflows.";

/**
 * Fake DBOS SDK that enforces the real SDK's launched invariant: every
 * durable write throws the exact production error unless the executor is
 * currently launched.
 */
function launchEnforcingHarness() {
  const events: string[] = [];
  let launched = false;
  const requireLaunched = () => {
    if (!launched) throw new TypeError(DBOS_NOT_LAUNCHED_MESSAGE);
  };
  const sdk: DbosSdkHandle = {
    launch: async () => { launched = true; },
    shutdown: async () => { launched = false; },
    startWorkflow: async () => { requireLaunched(); events.push("start"); },
    retrieveWorkflow: async () => undefined,
    cancelWorkflow: async () => { requireLaunched(); },
    resumeWorkflow: async () => { requireLaunched(); },
    listAllWorkflows: async () => [],
    listStepRecords: async () => [],
    recordStepOutput: async () => { requireLaunched(); events.push("record"); },
    deleteWorkflowData: async () => { requireLaunched(); },
  };
  const durability: ConfiguredDbosDurability = {
    backend: new DbosDurableBackend(sdk),
    launch: async () => { launched = true; events.push("launch"); },
    shutdown: async () => { launched = false; events.push("shutdown"); },
  };
  return { events, durability, isLaunched: () => launched };
}

type SessionEventHandler = (event: unknown, ctx?: unknown) => Promise<unknown>;

/** Register the real lifecycle handlers and capture `session_shutdown`. */
function captureSessionShutdownHandler(): SessionEventHandler {
  const handlers = new Map<string, SessionEventHandler>();
  const pi = {
    on: (type: string, handler: SessionEventHandler) => { handlers.set(type, handler); },
  } as unknown as ExtensionAPI;
  const runtimeState = {
    resetWorkflowDiscoveryForSession: () => {},
    setNotificationsActive: () => {},
  } as unknown as WorkflowExtensionRuntimeState;
  registerWorkflowLifecycleHandlers(pi, {
    runtimeState,
    storeWidgetRef: { current: null },
    intercomControlRef: { current: null },
  });
  const handler = handlers.get("session_shutdown");
  assert.ok(handler !== undefined, "session_shutdown handler must be registered");
  return handler;
}

function registerDurableRoot(backend: ReturnType<typeof getDurableBackend>, workflowId: string): void {
  backend.registerWorkflow({
    workflowId,
    name: workflowId,
    inputs: {},
    createdAt: Date.now(),
    status: "running",
  });
}

afterEach(() => {
  setDurableBackend(undefined);
  resetDbosLifecycleForTests();
});

describe("issue #1957 — DBOS survives host-session replacement", () => {
  for (const reason of ["new", "resume", "fork", "reload"] as const) {
    test.serial(`session_shutdown(${reason}) flushes but keeps DBOS launched for the next session`, async () => {
      const { events, durability, isLaunched } = launchEnforcingHarness();
      setDurableBackend(undefined);
      resetDbosLifecycleForTests(async () => durability);
      const sessionShutdown = captureSessionShutdownHandler();

      const backend = await initializeDurableBackend();
      registerDurableRoot(backend, `before-${reason}`);
      await backend.flush();
      assert.equal(dbosLifecycleState(), "ready");

      await sessionShutdown({ reason });

      // The executor is process-scoped: no SDK shutdown at this boundary.
      assert.equal(events.includes("shutdown"), false);
      assert.equal(isLaunched(), true);
      assert.equal(dbosLifecycleState(), "ready");

      // The replacement session reuses the same launched backend and its
      // durable writes succeed (this threw `DBOS.launch()`… before the fix).
      const nextBackend = await initializeDurableBackend();
      assert.equal(nextBackend, backend);
      registerDurableRoot(nextBackend, `after-${reason}`);
      await nextBackend.flush();
      assert.equal(events.filter((event) => event === "start").length, 2);
    });
  }

  test.serial("session_shutdown(quit) flushes and shuts DBOS down exactly once", async () => {
    const { events, durability, isLaunched } = launchEnforcingHarness();
    setDurableBackend(undefined);
    resetDbosLifecycleForTests(async () => durability);
    const sessionShutdown = captureSessionShutdownHandler();

    const backend = await initializeDurableBackend();
    registerDurableRoot(backend, "quit-run");

    await sessionShutdown({ reason: "quit" });
    await sessionShutdown({ reason: "quit" });

    assert.equal(events.filter((event) => event === "shutdown").length, 1);
    assert.equal(events.at(-1), "shutdown");
    assert.equal(isLaunched(), false);
    assert.equal(dbosLifecycleState(), "shut_down");
  });

  test.serial("post-shutdown initialization never returns a stopped backend", async () => {
    const { durability } = launchEnforcingHarness();
    setDurableBackend(undefined);
    resetDbosLifecycleForTests(async () => durability);

    await initializeDurableBackend();
    await shutdownDbos();

    // Neither async initialization nor the sync accessor may hand out the
    // memoized stopped backend, and there is no silent non-durable downgrade.
    await assert.rejects(initializeDurableBackend(), DbosShutdownError);
    assert.throws(() => getDurableBackend());
  });
});

describe("issue #1957 — startup admission requires durable root persistence", () => {
  class StoppedFlushBackend extends InMemoryDurableBackend {
    override async flush(): Promise<void> {
      throw new TypeError(DBOS_NOT_LAUNCHED_MESSAGE);
    }
  }

  test.serial("a backend that cannot persist the root blocks admission before workflow code runs", async () => {
    setDurableBackend(new StoppedFlushBackend());
    let workflowBodyRan = false;
    const def = workflow({
      name: "admission-guard-wf",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => {
        workflowBodyRan = true;
        return {};
      },
    }) as WorkflowDefinition;

    const launch = launchDetachedUntilStartup(def, {}, {
      store: createStore(),
      cancellation: createCancellationRegistry(),
      jobs: createJobTracker(),
    });
    const admission = await launch.wait;

    assert.equal(admission.started, false);
    assert.equal(workflowBodyRan, false);
    if (admission.started === false) {
      const message = admission.resultError
        ?? (admission.error instanceof Error ? admission.error.message : String(admission.error));
      assert.match(message ?? "", /DBOS\.launch\(\)/);
    }
  });
});
