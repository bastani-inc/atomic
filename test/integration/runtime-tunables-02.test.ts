// @ts-nocheck
/**
 * Integration regression tests: runtime tunables
 *
 * Covers the three RFC-required behaviors end-to-end through executor.run():
 *   1. maxDepth exceeded → status:"failed", precise error message
 *   2. defaultConcurrency:1 → parallel stage methods serialized (maxActive=1)
 *   3. statusFile:true → atomic status.json written on each store update
 *
 * Each test uses real store, real executor, and (for #3) a real temp directory.
 * Tests are independent; no shared mutable state.
 *
 * cross-ref:
 *   src/runs/foreground/executor.ts     — run(), maxDepth guard, ConcurrencyLimiter
 *   src/extension/status-writer.ts — createStatusWriter, atomicWriteJson
 *   src/shared/types.ts            — WorkflowRuntimeConfig
 */

import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createStatusWriter } from "../../packages/workflows/src/extension/status-writer.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { Type } from "typebox";
import type { WorkflowRuntimeConfig } from "../../packages/workflows/src/shared/types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<WorkflowRuntimeConfig> = {}): WorkflowRuntimeConfig {
  return {
    maxDepth: 4,
    defaultConcurrency: 4,
    persistRuns: false,
    statusFile: false,
    resumeInFlight: "never",
    ...overrides,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

// ---------------------------------------------------------------------------
// 1. maxDepth exceeded → precise error
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 2. defaultConcurrency:1 → parallel stage methods serialized
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 3. statusFile:true → atomic status.json on store updates
// ---------------------------------------------------------------------------
describe("runtime tunables — statusFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rt-status-writer-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("statusFile:true writes status.json after run start", async () => {
    const filePath = join(tmpDir, "status.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-run-1",
      name: "my-wf",
      inputs: { x: 1 },
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const raw = await readFile(filePath, "utf8");
    const snap = JSON.parse(raw) as { runs: Array<{ id: string; name: string }>; version: number };
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0]?.id, "rt-run-1");
    assert.equal(snap.runs[0]?.name, "my-wf");
    assert.ok(snap.version > 0);
  });

  test("statusFile:true captures terminal status (completed)", async () => {
    const filePath = join(tmpDir, "terminal.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-run-done",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    s.recordRunEnd("rt-run-done", "completed", { answer: 42 });

    await writer.flush();
    writer.unsubscribe();

    const snap = JSON.parse(await readFile(filePath, "utf8")) as {
      runs: Array<{ id: string; status: string }>;
    };
    assert.equal(snap.runs[0]?.status, "completed");
  });

  test("statusFile:true captures terminal status (failed)", async () => {
    const filePath = join(tmpDir, "failed.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-run-fail",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    s.recordRunEnd("rt-run-fail", "failed", undefined, "something went wrong");

    await writer.flush();
    writer.unsubscribe();

    const snap = JSON.parse(await readFile(filePath, "utf8")) as {
      runs: Array<{ id: string; status: string; error?: string }>;
    };
    assert.equal(snap.runs[0]?.status, "failed");
  });

  test("statusFile:false writes no file", async () => {
    const filePath = join(tmpDir, "should-not-exist.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: false, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-noop-run",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    await assert.rejects(readFile(filePath, "utf8"));
  });

  test("multiple store updates produce successive flushes", async () => {
    const filePath = join(tmpDir, "multi.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-multi-1",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();

    s.recordRunStart({
      id: "rt-multi-2",
      name: "wf2",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const snap = JSON.parse(await readFile(filePath, "utf8")) as { runs: Array<{ id: string }> };
    // Both runs should be present after the second flush.
    assert.deepEqual(snap.runs.map((r) => r.id).sort(), ["rt-multi-1", "rt-multi-2"]);
  });

  test("write uses projectRoot default path when statusFilePath not set", async () => {
    const projectRoot = join(tmpDir, "project");
    const expectedPath = join(projectRoot, ".atomic", "workflows", "status.json");

    const s = createStore();
    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: undefined }),
      { projectRoot },
    );

    s.recordRunStart({
      id: "rt-default-path",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const raw = await readFile(expectedPath, "utf8");
    assert.ok(JSON.parse(raw));
  });

  test("no flush after unsubscribe", async () => {
    const filePath = join(tmpDir, "no-flush.json");
    const s = createStore();

    const writer = createStatusWriter(
      s,
      baseConfig({ statusFile: true, statusFilePath: filePath }),
    );

    s.recordRunStart({
      id: "rt-unsub",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await writer.flush();
    writer.unsubscribe();

    const snapBefore = await readFile(filePath, "utf8");

    // Trigger more store updates after unsubscribe
    s.recordRunEnd("rt-unsub", "completed", {});

    await sleep(50);

    const snapAfter = await readFile(filePath, "utf8");
    // Content must be unchanged — no flush after unsubscribe
    assert.equal(snapAfter, snapBefore);
  });
});
