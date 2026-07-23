// @ts-nocheck
/**
 * Unit tests for runs/background/status.ts (status, kill, resume helpers)
 * cross-ref: spec §8.1 Phase D
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    statusRuns,
    killRun,
    killAllRuns,
    resumeRun,
    pauseRun,
    interruptRun,
    inspectRun,
} from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(id: string, parentIds: string[] = []): StageSnapshot {
    return {
        id,
        name: id,
        status: "running",
        parentIds,
        toolEvents: [],
    };
}

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
    return {
        id: "r1",
        name: "my-wf",
        inputs: {},
        status: "running",
        stages: [],
        startedAt: 1000,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// statusRuns
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// killRun
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// killAllRuns
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// interruptRun
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// resumeRun
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// pauseRun
// ---------------------------------------------------------------------------

import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type {
    StageControlHandle,
    StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { AgentSession } from "@bastani/atomic";

function registerStageHandle(
    registry: ReturnType<typeof createStageControlRegistry>,
    runId: string,
    stageId: string,
    state: { pauseCalls: number; resumeCalls: number; lastMessage?: string },
    initialStatus: StageControlStatus = "running",
): StageControlHandle {
    let status: StageControlStatus = initialStatus;
    const handle: StageControlHandle = {
        runId,
        stageId,
        stageName: `stage-${stageId}`,
        get status() {
            return status;
        },
        sessionId: undefined,
        sessionFile: undefined,
        isStreaming: false,
        messages: [] as AgentSession["messages"],
        async ensureAttached() {},
        async prompt() {},
        async steer() {},
        async followUp() {},
        async pause() {
            state.pauseCalls += 1;
            status = "paused";
        },
        async resume(message?: string) {
            state.resumeCalls += 1;
            state.lastMessage = message;
            status = "running";
        },
        subscribe() {
            return () => {};
        },
    };
    registry.register(handle);
    return handle;
}


// ---------------------------------------------------------------------------
// resumeRun — live pause/resume integration
// ---------------------------------------------------------------------------
describe("statusRuns", () => {
    test("returns empty when store has no runs", () => {
        const st = createStore();
        assert.equal(statusRuns({ store: st }).length, 0);
    });

    test("returns in-flight runs by default", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        const result = statusRuns({ store: st });
        assert.equal(result.length, 1);
        assert.equal(result[0]!.runId, "r1");
    });

    test("includes retained ended runs by default", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "completed");
        const result = statusRuns({ store: st });
        assert.equal(result.length, 1);
        assert.equal(result[0]!.runId, "r1");
        assert.equal(result[0]!.status, "completed");
    });

    test("normalizes legacy completed snapshots with incomplete returned status", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "legacy-needs-human" }));
        st.recordRunEnd("legacy-needs-human", "completed", {
            status: "needs_human",
            remaining_work: "No API key for provider: github-copilot",
        });

        const result = statusRuns({ store: st });
        const inspected = inspectRun("legacy-needs-human", { store: st });

        assert.equal(result[0]!.status, "blocked");
        assert.equal(inspected.ok, true);
        if (!inspected.ok) throw new Error("narrowing");
        assert.equal(inspected.detail.status, "blocked");
        assert.match(inspected.detail.error ?? "", /No API key for provider: github-copilot/);
    });

    test("treats all as a compatibility no-op", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "active" }));
        st.recordRunStart(makeRun({ id: "ended" }));
        st.recordRunEnd("ended", "failed");
        const defaultResult = statusRuns({ store: st });
        assert.deepEqual(statusRuns({ all: true, store: st }), defaultResult);
        assert.deepEqual(statusRuns({ all: false, store: st }), defaultResult);
    });

    test("entry has correct shape", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1", name: "test-wf", stages: [] }));
        const entry = statusRuns({ store: st })[0]!;
        assert.equal(entry.runId, "r1");
        assert.equal(entry.name, "test-wf");
        assert.equal(typeof entry.startedAt, "number");
        assert.equal(typeof entry.stageCount, "number");
    });

    test("hides nested child workflow runs and counts flattened child stages on the parent", () => {
        const st = createStore();
        st.recordRunStart(makeRun({
            id: "parent-run",
            name: "parent",
            stages: [
                {
                    ...makeStage("workflow:child"),
                    workflowChildRun: {
                        alias: "child",
                        workflow: "child",
                        runId: "child-run",
                    },
                },
            ],
        }));
        st.recordRunStart(makeRun({
            id: "child-run",
            name: "child",
            parentRunId: "parent-run",
            parentStageId: "workflow:child",
            rootRunId: "parent-run",
            stages: [makeStage("child-a"), makeStage("child-b", ["child-a"])],
        }));

        const result = statusRuns({ store: st });

        assert.deepEqual(result.map((entry) => entry.runId), ["parent-run"]);
        // The imported workflow is flattened: the boundary node is dropped and
        // only the child's two inlined stages are counted on the parent.
        assert.equal(result[0]?.stageCount, 2);
    });
});
describe("killRun", () => {
    test("returns ok:false reason:not_found for unknown runId", async () => {
        const st = createStore();
        const result = killRun("nonexistent", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "not_found");
    });

    test("returns ok:false reason:already_ended when run has ended", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "completed");
        const result = killRun("r1", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "already_ended");
    });

    test("returns ok:true and marks run as killed", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        const result = killRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.runId, "r1");
            assert.equal(result.previousStatus, "running");
        }
        const runs = st.runs();
        assert.equal(runs[0]!.status, "killed");
    });
});
describe("killAllRuns", () => {
    test("returns empty when no runs", () => {
        const st = createStore();
        assert.equal(killAllRuns({ store: st }).length, 0);
    });

    test("kills all in-flight runs", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunStart(makeRun({ id: "r2", name: "wf2" }));
        const results = killAllRuns({ store: st });
        assert.equal(results.length, 2);
        assert.equal(
            results.every((r) => r.ok),
            true,
        );
        assert.equal(
            st.runs().every((r) => r.status === "killed"),
            true,
        );
    });

    test("does not kill already-ended runs", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "completed");
        const results = killAllRuns({ store: st });
        // No in-flight runs, so returns empty
        assert.equal(results.length, 0);
    });
});
describe("interruptRun", () => {
    test("returns no_active_stages honestly when no stage handle exists", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));

        const result = await interruptRun("r1", { store: st });

        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "no_active_stages");
        const run = st.runs().find((r) => r.id === "r1");
        assert.equal(run?.status, "running");
    });
});
describe("resumeRun", () => {
    test("returns ok:false reason:not_found for unknown runId", async () => {
        const st = createStore();
        const result = await resumeRun("nonexistent", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "not_found");
    });

    test("returns ok:true with snapshot for still-active run", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1", name: "my-wf" }));
        const result = await resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.runId, "r1");
            assert.equal(result.snapshot.name, "my-wf");
            assert.equal(result.snapshot.status, "running");
        }
    });

    test("returns ok:true with snapshot for ended run", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1", name: "my-wf" }));
        st.recordRunEnd("r1", "completed");
        const result = await resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.runId, "r1");
            assert.equal(result.snapshot.name, "my-wf");
            assert.equal(result.snapshot.status, "completed");
        }
    });

    test("returned snapshot is a deep copy (not a reference)", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "failed");
        const result = await resumeRun("r1", { store: st });
        if (result.ok) {
            // Mutating the snapshot should not affect the store
            (result.snapshot as { name: string }).name = "mutated";
            const stored = st.runs().find((r) => r.id === "r1");
            assert.equal(stored!.name, "my-wf");
        }
    });

    test("failed resumable terminal run returns snapshot mode for continuation callers", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "failed", undefined, "boom", {
            failureKind: "unknown",
            failedStageId: "s1",
            resumable: true,
        });
        const result = await resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.mode, "snapshot");
            assert.equal(result.snapshot.status, "failed");
            assert.equal(result.message, undefined);
        }
    });

    test("failed non-resumable terminal run returns a clear non-resumable snapshot mode", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "failed", undefined, "boom", {
            failureKind: "cancelled",
            failureCode: "cancelled",
            failureRecoverability: "non_recoverable",
            failureDisposition: "terminal_killed",
            failedStageId: "s1",
            resumable: false,
        });
        const result = await resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.mode, "not_resumable");
            assert.equal(result.snapshot.status, "failed");
            assert.match(result.message ?? "", /not resumable/);
        }
    });

    test("killed run returns not_resumable even without explicit resumable metadata", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "killed", undefined, "bad key", {
            failureKind: "auth",
            failureCode: "invalid_api_key",
            failureRecoverability: "non_recoverable",
            failureDisposition: "terminal_killed",
            failedStageId: "s1",
            resumable: false,
        });
        const result = await resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.mode, "not_resumable");
            assert.equal(result.snapshot.status, "killed");
            assert.match(result.message ?? "", /not resumable/);
        }
    });

    test("active blocked recoverable run returns a resumable snapshot message", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordStageStart("r1", {
            id: "s1",
            name: "limited",
            status: "failed",
            parentIds: [],
            error: "rate limit",
            failureKind: "rate_limit",
            failureCode: "rate_limited",
            failureRecoverability: "recoverable",
            failureDisposition: "active_blocked",
            toolEvents: [],
        });
        st.recordRunBlocked("r1", "rate limit", {
            failureKind: "rate_limit",
            failureCode: "rate_limited",
            failureRecoverability: "recoverable",
            failureDisposition: "active_blocked",
            failureMessage: "HTTP 429",
            failedStageId: "s1",
            resumable: true,
            retryAfterMs: 1000,
            blockedAt: 1234,
        });

        const result = await resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.mode, "snapshot");
            assert.equal(result.snapshot.status, "running");
            assert.equal(result.snapshot.endedAt, undefined);
            assert.equal(result.snapshot.failureCode, "rate_limited");
            assert.equal(result.snapshot.failureRecoverability, "recoverable");
            assert.match(result.message ?? "", /blocked on a recoverable rate_limited failure/);
        }
    });
});
