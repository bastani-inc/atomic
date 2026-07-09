import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentStartupMaintenance } from "../../packages/subagents/src/extension/startup-maintenance.ts";
import type { SubagentState } from "../../packages/subagents/src/shared/types.ts";
import type { ExtensionAPI } from "@bastani/atomic";

const roots: string[] = [];

function makeState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    subagentInProgress: false,
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

function pi(): ExtensionAPI {
  return {
    events: {
      emit: () => {},
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("subagent startup maintenance", () => {
  test("watcher startup is scheduled on a macrotask instead of running synchronously", async () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-subagent-maintenance-"));
    roots.push(root);
    const state = makeState();
    const maintenance = createSubagentStartupMaintenance(pi(), state, {
      resultsDir: root,
      artifactCleanupDays: 1,
      resultTtlMs: 1000,
    });

    maintenance.startResultWatcherDeferred();

    assert.equal(state.watcher, null, "watcher should not start during extension registration/session_start");
    await nextImmediate();
    assert.notEqual(state.watcher, null, "watcher should start after a macrotask yield");
    maintenance.stop();
    assert.equal(state.watcher, null);
  });
});
