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
describe("pauseRun", () => {
    test("rejects unknown runId without side effects", async () => {
        const st = createStore();
        const result = await pauseRun("unknown", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "not_found");
    });

    test("rejects already-ended runs", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        st.recordRunEnd("r1", "completed");
        const result = await pauseRun("r1", { store: st });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "already_ended");
    });

    test("rejects when no live stages are pausable", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        const registry = createStageControlRegistry();
        const result = await pauseRun("r1", {
            store: st,
            stageControlRegistry: registry,
        });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "no_active_stages");
    });

    test("pauses every running stage and marks the run paused", async () => {
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

        const result = await pauseRun("r1", {
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

    test("stage-targeted pause only pauses the requested stage", async () => {
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
        const result = await pauseRun("r1", {
            store: st,
            stageControlRegistry: registry,
            stageId: "s-a",
        });
        assert.equal(result.ok, true);
        assert.equal(a.pauseCalls, 1);
    });
});
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

        const result = await resumeRun("r1", {
            store: st,
            stageControlRegistry: registry,
            message: "carry on",
        });
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.resumed.length, 1);
        assert.equal(a.resumeCalls, 1);
        assert.equal(a.lastMessage, "carry on");
        const run = st.runs().find((r) => r.id === "r1");
        assert.equal(run?.status, "running");
    });

    test("rejecting resume is awaited and leaves run and stage paused", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "reject-resume" }));
        st.recordStageStart("reject-resume", {
            id: "reject-stage",
            name: "reject-stage",
            status: "running",
            parentIds: [],
            toolEvents: [],
        });
        st.recordStagePaused("reject-resume", "reject-stage");
        st.recordRunPaused("reject-resume");
        const registry = createStageControlRegistry();
        let status: StageControlStatus = "paused";
        registry.register({
            runId: "reject-resume",
            stageId: "reject-stage",
            stageName: "reject-stage",
            get status() { return status; },
            sessionId: undefined,
            sessionFile: undefined,
            isStreaming: false,
            messages: [] as AgentSession["messages"],
            async ensureAttached() {},
            async prompt() {},
            async steer() {},
            async followUp() {},
            async pause() {},
            resume() {
                const rejected = Promise.reject(new Error("resume acknowledgement failed"));
                void rejected.catch(() => {});
                return rejected;
            },
            subscribe: () => () => {},
        });

        await assert.rejects(
            Promise.resolve(resumeRun("reject-resume", { store: st, stageControlRegistry: registry })),
            /resume acknowledgement failed/,
        );
        assert.equal(status, "paused");
        assert.equal(st.runs().find((run) => run.id === "reject-resume")?.status, "paused");
        assert.equal(st.runs().find((run) => run.id === "reject-resume")?.stages[0]?.status, "paused");
    });

    test("non-paused run returns snapshot with empty resumed list", async () => {
        const st = createStore();
        st.recordRunStart(makeRun({ id: "r1" }));
        const result = await resumeRun("r1", { store: st });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.resumed.length, 0);
            assert.equal(result.snapshot.id, "r1");
        }
    });
});
