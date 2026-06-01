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
} from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// killRun
// ---------------------------------------------------------------------------

describe("killRun", () => {
    test("returns ok:false reason:not_found for unknown runId", () => {
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

// ---------------------------------------------------------------------------
// killAllRuns
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// interruptRun
// ---------------------------------------------------------------------------

describe("interruptRun", () => {
    test("returns no_active_stages honestly when no stage handle exists", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));

        const result = interruptRun("r1", { store: st });

        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "no_active_stages");
        const run = st.runs().find((r) => r.id === "r1");
        assert.equal(run?.status, "running");
    });
});

// ---------------------------------------------------------------------------
// resumeRun
// ---------------------------------------------------------------------------

describe("resumeRun", () => {
    test("returns ok:false reason:not_found for unknown runId", () => {
        const st = createStore();
        const result = resumeRun("nonexistent", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "not_found");
    });

    test("returns ok:true with snapshot for still-active run", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1", name: "my-wf" }));
        const result = resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.runId, "r1");
            assert.equal(result.snapshot.name, "my-wf");
            assert.equal(result.snapshot.status, "running");
        }
    });

    test("returns ok:true with snapshot for ended run", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1", name: "my-wf" }));
        st.recordRunEnd("r1", "completed");
        const result = resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.runId, "r1");
            assert.equal(result.snapshot.name, "my-wf");
            assert.equal(result.snapshot.status, "completed");
        }
    });

    test("returned snapshot is a deep copy (not a reference)", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "failed");
        const result = resumeRun("r1", { store: st });
        if (result.ok) {
            // Mutating the snapshot should not affect the store
            (result.snapshot as { name: string }).name = "mutated";
            const stored = st.runs().find((r) => r.id === "r1");
            assert.equal(stored!.name, "my-wf");
        }
    });

    test("failed resumable terminal run returns snapshot mode for continuation callers", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "failed", undefined, "boom", {
            failureKind: "unknown",
            failedStageId: "s1",
            resumable: true,
        });
        const result = resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.mode, "snapshot");
            assert.equal(result.snapshot.status, "failed");
            assert.equal(result.message, undefined);
        }
    });

    test("failed non-resumable terminal run returns a clear non-resumable snapshot mode", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "failed", undefined, "boom", {
            failureKind: "cancelled",
            failedStageId: "s1",
            resumable: false,
        });
        const result = resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.mode, "not_resumable");
            assert.equal(result.snapshot.status, "failed");
            assert.match(result.message ?? "", /not resumable/);
        }
    });
});

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

describe("pauseRun", () => {
    test("rejects unknown runId without side effects", () => {
        const st = createStore();
        const result = pauseRun("unknown", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "not_found");
    });

    test("rejects already-ended runs", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "completed");
        const result = pauseRun("r1", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "already_ended");
    });

    test("rejects when no live stages are pausable", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        const registry = createStageControlRegistry();
        const result = pauseRun("r1", {
            store: st,
            stageControlRegistry: registry,
        });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "no_active_stages");
    });

    test("pauses every running stage and marks the run paused", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordStageStart("r1", {
            id: "s-a",
            name: "stage-s-a",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        st.recordStageStart("r1", {
            id: "s-b",
            name: "stage-s-b",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const registry = createStageControlRegistry();
        const a = { pauseCalls: 0, resumeCalls: 0 };
        const b = { pauseCalls: 0, resumeCalls: 0 };
        registerStageHandle(registry, "r1", "s-a", a);
        registerStageHandle(registry, "r1", "s-b", b);

        const result = pauseRun("r1", {
            store: st,
            stageControlRegistry: registry,
        });
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.paused.length, 2);
        assert.equal(a.pauseCalls, 1);
        assert.equal(b.pauseCalls, 1);
        const run = st.runs().find((r) => r.id === "r1");
        assert.equal(run?.status, "paused");
    });

    test("stage-targeted pause only pauses the requested stage", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordStageStart("r1", {
            id: "s-a",
            name: "stage-s-a",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const registry = createStageControlRegistry();
        const a = { pauseCalls: 0, resumeCalls: 0 };
        registerStageHandle(registry, "r1", "s-a", a);
        const result = pauseRun("r1", {
            store: st,
            stageControlRegistry: registry,
            stageId: "s-a",
        });
        assert.equal(result.ok, true);
        assert.equal(a.pauseCalls, 1);
    });
});

// ---------------------------------------------------------------------------
// resumeRun — live pause/resume integration
// ---------------------------------------------------------------------------

describe("resumeRun — live paused stages", () => {
    test("resumes paused stages through the registry", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordStageStart("r1", {
            id: "s-a",
            name: "stage-s-a",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        const registry = createStageControlRegistry();
        const a = {
            pauseCalls: 0,
            resumeCalls: 0,
            lastMessage: undefined as string | undefined,
        };
        registerStageHandle(registry, "r1", "s-a", a, "paused");
        st.recordStagePaused("r1", "s-a");
        st.recordRunPaused("r1");

        const result = resumeRun("r1", {
            store: st,
            stageControlRegistry: registry,
            message: "carry on",
        });
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.resumed.length, 1);
        // The resume call is fire-and-forget; flush a microtask so the handle is invoked.
        await new Promise<void>((r) => queueMicrotask(r));
        assert.equal(a.resumeCalls, 1);
        assert.equal(a.lastMessage, "carry on");
        const run = st.runs().find((r) => r.id === "r1");
        assert.equal(run?.status, "running");
    });

    test("non-paused run returns snapshot with empty resumed list", () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        const result = resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.resumed.length, 0);
            assert.equal(result.snapshot.id, "r1");
        }
    });
});
