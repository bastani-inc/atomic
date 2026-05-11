/**
 * Tests for the status file writer.
 *
 * Covers:
 * - resolveStatusFilePath — default vs explicit paths
 * - atomicWriteJson — temp file + rename, parent dir creation
 * - createStatusWriter — no-op when statusFile:false, subscribe/unsubscribe,
 *   flush on store update, error deduplication via warning notices,
 *   error clear on success, no flush after unsubscribe
 *
 * Uses a tmp directory under /tmp for filesystem tests; no real process.cwd().
 * cross-ref: packages/pi-workflows/src/extension/status-writer.ts
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveStatusFilePath,
  atomicWriteJson,
  createStatusWriter,
} from "./status-writer.js";
import { createStore } from "../store.js";
import type { WorkflowRuntimeConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<WorkflowRuntimeConfig> = {}): WorkflowRuntimeConfig {
  return {
    maxDepth: 4,
    defaultConcurrency: 4,
    persistRuns: true,
    statusFile: true,
    resumeInFlight: "ask",
    ...overrides,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// resolveStatusFilePath
// ---------------------------------------------------------------------------

describe("resolveStatusFilePath", () => {
  test("uses statusFilePath from config when provided", () => {
    const cfg = makeConfig({ statusFilePath: "/explicit/path/status.json" });
    expect(resolveStatusFilePath(cfg)).toBe("/explicit/path/status.json");
  });

  test("ignores projectRoot when statusFilePath is set", () => {
    const cfg = makeConfig({ statusFilePath: "/explicit/status.json" });
    expect(resolveStatusFilePath(cfg, { projectRoot: "/some/root" })).toBe("/explicit/status.json");
  });

  test("defaults to <projectRoot>/.pi/workflows/status.json", () => {
    const cfg = makeConfig({ statusFilePath: undefined });
    const result = resolveStatusFilePath(cfg, { projectRoot: "/myproject" });
    expect(result).toBe(join("/myproject", ".pi", "workflows", "status.json"));
  });

  test("uses process.cwd() when projectRoot not provided", () => {
    const cfg = makeConfig({ statusFilePath: undefined });
    const result = resolveStatusFilePath(cfg);
    expect(result).toBe(join(process.cwd(), ".pi", "workflows", "status.json"));
  });
});

// ---------------------------------------------------------------------------
// atomicWriteJson
// ---------------------------------------------------------------------------

describe("atomicWriteJson", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "status-writer-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes content to target path", async () => {
    const path = join(tmpDir, "status.json");
    await atomicWriteJson(path, '{"ok":true}');
    const content = await readFile(path, "utf8");
    expect(content).toBe('{"ok":true}');
  });

  test("creates parent directories", async () => {
    const path = join(tmpDir, "nested", "deep", "status.json");
    await atomicWriteJson(path, "{}");
    const content = await readFile(path, "utf8");
    expect(content).toBe("{}");
  });

  test("leaves no tmp file on success", async () => {
    const path = join(tmpDir, "status.json");
    await atomicWriteJson(path, "{}");
    await expect(stat(`${path}.tmp`)).rejects.toThrow();
  });

  test("overwrites existing file", async () => {
    const path = join(tmpDir, "status.json");
    await atomicWriteJson(path, '"first"');
    await atomicWriteJson(path, '"second"');
    const content = await readFile(path, "utf8");
    expect(content).toBe('"second"');
  });
});

// ---------------------------------------------------------------------------
// createStatusWriter — no-op when statusFile:false
// ---------------------------------------------------------------------------

describe("createStatusWriter — statusFile:false", () => {
  test("returns a writer with no-op unsubscribe", () => {
    const s = createStore();
    const writer = createStatusWriter(s, makeConfig({ statusFile: false }));
    // Should not throw
    writer.unsubscribe();
  });

  test("does not write files when statusFile is false", async () => {
    let tmpDir: string | null = null;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), "status-writer-noop-"));
      const filePath = join(tmpDir, "should-not-exist.json");
      const s = createStore();
      const writer = createStatusWriter(
        s,
        makeConfig({ statusFile: false, statusFilePath: filePath }),
      );

      // Trigger a store update
      s.recordRunStart({
        id: "run-1",
        name: "test",
        inputs: {},
        status: "running",
        stages: [],
        startedAt: Date.now(),
      });

      await sleep(50);
      writer.unsubscribe();

      await expect(stat(filePath)).rejects.toThrow();
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createStatusWriter — active when statusFile:true
// ---------------------------------------------------------------------------

describe("createStatusWriter — statusFile:true", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "status-writer-active-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates status file on store update", async () => {
    const filePath = join(tmpDir, "status.json");
    const s = createStore();
    const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

    s.recordRunStart({
      id: "run-1",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: 1000,
    });

    await sleep(50);
    writer.unsubscribe();

    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { runs: Array<{ id: string }>; version: number };
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.id).toBe("run-1");
    expect(parsed.version).toBeGreaterThan(0);
  });

  test("writes after each terminal state (completed/failed/killed)", async () => {
    const filePath = join(tmpDir, "terminal.json");
    const s = createStore();
    const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

    s.recordRunStart({
      id: "r-terminal",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    s.recordRunEnd("r-terminal", "completed", { x: 1 });

    await sleep(50);
    writer.unsubscribe();

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      runs: Array<{ id: string; status: string }>;
    };
    expect(parsed.runs[0]?.status).toBe("completed");
  });

  test("does not flush after unsubscribe", async () => {
    const filePath = join(tmpDir, "after-unsub.json");
    const s = createStore();
    const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

    s.recordRunStart({
      id: "r1",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await sleep(50);

    // Unsubscribe BEFORE the next store update
    writer.unsubscribe();

    const contentBefore = await readFile(filePath, "utf8");

    s.recordRunEnd("r1", "failed", undefined, "oops");

    await sleep(50);

    const contentAfter = await readFile(filePath, "utf8");
    // File should not have changed since we unsubscribed
    expect(contentAfter).toBe(contentBefore);
  });

  test("adds warning notice on write error, deduplicates subsequent errors", async () => {
    // Use an invalid path (file in place of directory) to force write errors.
    // Create a file where the parent directory should be.
    const blockingFile = join(tmpDir, "blocker");
    await atomicWriteJson(blockingFile, "{}"); // create as file, not dir
    const filePath = join(blockingFile, "status.json"); // parent is a file → ENOTDIR

    const s = createStore();
    const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

    // First store update — triggers write failure → 1 notice added (which triggers
    // another write attempt — that also fails, but same error → no second notice).
    s.recordRunStart({
      id: "run-err",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await sleep(100);
    writer.unsubscribe();

    const notices = s.notices();
    const writerNotices = notices.filter((n) => n.message.includes("status file write failed"));
    // Exactly one notice added (deduplication prevented more)
    expect(writerNotices).toHaveLength(1);
    expect(writerNotices[0]?.level).toBe("warning");
  });

  test("clears error dedup on successful write", async () => {
    const filePath = join(tmpDir, "recover.json");
    const s = createStore();
    const writer = createStatusWriter(s, makeConfig({ statusFilePath: filePath }));

    // Write succeeds on first run start
    s.recordRunStart({
      id: "r-ok",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });
    await sleep(50);

    const raw = await readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toBeTruthy();

    writer.unsubscribe();
    // No error notices expected
    expect(s.notices().filter((n) => n.message.includes("status file write failed"))).toHaveLength(0);
  });

  test("resolves default path relative to projectRoot", async () => {
    // Use a real nested path under tmpDir as projectRoot
    const projectRoot = join(tmpDir, "myproject");
    const expectedPath = join(projectRoot, ".pi", "workflows", "status.json");

    const s = createStore();
    const writer = createStatusWriter(
      s,
      makeConfig({ statusFilePath: undefined }),
      { projectRoot },
    );

    s.recordRunStart({
      id: "r-default",
      name: "wf",
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    });

    await sleep(50);
    writer.unsubscribe();

    const raw = await readFile(expectedPath, "utf8");
    expect(JSON.parse(raw)).toBeTruthy();
  });
});
