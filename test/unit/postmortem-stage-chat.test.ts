/**
 * Unit tests for the shared post-mortem stage-chat resolver.
 *
 * Verifies:
 *  - eligible completed agent stages with a valid retained session revive into
 *    a detached, interactive handle that appends follow-up without mutating
 *    run/stage status;
 *  - single-flight: repeated calls reuse one handle / one session create;
 *  - explicit unavailable reasons for non-terminal / session-less / invalid /
 *    adapter-less stages so callers preserve the read-only transcript.
 *
 * cross-ref: src/runs/foreground/postmortem-stage-chat.ts
 */
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePostMortemStageHandle,
  isPostMortemEligibleStage,
} from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

let tempDir = "";
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "atomic-postmortem-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function retainedSession(name: string): string {
  const path = join(tempDir, `${name}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: `${name}-session`, timestamp: new Date().toISOString(), cwd: tempDir }),
    JSON.stringify({ type: "message", id: `${name}-message`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Original stage request" } }),
  ].join("\n") + "\n");
  return path;
}

function completedStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    id: "stage-1",
    name: "final",
    status: "completed",
    parentIds: [],
    toolEvents: [],
    ...overrides,
  };
}

function adaptersRecording(session: StageSessionRuntime, counter: { creates: number }): StageAdapters {
  return {
    agentSession: {
      async create() {
        counter.creates += 1;
        return session;
      },
    },
  };
}

describe("ensurePostMortemStageHandle", () => {
  test("revives a detached interactive handle and appends follow-up without mutating status", async () => {
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("revive");
    const promptCalls: string[] = [];
    const session: StageSessionRuntime = { ...mockSession(), sessionFile, async prompt(text: string) { promptCalls.push(text); } };
    const counter = { creates: 0 };
    const stage = completedStage({ sessionFile });

    const result = ensurePostMortemStageHandle("run-1", stage, {
      registry,
      adapters: adaptersRecording(session, counter),
      cwd: tempDir,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Detached from run-level control, still resolvable as a chat handle.
    assert.equal(registry.get("run-1", "stage-1"), result.handle);
    assert.deepEqual(registry.run("run-1").stages(), []);

    await result.handle.prompt("What next?");
    assert.equal(counter.creates, 1);
    assert.deepEqual(promptCalls, ["What next?"]);
    assert.equal(stage.status, "completed");
  });

  test("single-flights repeated calls onto one handle and one session create", async () => {
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("single-flight");
    const counter = { creates: 0 };
    const session: StageSessionRuntime = { ...mockSession(), sessionFile };
    const stage = completedStage({ sessionFile });
    const deps = { registry, adapters: adaptersRecording(session, counter), cwd: tempDir };

    const first = ensurePostMortemStageHandle("run-1", stage, deps);
    const second = ensurePostMortemStageHandle("run-1", stage, deps);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.handle, second.handle);
    await first.handle.ensureAttached();
    await second.handle.ensureAttached();
    assert.equal(counter.creates, 1);
  });

  test("disposes a pending lazy session when the registry is cleared", async () => {
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("clear-race");
    const created = Promise.withResolvers<StageSessionRuntime>();
    let disposeCalls = 0;
    const session: StageSessionRuntime = {
      ...mockSession(),
      sessionFile,
      dispose() { disposeCalls += 1; },
    };
    const stage = completedStage({ sessionFile });
    const result = ensurePostMortemStageHandle("run-1", stage, {
      registry,
      adapters: {
        agentSession: {
          async create() { return created.promise; },
        },
      },
      cwd: tempDir,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const attaching = result.handle.ensureAttached();
    await Promise.resolve();
    registry.clear();
    created.resolve(session);

    await assert.rejects(attaching, /session has been disposed/);
    assert.equal(disposeCalls, 1);
    assert.equal(result.handle.isDisposed, true);
    assert.deepEqual(registry.forRun("run-1"), []);
  });

  test("rejects post-mortem pause and resume without appending a prompt", async () => {
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("no-resume");
    const promptCalls: string[] = [];
    const counter = { creates: 0 };
    const session: StageSessionRuntime = {
      ...mockSession(),
      sessionFile,
      async prompt(text: string) { promptCalls.push(text); },
    };
    const stage = completedStage({ sessionFile });
    const result = ensurePostMortemStageHandle("run-1", stage, {
      registry,
      adapters: adaptersRecording(session, counter),
      cwd: tempDir,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const expected = /Post-mortem stage chat cannot pause or resume workflow execution\./;
    await assert.rejects(() => result.handle.pause(), expected);
    await assert.rejects(() => result.handle.resume("resume should be rejected"), expected);
    assert.deepEqual(promptCalls, []);
    assert.equal(counter.creates, 0);
    assert.equal(result.handle.status, "completed");
    assert.equal(stage.status, "completed");
  });

  test("returns not_terminal for a running stage", () => {
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("running");
    const result = ensurePostMortemStageHandle("run-1", completedStage({ status: "running", sessionFile }), {
      registry,
      adapters: adaptersRecording({ ...mockSession(), sessionFile }, { creates: 0 }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "not_terminal");
  });

  test("returns no_session when a completed stage has no retained session", () => {
    const registry = createStageControlRegistry();
    const result = ensurePostMortemStageHandle("run-1", completedStage(), {
      registry,
      adapters: adaptersRecording(mockSession(), { creates: 0 }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_session");
  });

  test("returns invalid_session for a missing / malformed transcript", () => {
    const registry = createStageControlRegistry();
    const missing = join(tempDir, "does-not-exist.jsonl");
    const result = ensurePostMortemStageHandle("run-1", completedStage({ sessionFile: missing }), {
      registry,
      adapters: adaptersRecording(mockSession(), { creates: 0 }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid_session");
  });

  test("returns no_adapter when no agent-session adapter is available", () => {
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("no-adapter");
    const result = ensurePostMortemStageHandle("run-1", completedStage({ sessionFile }), { registry });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_adapter");
  });

  test("reuses an existing non-disposed handle instead of validating again", () => {
    const registry = createStageControlRegistry();
    const sessionFile = retainedSession("existing");
    const counter = { creates: 0 };
    const stage = completedStage({ sessionFile });
    const deps = { registry, adapters: adaptersRecording({ ...mockSession(), sessionFile }, counter), cwd: tempDir };
    const first = ensurePostMortemStageHandle("run-1", stage, deps);
    assert.equal(first.ok, true);
    // Even if the session file is deleted, the existing handle is reused.
    rmSync(sessionFile);
    const second = ensurePostMortemStageHandle("run-1", stage, deps);
    assert.equal(first.ok && second.ok && first.handle === second.handle, true);
  });
});

describe("isPostMortemEligibleStage", () => {
  test("true only for completed stages with a retained session file", () => {
    assert.equal(isPostMortemEligibleStage(completedStage({ sessionFile: "/tmp/x.jsonl" })), true);
    assert.equal(isPostMortemEligibleStage(completedStage()), false);
    assert.equal(isPostMortemEligibleStage(completedStage({ status: "running", sessionFile: "/tmp/x.jsonl" })), false);
    assert.equal(isPostMortemEligibleStage(completedStage({ status: "failed", sessionFile: "/tmp/x.jsonl" })), false);
  });
});
