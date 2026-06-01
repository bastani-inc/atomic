/**
 * Unit tests for `createStageControlRegistry`.
 *
 * Verifies:
 *  - register/unregister keyed by runId + stageId
 *  - detachControl keeps chat resolvable while dropping run-level control
 *  - run-level aggregate fans pause to currently-pausable stages
 *  - resume only releases paused stages
 *  - cleared/unknown handles are no-ops, not errors
 *
 * cross-ref: src/runs/foreground/stage-control-registry.ts
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
    createStageControlRegistry,
    type StageControlHandle,
    type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { AgentSession } from "@bastani/atomic";

interface MockHandleState {
    pauseCalls: number;
    resumeCalls: number;
    lastResumeMessage?: string;
}

function makeHandle(
    runId: string,
    stageId: string,
    opts: { status?: StageControlStatus; state?: MockHandleState } = {},
): StageControlHandle {
    const state = opts.state ?? { pauseCalls: 0, resumeCalls: 0 };
    let status: StageControlStatus = opts.status ?? "running";
    return {
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
            state.lastResumeMessage = message;
            status = "running";
        },
        subscribe() {
            return () => {};
        },
    };
}

describe("stageControlRegistry — register/get/forRun/run", () => {
    test("register makes the handle resolvable by runId + stageId", () => {
        const r = createStageControlRegistry();
        const h = makeHandle("run-1", "stage-a");
        r.register(h);
        assert.equal(r.get("run-1", "stage-a"), h);
        assert.equal(r.forRun("run-1").length, 1);
    });

    test("unregister callback removes only the registered handle", () => {
        const r = createStageControlRegistry();
        const h1 = makeHandle("run-1", "stage-a");
        const h2 = makeHandle("run-1", "stage-b");
        const off = r.register(h1);
        r.register(h2);
        off();
        assert.equal(r.get("run-1", "stage-a"), undefined);
        assert.equal(r.get("run-1", "stage-b"), h2);
    });

    test("detachControl keeps chat attachment resolvable but removes run-level control", async () => {
        const r = createStageControlRegistry();
        const state = { pauseCalls: 0, resumeCalls: 0 };
        const h = makeHandle("run-1", "stage-a", { status: "running", state });
        r.register(h);

        assert.equal(r.detachControl("run-1", "stage-a", h), true);
        assert.equal(r.get("run-1", "stage-a"), h);
        assert.equal(r.forRun("run-1")[0], h);
        assert.deepEqual(r.run("run-1").stages(), []);

        const paused = await r.run("run-1").pause("stage-a");
        assert.deepEqual(paused, []);
        assert.equal(state.pauseCalls, 0);
    });

    test("forRun returns empty for unknown run", () => {
        const r = createStageControlRegistry();
        assert.deepEqual(r.forRun("nope"), []);
    });

    test("clear drops every registration", () => {
        const r = createStageControlRegistry();
        r.register(makeHandle("run-1", "stage-a"));
        r.register(makeHandle("run-2", "stage-b"));
        r.clear();
        assert.equal(r.get("run-1", "stage-a"), undefined);
        assert.equal(r.get("run-2", "stage-b"), undefined);
    });

    test("clear disposes retained direct chat handles", () => {
        const r = createStageControlRegistry();
        let disposeCalls = 0;
        r.register({
            ...makeHandle("run-1", "stage-a"),
            dispose() {
                disposeCalls += 1;
            },
        });
        r.clear();
        assert.equal(disposeCalls, 1);
    });

    test("clear disposes detached direct chat handles", () => {
        const r = createStageControlRegistry();
        let disposeCalls = 0;
        const handle = {
            ...makeHandle("run-1", "stage-a"),
            dispose() {
                disposeCalls += 1;
            },
        };
        r.register(handle);
        assert.equal(r.detachControl("run-1", "stage-a", handle), true);

        r.clear();

        assert.equal(disposeCalls, 1);
        assert.equal(r.get("run-1", "stage-a"), undefined);
    });

    test("clear observes asynchronous dispose failures", async () => {
        const r = createStageControlRegistry();
        const previousWarn = console.warn;
        let logged = false;
        console.warn = () => {
            logged = true;
        };
        try {
            r.register({
                ...makeHandle("run-1", "stage-a"),
                async dispose() {
                    throw new Error("dispose failed");
                },
            });

            assert.doesNotThrow(() => r.clear());
            await Promise.resolve();

            assert.equal(logged, true);
            assert.equal(r.get("run-1", "stage-a"), undefined);
        } finally {
            console.warn = previousWarn;
        }
    });
});

describe("stageControlRegistry — pause fan-out", () => {
    test("run.pause() pauses every running/pending stage", async () => {
        const r = createStageControlRegistry();
        const s1 = { pauseCalls: 0, resumeCalls: 0 };
        const s2 = { pauseCalls: 0, resumeCalls: 0 };
        r.register(makeHandle("run-1", "a", { status: "running", state: s1 }));
        r.register(makeHandle("run-1", "b", { status: "pending", state: s2 }));
        const paused = await r.run("run-1").pause();
        assert.equal(paused.length, 2);
        assert.equal(s1.pauseCalls, 1);
        assert.equal(s2.pauseCalls, 1);
    });

    test("run.pause(stageId) targets a single stage", async () => {
        const r = createStageControlRegistry();
        const s1 = { pauseCalls: 0, resumeCalls: 0 };
        const s2 = { pauseCalls: 0, resumeCalls: 0 };
        r.register(makeHandle("run-1", "a", { status: "running", state: s1 }));
        r.register(makeHandle("run-1", "b", { status: "running", state: s2 }));
        const paused = await r.run("run-1").pause("a");
        assert.equal(paused.length, 1);
        assert.equal(s1.pauseCalls, 1);
        assert.equal(s2.pauseCalls, 0);
    });

    test("run.pause() skips already-paused / settled stages", async () => {
        const r = createStageControlRegistry();
        const settled = { pauseCalls: 0, resumeCalls: 0 };
        const paused = { pauseCalls: 0, resumeCalls: 0 };
        r.register(
            makeHandle("run-1", "done", {
                status: "completed",
                state: settled,
            }),
        );
        r.register(
            makeHandle("run-1", "stopped", { status: "paused", state: paused }),
        );
        const result = await r.run("run-1").pause();
        assert.equal(result.length, 0);
        assert.equal(settled.pauseCalls, 0);
        assert.equal(paused.pauseCalls, 0);
    });
});

describe("stageControlRegistry — resume fan-out", () => {
    test("run.resume() resumes only paused stages and forwards message", async () => {
        const r = createStageControlRegistry();
        const running: MockHandleState = { pauseCalls: 0, resumeCalls: 0 };
        const paused: MockHandleState = { pauseCalls: 0, resumeCalls: 0 };
        r.register(
            makeHandle("run-1", "a", { status: "running", state: running }),
        );
        r.register(
            makeHandle("run-1", "b", { status: "paused", state: paused }),
        );
        const resumed = await r.run("run-1").resume(undefined, "go on");
        assert.equal(resumed.length, 1);
        assert.equal(running.resumeCalls, 0);
        assert.equal(paused.resumeCalls, 1);
        assert.equal(paused.lastResumeMessage, "go on");
    });

    test("run.resume() targeting unknown stage is a no-op", async () => {
        const r = createStageControlRegistry();
        r.register(makeHandle("run-1", "a", { status: "paused" }));
        const resumed = await r.run("run-1").resume("missing");
        assert.equal(resumed.length, 0);
    });

    test("pausedStages() returns only paused entries", () => {
        const r = createStageControlRegistry();
        r.register(makeHandle("run-1", "a", { status: "running" }));
        r.register(makeHandle("run-1", "b", { status: "paused" }));
        const stages = r.run("run-1").pausedStages();
        assert.equal(stages.length, 1);
        assert.equal(stages[0]!.stageId, "b");
    });
});
