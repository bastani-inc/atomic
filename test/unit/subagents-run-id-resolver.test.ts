import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  nestedScopeFromState,
  resolveSubagentRunId,
} from "../../packages/subagents/src/runs/background/run-id-resolver.js";
import type { NestedRoute } from "../../packages/subagents/src/runs/shared/nested-events.js";
import type { SubagentState } from "../../packages/subagents/src/shared/types.js";

type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
type AsyncJob = SubagentState["asyncJobs"] extends Map<string, infer T> ? T : never;

function makeState(): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
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

function tempRoots(): { asyncDirRoot: string; resultsDir: string } {
  const root = fs.mkdtempSync(path.join(tmpdir(), "subagent-run-resolver-"));
  return { asyncDirRoot: path.join(root, "async"), resultsDir: path.join(root, "results") };
}

describe("subagent run id resolution", () => {
  test("prefers an exact foreground run over an exact async run", () => {
    const state = makeState();
    state.foregroundControls.set("sameid", {} as ForegroundControl);
    const roots = tempRoots();
    fs.mkdirSync(path.join(roots.asyncDirRoot, "sameid"), { recursive: true });

    assert.deepEqual(resolveSubagentRunId("sameid", { state, ...roots }), { kind: "foreground", id: "sameid" });
  });

  test("resolves unique async prefixes and reports mixed-kind ambiguity", () => {
    const state = makeState();
    state.foregroundControls.set("abcforeground", {} as ForegroundControl);
    const roots = tempRoots();
    fs.mkdirSync(path.join(roots.asyncDirRoot, "asynconly"), { recursive: true });
    fs.mkdirSync(path.join(roots.asyncDirRoot, "abcasync"), { recursive: true });

    const asyncOnly = resolveSubagentRunId("async", { state, ...roots });
    assert.equal(asyncOnly?.kind, "async");
    assert.equal(asyncOnly?.id, "asynconly");

    assert.throws(
      () => resolveSubagentRunId("abc", { state, ...roots }),
      /Ambiguous subagent run id prefix 'abc' matched: foreground:abcforeground, async:abcasync/,
    );
  });

  test("rejects unsafe ids before checking registries", () => {
    assert.throws(() => resolveSubagentRunId("../bad"), /safe id token/);
  });

  test("builds a de-duplicated nested scope from foreground controls and async jobs", () => {
    const state = makeState();
    const route: NestedRoute = {
      rootRunId: "root1",
      eventSink: "/tmp/events",
      controlInbox: "/tmp/controls",
      capabilityToken: "token1",
    };
    state.foregroundControls.set("fg1", { nestedRoute: route } as ForegroundControl);
    state.asyncJobs.set("async1", { nestedRoute: route } as AsyncJob);

    const scope = nestedScopeFromState(state);
    assert.equal(scope?.routes.length, 1);
    assert.equal(scope?.routes[0], route);
  });
});
