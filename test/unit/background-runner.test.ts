/**
 * runner.test.ts
 *
 * Verifies:
 *   - runDetached returns immediately without awaiting the background promise.
 *   - statusRuns lists detached run while delayed stage is active (RFC §5).
 *   - killRun aborts delayed stage and records killed terminal state (RFC §6).
 *   - Detached promise rejection does not produce unhandled rejection; store
 *     records failed status (RFC §7).
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { statusRuns, killRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { Type } from "typebox";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { PromptAdapter } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

// ---------------------------------------------------------------------------
// Deferred adapter — a prompt adapter that holds until explicitly released
// ---------------------------------------------------------------------------

interface DeferredAdapter {
  adapter: PromptAdapter;
  release(value?: string): void;
  rejectWith(err: Error): void;
}

function makeDeferredAdapter(): DeferredAdapter {
  let resolveFn!: (value: string) => void;
  let rejectFn!: (reason: unknown) => void;
  const holdPromise = new Promise<string>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  // Prevent unhandled rejection on the hold promise itself when rejected
  holdPromise.catch(() => {});
  return {
    adapter: {
      prompt: (_text: string) => holdPromise,
    },
    release: (value = "released") => resolveFn(value),
    rejectWith: (err: Error) => rejectFn(err),
  };
}

function makeDelayedWorkflow(name: string): WorkflowDefinition {
  return workflow({
    name: name,
    description: "",
    inputs: {},
    outputs: {
      done: Type.Boolean(),
    },
    run: async (ctx) => {
      await ctx.stage("delayed-stage").prompt("waiting for input");
      return { done: true };
    },
  }) as WorkflowDefinition;
}

function makeThrowingWorkflow(name: string): WorkflowDefinition {
  return workflow({
    name: name,
    description: "",
    inputs: {},
    outputs: {},
    run: async (_ctx) => {
      throw new Error(`${name} internal error`);
    },
  }) as WorkflowDefinition;
}

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Intentional synchronous work used to prove detached dispatch does not
    // run user workflow code before returning the accepted result.
  }
}

// ---------------------------------------------------------------------------
// RFC §4 (runner-level) — runDetached returns before background settles
// ---------------------------------------------------------------------------

describe("runDetached — returns immediately", () => {
  test("accepted result returned synchronously before background completes", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeDelayedWorkflow("immediate-return-wf");

    let backgroundSettled = false;
    const accepted = runDetached(def, {}, {
      store,
      cancellation,
      jobs,
      adapters: {
        prompt: {
          prompt: async (text) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            backgroundSettled = true;
            return text;
          },
        },
      },
    });

    // runDetached must have returned before background settled
    assert.equal(backgroundSettled, false);
    assert.equal(accepted.action, "run");
    assert.equal(accepted.status, "running");
    assert.ok(accepted.runId);

    // Cleanup — let background finish
    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
  });

  test("accepted result message contains workflow name", () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = workflow({
      name: "named-wf-result",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    }) as WorkflowDefinition;

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    assert.ok(accepted.message.includes("named-wf-result"));
    assert.deepEqual(accepted.stages, []);
  });

  test("accepted result returns before synchronous workflow body prefix starts", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    let bodyStarted = false;
    const def = workflow({
      name: "sync-prefix-wf",
      description: "",
      inputs: {},
      outputs: {
        done: Type.Boolean(),
      },
      run: async () => {
        bodyStarted = true;
        busyWait(100);
        return { done: true };
      },
    }) as WorkflowDefinition;

    async function dispatchLike(): Promise<ReturnType<typeof runDetached>> {
      return runDetached(def, {}, { store, cancellation, jobs });
    }

    const accepted = await dispatchLike();

    assert.equal(bodyStarted, false);
    assert.equal(accepted.status, "running");
    assert.equal(jobs.has(accepted.runId), true);
    assert.notEqual(store.runs().find((run) => run.id === accepted.runId), undefined);

    const job = jobs.get(accepted.runId);
    if (job === undefined) throw new Error("expected background job to be registered");
    await job.promise;
    assert.equal(bodyStarted, true);
  });

  test("killing before deferred workflow body starts prevents body execution", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    let bodyStarted = false;
    const def = workflow({
      name: "killed-before-start-wf",
      description: "",
      inputs: {},
      outputs: {
        unreached: Type.Boolean(),
      },
      run: async () => {
        bodyStarted = true;
        return { unreached: true };
      },
    }) as WorkflowDefinition;

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    const killed = killRun(accepted.runId, { store, cancellation });

    assert.equal(killed.ok, true);

    const job = jobs.get(accepted.runId);
    if (job === undefined) throw new Error("expected background job to be registered");
    await job.promise;

    assert.equal(bodyStarted, false);
    const run = store.runs().find((snapshot) => snapshot.id === accepted.runId);
    assert.equal(run?.status, "killed");
  });
});

// ---------------------------------------------------------------------------
// RFC §5 — statusRuns lists detached run while delayed stage active
// ---------------------------------------------------------------------------

describe("statusRuns — lists detached run during active stage", () => {
  test("in-flight run appears in statusRuns while stage is blocked on prompt", async () => {
    const deferred = makeDeferredAdapter();
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeDelayedWorkflow("status-listed-wf");

    const accepted = runDetached(def, {}, {
      store,
      cancellation,
      jobs,
      adapters: { prompt: deferred.adapter },
    });

    // While stage is blocked, statusRuns should list this run
    const runs = statusRuns({ store });
    const found = runs.find((r) => r.runId === accepted.runId);
    assert.notEqual(found, undefined);
    assert.equal(found?.name, "status-listed-wf");
    assert.equal(found?.status, "running");

    // Cleanup — release the stage
    deferred.release();
    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
  });

  test("settled retained run remains listed in statusRuns by default", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = workflow({
      name: "completes-quickly-wf",
      description: "",
      inputs: {},
      outputs: {
        done: Type.Boolean(),
      },
      run: async () => ({ done: true }),
    }) as WorkflowDefinition;

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    const job = jobs.get(accepted.runId);
    // Wait for background to finish
    if (job) await job.promise;

    // Small yield to allow store update propagation
    await new Promise((resolve) => setTimeout(resolve, 5));

    const runs = statusRuns({ store });
    const found = runs.find((r) => r.runId === accepted.runId);
    assert.notEqual(found, undefined);
    assert.notEqual(store.runs().find((r) => r.id === accepted.runId)?.endedAt, undefined);
  });

  test("statusRuns all:true is equivalent to default retained-run status", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = workflow({
      name: "completes-all-flag-wf",
      description: "",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    }) as WorkflowDefinition;

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.deepEqual(statusRuns({ all: true, store }), statusRuns({ store }));
  });
});

// ---------------------------------------------------------------------------
// RFC §6 — killRun aborts delayed stage, records killed terminal state
// ---------------------------------------------------------------------------

describe("killRun — aborts delayed stage and records killed state", () => {
  test("kill during active stage: store records killed status", async () => {
    const deferred = makeDeferredAdapter();
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeDelayedWorkflow("kill-during-stage-wf");

    const accepted = runDetached(def, {}, {
      store,
      cancellation,
      jobs,
      adapters: { prompt: deferred.adapter },
    });

    // Run is active — kill it
    const killResult = killRun(accepted.runId, { store, cancellation });
    assert.equal(killResult.ok, true);
    if (killResult.ok) {
      assert.equal(killResult.previousStatus, "running");
    }

    // Wait for background promise to settle after abort
    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Store must reflect killed terminal state
    const run = store.runs().find((r) => r.id === accepted.runId);
    assert.equal(run?.status, "killed");
    assert.notEqual(run?.endedAt, undefined);
  });

  test("kill signals abort to the cancellation controller", async () => {
    const deferred = makeDeferredAdapter();
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeDelayedWorkflow("kill-aborts-controller-wf");

    const accepted = runDetached(def, {}, {
      store,
      cancellation,
      jobs,
      adapters: { prompt: deferred.adapter },
    });

    // Before kill: not aborted
    assert.equal(cancellation.isAborted(accepted.runId), false);

    killRun(accepted.runId, { store, cancellation });

    // After kill: aborted
    assert.equal(cancellation.isAborted(accepted.runId), true);

    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
  });

  test("kill result: ok:false not_found for unknown runId", () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const result = killRun("no-such-run", { store, cancellation });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_found");
    }
  });

  test("kill after already killed: ok:false already_ended", async () => {
    const deferred = makeDeferredAdapter();
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeDelayedWorkflow("double-kill-wf");

    const accepted = runDetached(def, {}, {
      store,
      cancellation,
      jobs,
      adapters: { prompt: deferred.adapter },
    });

    killRun(accepted.runId, { store, cancellation });

    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Second kill attempt
    const secondKill = killRun(accepted.runId, { store, cancellation });
    assert.equal(secondKill.ok, false);
    if (!secondKill.ok) {
      assert.equal(secondKill.reason, "already_ended");
    }
  });
});

// ---------------------------------------------------------------------------
// RFC §7 — detached rejection swallowed; store records failed status
// ---------------------------------------------------------------------------

describe("runDetached — rejection swallowed, failed status recorded", () => {
  test("throwing workflow: background promise resolves (no unhandled rejection)", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeThrowingWorkflow("throwing-wf");

    const accepted = runDetached(def, {}, { store, cancellation, jobs });

    // Track any unhandled rejection
    let unhandledRejection: unknown = undefined;
    const handler = (reason: unknown) => { unhandledRejection = reason; };
    process.on("unhandledRejection", handler);

    // Wait for background to settle — voidPromise must fulfill (swallows rejection)
    const job = jobs.get(accepted.runId);
    assert.notEqual(job, undefined);
    // The void promise should resolve (not reject) because runner swallows errors
    assert.equal(await job!.promise, undefined);

    // Give event loop a tick for any unhandled rejection to surface
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", handler);

    assert.equal(unhandledRejection, undefined);
  });

  test("throwing workflow: store records failed status after background settles", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeThrowingWorkflow("throwing-status-wf");

    const accepted = runDetached(def, {}, { store, cancellation, jobs });

    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const run = store.runs().find((r) => r.id === accepted.runId);
    assert.equal(run?.status, "failed");
    assert.notEqual(run?.endedAt, undefined);
  });

  test("job unregistered from tracker after rejection settles", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const def = makeThrowingWorkflow("throwing-unregister-wf");

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    assert.equal(jobs.has(accepted.runId), true);

    const job = jobs.get(accepted.runId);
    if (job) await job.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(jobs.has(accepted.runId), false);
  });
});
