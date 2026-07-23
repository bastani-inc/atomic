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


afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("subagent startup maintenance", () => {
  test("watcher startup is scheduled on a macrotask instead of running synchronously", () => {
    const root = mkdtempSync(join(tmpdir(), "atomic-subagent-maintenance-"));
    roots.push(root);
    const state = makeState();
    const scheduled: Array<() => void> = [];
    const maintenance = createSubagentStartupMaintenance(pi(), state, {
      resultsDir: root,
      artifactCleanupDays: 1,
      resultTtlMs: 1000,
      scheduleMacrotask: (task) => {
        scheduled.push(task);
        return () => undefined;
      },
    });

    try {
      maintenance.startResultWatcherDeferred();

      assert.equal(state.watcher, null, "watcher should not start during extension registration/session_start");
      assert.equal(scheduled.length, 1);
      scheduled[0]!();
      assert.notEqual(state.watcher, null, "watcher should start when the deferred task runs");
    } finally {
      maintenance.stop();
    }
    assert.equal(state.watcher, null);
  });
});
