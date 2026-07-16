import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileDurableBackend,
  WorkflowFileDurableBackend,
  durableStateFileFor,
} from "../../packages/workflows/src/durable/file-backend.js";
import { FileDurableCatalog, type FileCatalogSource } from "../../packages/workflows/src/durable/file-catalog.js";
import { resolveCompletedWorkflow } from "../../packages/workflows/src/durable/completed-catalog.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { prepareWorkflowResumeCatalog } from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";

let durableDir = "";

beforeEach(() => {
  durableDir = mkdtempSync(join(tmpdir(), "atomic-durable-catalog-"));
});

afterEach(() => {
  rmSync(durableDir, { recursive: true, force: true });
  setDurableBackend(undefined);
});

function registerPaused(backend: WorkflowFileDurableBackend, workflowId: string, createdAt = 1): void {
  backend.registerWorkflow({ workflowId, name: `flow-${workflowId}`, inputs: {}, createdAt, status: "running" });
  backend.recordCheckpoint({
    kind: "tool",
    workflowId,
    checkpointId: "tool:1",
    name: "seed",
    argsHash: `hash-${workflowId}`,
    output: "done",
    completedAt: createdAt + 1,
  });
  backend.setWorkflowStatus(workflowId, "paused");
}

function writePausedState(workflowId: string, createdAt: number): void {
  writeFileSync(durableStateFileFor(durableDir, workflowId), JSON.stringify({
    version: 2,
    workflows: [{
      handle: {
        workflowId,
        name: `flow-${workflowId}`,
        inputs: {},
        createdAt,
        updatedAt: createdAt + 1,
        status: "paused",
        completedCheckpoints: 1,
        pendingPrompts: 0,
      },
      checkpoints: [{
        kind: "tool",
        workflowId,
        checkpointId: "tool:1",
        name: "seed",
        argsHash: `hash-${workflowId}`,
        output: "done",
        completedAt: createdAt + 1,
      }],
    }],
    deletedWorkflowIds: [],
  }));
}

function pausedCatalogSource(workflowId: string, createdAt: number): FileCatalogSource {
  const stateFile = durableStateFileFor(durableDir, workflowId);
  const stats = statSync(stateFile);
  return {
    record: {
      handle: {
        workflowId,
        name: `flow-${workflowId}`,
        inputs: {},
        createdAt,
        updatedAt: createdAt + 1,
        status: "paused",
        completedCheckpoints: 1,
        pendingPrompts: 0,
      },
      checkpoints: [{
        kind: "tool",
        workflowId,
        checkpointId: "tool:1",
        name: "seed",
        argsHash: `hash-${workflowId}`,
        output: "done",
        completedAt: createdAt + 1,
      }],
    },
    stateFile,
    stateMtimeMs: stats.mtimeMs,
    stateSize: stats.size,
    completedOpenable: false,
  };
}

function waitForFile(filePath: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return existsSync(filePath);
}

describe("durable workflow catalog index", () => {
  test("builds a missing persistent index from authoritative durable files", async () => {
    const writer = new WorkflowFileDurableBackend(durableDir);
    registerPaused(writer, "missing-index");
    rmSync(join(durableDir, ".catalog"), { recursive: true, force: true });

    const reader = new WorkflowFileDurableBackend(durableDir);
    const catalog = await reader.prepareWorkflowCatalog();

    assert.deepEqual(catalog.resumable.map((entry) => entry.workflowId), ["missing-index"]);
    assert.deepEqual(catalog.completed, []);
    assert.equal(existsSync(join(durableDir, ".catalog", "workflow-catalog.sqlite")), true);
  });

  test("updates indexed rows incrementally after durable mutations", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    registerPaused(backend, "first", 10);
    await backend.prepareWorkflowCatalog();

    backend.setWorkflowStatus("first", "failed", 0, true);
    registerPaused(backend, "second", 20);

    const catalog = await new WorkflowFileDurableBackend(durableDir).prepareWorkflowCatalog();
    assert.deepEqual(catalog.resumable.map((entry) => entry.workflowId), ["second", "first"]);
    assert.equal(catalog.resumable.find((entry) => entry.workflowId === "first")?.status, "failed");
  });

  test("self-heals a corrupt catalog from authoritative state", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    registerPaused(backend, "corrupt-index");
    await backend.prepareWorkflowCatalog();

    const databasePath = join(durableDir, ".catalog", "workflow-catalog.sqlite");
    const corruptor = new Database(databasePath);
    corruptor.run("DROP TABLE runs");
    corruptor.close();

    const healed = await new WorkflowFileDurableBackend(durableDir).prepareWorkflowCatalog();
    assert.deepEqual(healed.resumable.map((entry) => entry.workflowId), ["corrupt-index"]);
  });

  test("does not let an incremental write bless an unrelated external deletion", async () => {
    const initial = new WorkflowFileDurableBackend(durableDir);
    registerPaused(initial, "externally-deleted", 10);
    registerPaused(initial, "incremental", 20);
    await initial.prepareWorkflowCatalog();
    await Bun.sleep(10);

    rmSync(durableStateFileFor(durableDir, "externally-deleted"));
    const incremental = new WorkflowFileDurableBackend(durableDir);
    incremental.setWorkflowStatus("incremental", "failed", 0, true);

    const reconciled = await new WorkflowFileDurableBackend(durableDir).prepareWorkflowCatalog();
    assert.equal(reconciled.resumable.some((entry) => entry.workflowId === "externally-deleted"), false);
    assert.equal(reconciled.resumable.find((entry) => entry.workflowId === "incremental")?.status, "failed");
  });

  test("self-heals a stale catalog after an external durable file appears", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    registerPaused(backend, "indexed", 10);
    await backend.prepareWorkflowCatalog();

    const workflowId = "external";
    writeFileSync(durableStateFileFor(durableDir, workflowId), JSON.stringify({
      version: 2,
      workflows: [{
        handle: {
          workflowId,
          name: "external-flow",
          inputs: {},
          createdAt: 20,
          updatedAt: 21,
          status: "paused",
          completedCheckpoints: 1,
          pendingPrompts: 0,
        },
        checkpoints: [{
          kind: "tool",
          workflowId,
          checkpointId: "tool:1",
          name: "seed",
          argsHash: "external-hash",
          output: "done",
          completedAt: 21,
        }],
      }],
      deletedWorkflowIds: [],
    }));

    const healed = await new WorkflowFileDurableBackend(durableDir).prepareWorkflowCatalog();
    assert.deepEqual(healed.resumable.map((entry) => entry.workflowId), ["indexed", "external"]);
  });

  test("keeps every eligible run across age and viewport-count boundaries", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    const oneYearAgo = Date.now() - 366 * 24 * 60 * 60 * 1_000;
    for (let index = 0; index < 25; index += 1) {
      backend.registerWorkflow({
        workflowId: `retained-${String(index).padStart(2, "0")}`,
        name: "retained-flow",
        inputs: {},
        createdAt: oneYearAgo - index,
        updatedAt: oneYearAgo - index,
        status: "paused",
        completedCheckpoints: 1,
      });
    }

    const catalog = await backend.prepareWorkflowCatalog();
    assert.equal(catalog.resumable.length, 25);
    assert.equal(catalog.resumable.some((entry) => entry.workflowId === "retained-24"), true);
    assert.equal(durableStateFilesInFixture(), 25);
  });


  test("hydrates completed transcripts lazily and repairs a stale selected row", async () => {
    const backend = new WorkflowFileDurableBackend(durableDir);
    const sessionDir = join(durableDir, "sessions");
    const transcript = join(sessionDir, "completed.jsonl");
    mkdirSync(sessionDir);
    writeFileSync(transcript, [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "completed-session",
        timestamp: new Date().toISOString(),
        cwd: durableDir,
      }),
      JSON.stringify({
        type: "message",
        id: "completed-message",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "context", timestamp: Date.now() },
      }),
    ].join("\n") + "\n");
    backend.registerWorkflow({
      workflowId: "completed-lazy",
      name: "completed-flow",
      inputs: {},
      createdAt: 1,
      status: "running",
    });
    backend.recordCheckpoint({
      kind: "stage",
      workflowId: "completed-lazy",
      checkpointId: "stage:1",
      name: "final",
      replayKey: "stage:final:1",
      sessionFile: transcript,
      completedAt: 2,
    });
    backend.setWorkflowStatus("completed-lazy", "completed");
    const indexed = await backend.prepareWorkflowCatalog();
    assert.deepEqual(indexed.completed.map((entry) => entry.workflowId), ["completed-lazy"]);

    rmSync(transcript);
    const stale = resolveCompletedWorkflow("completed-lazy", backend, indexed.completed);
    assert.equal(stale.kind, "stale");
    assert.deepEqual((await backend.prepareWorkflowCatalog()).completed, []);
    assert.equal(backend.getWorkflow("completed-lazy")?.status, "completed");
  });

  test("preserves a resumed running workflow when terminal pruning loses the race", () => {
    const workflowId = "terminal-resume-race";
    const stateFile = durableStateFileFor(durableDir, workflowId);
    const terminalizer = new FileDurableBackend(stateFile, workflowId);
    terminalizer.registerWorkflow({
      workflowId,
      name: "terminal-resume",
      inputs: {},
      createdAt: 1,
      status: "running",
    });
    terminalizer.setWorkflowStatus(workflowId, "cancelled");

    const resumer = new FileDurableBackend(stateFile, workflowId);
    assert.equal(resumer.transitionWorkflowStatus(workflowId, ["cancelled"], "running"), true);
    assert.equal(terminalizer.removeWorkflowFileIfPrunableTerminal(workflowId), false);

    const authoritative = new FileDurableBackend(stateFile, workflowId).getLoadableWorkflow(workflowId);
    assert.equal(authoritative?.status, "running");
    assert.equal(existsSync(stateFile), true);
  });

  test("preserves a mutation that lands during a yielding index rebuild", async () => {
    for (let index = 0; index < 600; index += 1) {
      writePausedState(`race-${String(index).padStart(3, "0")}`, index + 1);
    }
    const backend = new WorkflowFileDurableBackend(durableDir);
    const preparing = backend.prepareWorkflowCatalog();
    await Bun.sleep(0);
    backend.setWorkflowStatus("race-000", "failed", 0, true);

    const rebuilt = await preparing;
    const fresh = await new WorkflowFileDurableBackend(durableDir).prepareWorkflowCatalog();
    assert.equal(rebuilt.resumable.find((entry) => entry.workflowId === "race-000")?.status, "failed");
    assert.equal(fresh.resumable.find((entry) => entry.workflowId === "race-000")?.status, "failed");
  });

  test("does not consume a cross-process mutation marker written during rebuild publication", async () => {
    const workflowId = "publish-race";
    writePausedState(workflowId, 1);
    const source = pausedCatalogSource(workflowId, 1);
    const startedFile = join(durableDir, "writer-started");
    const doneFile = join(durableDir, "writer-done");
    let writerExited: Promise<number> | undefined;
    const sources = [source];
    sources[Symbol.iterator] = function* () {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "fixtures", "durable-catalog-race-writer.ts"),
        durableDir,
        workflowId,
        startedFile,
        doneFile,
      ], { stdout: "ignore", stderr: "inherit" });
      writerExited = child.exited;
      assert.equal(waitForFile(startedFile, 2_000), true);
      waitForFile(doneFile, 500);
      yield source;
      return undefined;
    };

    const staleRebuild = new FileDurableCatalog(durableDir);
    await staleRebuild.prepare(async () => sources);
    assert.ok(writerExited !== undefined);
    assert.equal(await writerExited, 0);

    const reconciled = await new WorkflowFileDurableBackend(durableDir).prepareWorkflowCatalog();
    assert.equal(reconciled.resumable.find((entry) => entry.workflowId === workflowId)?.status, "failed");
  });

  test("uses shared indexed metadata without per-row authoritative hydration", async () => {
    class IndexedMemoryBackend extends InMemoryDurableBackend {
      loadabilityChecks = 0;
      override isWorkflowLoadable(workflowId: string): boolean {
        this.loadabilityChecks += 1;
        return super.isWorkflowLoadable(workflowId);
      }
      async prepareWorkflowCatalog() {
        return {
          resumable: this.listResumableWorkflows(),
          completed: this.listCompletedWorkflows(),
        };
      }
    }
    const backend = new IndexedMemoryBackend();
    for (let index = 0; index < 25; index += 1) {
      backend.registerWorkflow({
        workflowId: `indexed-${index}`,
        name: "indexed-flow",
        inputs: {},
        createdAt: index,
        status: "paused",
        completedCheckpoints: 1,
      });
    }
    setDurableBackend(backend);

    const catalog = await prepareWorkflowResumeCatalog(createExtensionRuntime(), new Set());
    assert.equal(catalog.resumable.length, 25);
    assert.equal(backend.loadabilityChecks, 0);
  });
  function durableStateFilesInFixture(): number {
    return Array.from(new Bun.Glob("workflow-*.json").scanSync(durableDir)).length;
  }
});
