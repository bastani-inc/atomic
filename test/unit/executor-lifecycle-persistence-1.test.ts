import { describe, beforeAll, afterAll } from "bun:test";
import {
    assert, createStore, workflow, run, test, Type,
} from "./executor-shared.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";

describe("executor.run — lifecycle persistence", () => {
  // The durable cache-entry append checked below requires a persistent durable
  // backend. Other test files in this suite mutate the global backend singleton
  // (bun shares process state across files); reset to the clean default here so
  // this file is deterministic regardless of execution order, and reset again on
  // teardown so no in-memory backend leaks into later files.
  beforeAll(() => setDurableBackend(undefined));
  afterAll(() => setDurableBackend(undefined));
    function makePersistence() {
        const calls: Array<{ type: string; payload: Record<string, unknown> }> =
            [];
        const persistence = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
            setLabel(_entryId: string, _label: string): void {},
        };
        return { persistence, calls };
    }

    function lifecycleTypes(calls: Array<{ type: string }>): string[] {
        return calls.map((c) => c.type).filter((type) => type !== "workflow.durable.checkpoint");
    }

    test("appends ordered run.start → stage.start → stage.end → run.end on success", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({
          name: "persist-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx.stage("s1").prompt("go");
                return { ok: true };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "done" } },
                store: createStore(),
                persistence,
            },
        );

        assert.equal(wfResult.status, "completed");

        const types = lifecycleTypes(calls);
        assert.deepEqual(types, [
            "workflow.run.start",
            "workflow.stage.start",
            "workflow.stage.end",
            "workflow.run.end",
        ]);
        assert.equal(calls.some((c) => c.type === "workflow.durable.checkpoint"), true);
    });

    test("run.start payload contains runId, name, inputs, ts", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({
          name: "payload-wf",
          description: "",
          inputs: {
            x: Type.Optional(Type.Number()),
          },
          outputs: {},
          run: async (ctx) => {
                await ctx.task("payload-smoke", { prompt: "go" });
                return {};
            },
        });

        const wfResult = await run(
            def,
            { x: 1 },
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
                persistence,
            },
        );

        const runStart = calls.find((c) => c.type === "workflow.run.start");
        assert.notEqual(runStart, undefined);
        assert.equal(runStart?.payload["runId"], wfResult.runId);
        assert.equal(runStart?.payload["name"], "payload-wf");
        assert.deepEqual(runStart?.payload["inputs"], { x: 1 }); // TODO: was toMatchObject — may need subset check;
        assert.equal(typeof runStart?.payload["ts"], "number");
    });

    test("stage.start payload contains runId, stageId, name, parentIds", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({ name: "stage-payload-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.stage("my-stage").prompt("x");
                return {};
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "r" } },
                store: createStore(),
                persistence,
            },
        );

        const stageStart = calls.find((c) => c.type === "workflow.stage.start");
        assert.notEqual(stageStart, undefined);
        assert.equal(stageStart?.payload["runId"], wfResult.runId);
        assert.equal(stageStart?.payload["name"], "my-stage");
        assert.equal(Array.isArray(stageStart?.payload["parentIds"]), true);
    });

    test("stage.end payload contains status completed on success", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({ name: "stage-end-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.stage("s").prompt("x");
                return {};
            },
        });

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "r" } },
                store: createStore(),
                persistence,
            },
        );

        const stageEnd = calls.find((c) => c.type === "workflow.stage.end");
        assert.equal(stageEnd?.payload["status"], "completed");
    });

    test("run.end payload contains status completed on success", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({
          name: "run-end-wf",
          description: "",
          inputs: {},
          outputs: {
            x: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx.task("run-end-smoke", { prompt: "go" });
                return { x: 1 };
            },
        });

        await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
                persistence,
            },
        );

        const runEnd = calls.find((c) => c.type === "workflow.run.end");
        assert.equal(runEnd?.payload["status"], "completed");
        assert.equal(typeof runEnd?.payload["ts"], "number");
    });

    test("empty graph validation appends failed run.end without stage entries", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({
          name: "empty-persist-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Optional(Type.Any()),
          },
          run: async () => ({ ok: true }),
        });

        const wfResult = await run(
            def,
            {},
            {
                store: createStore(),
                persistence,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.match(
            wfResult.error ?? "",
            /completed without creating any workflow stages/,
        );
        assert.deepEqual(
            lifecycleTypes(calls),
            ["workflow.run.start", "workflow.run.end"],
        );
        const runEnd = calls.find((c) => c.type === "workflow.run.end");
        assert.equal(runEnd?.payload["status"], "failed");
        assert.match(
            String(runEnd?.payload["error"] ?? ""),
            /completed without creating any workflow stages/,
        );
    });

    test("failed stage: stage.end status=failed, run.end status=failed", async () => {
        const { persistence, calls } = makePersistence();

        const def = workflow({ name: "fail-persist-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.stage("bad").prompt("x");
                return {};
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw new Error("boom");
                        },
                    },
                },
                store: createStore(),
                persistence,
            },
        );

        assert.equal(wfResult.status, "failed");

        const stageEnd = calls.find((c) => c.type === "workflow.stage.end");
        assert.equal(stageEnd?.payload["status"], "failed");
        assert.equal(stageEnd.payload["error"], "boom");
        assert.equal(stageEnd.payload["failureKind"], "unknown");
        assert.equal(stageEnd.payload["failureMessage"], "boom");

        const runEnd = calls.find((c) => c.type === "workflow.run.end");
        assert.equal(runEnd?.payload["status"], "failed");
        assert.equal(runEnd.payload["error"], "boom");
        assert.equal(runEnd.payload["failureKind"], "unknown");
        assert.equal(runEnd.payload["failureMessage"], "boom");
        assert.equal(
            runEnd.payload["failedStageId"],
            stageEnd.payload["stageId"],
        );
        assert.equal(runEnd.payload["resumable"], true);
    });

    test("recoverable rate limit persists run.blocked without run.end", async () => {
        const { persistence, calls } = makePersistence();
        const st = createStore();

        const def = workflow({ name: "blocked-persist-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.stage("limited").prompt("x");
                return {};
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw {
                                status: 429,
                                code: "rate_limit_exceeded",
                                message: "rate limit",
                                retryAfterMs: 1234,
                            };
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        assert.equal(wfResult.status, "running");
        assert.deepEqual(
            lifecycleTypes(calls),
            [
                "workflow.run.start",
                "workflow.stage.start",
                "workflow.stage.end",
                "workflow.run.blocked",
            ],
        );
        const stageEnd = calls.find((c) => c.type === "workflow.stage.end")!;
        assert.equal(stageEnd.payload["status"], "failed");
        assert.equal(stageEnd.payload["failureKind"], "rate_limit");
        assert.equal(stageEnd.payload["failureCode"], "rate_limited");
        assert.equal(stageEnd.payload["failureRecoverability"], "recoverable");
        assert.equal(stageEnd.payload["failureDisposition"], "active_blocked");
        assert.equal(stageEnd.payload["retryAfterMs"], 1234);

        const runBlocked = calls.find((c) => c.type === "workflow.run.blocked")!;
        assert.equal(runBlocked.payload["runId"], wfResult.runId);
        assert.equal(runBlocked.payload["failureKind"], "rate_limit");
        assert.equal(runBlocked.payload["failureCode"], "rate_limited");
        assert.equal(runBlocked.payload["failureRecoverability"], "recoverable");
        assert.equal(runBlocked.payload["failureDisposition"], "active_blocked");
        assert.equal(runBlocked.payload["resumable"], true);
        assert.equal(runBlocked.payload["retryAfterMs"], 1234);
        assert.equal(typeof runBlocked.payload["failedStageId"], "string");
        assert.equal(calls.some((c) => c.type === "workflow.run.end"), false);
    });

    test("non-fail-fast parallel rate limits persist run.blocked without ending the run", async () => {
        const { persistence, calls } = makePersistence();
        const st = createStore();

        const def = workflow({ name: "parallel-blocked-persist-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "limited", prompt: "limited" },
                        { name: "ok", prompt: "ok" },
                    ],
                    { concurrency: 2, failFast: false },
                );
                return {};
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "limited") {
                                throw {
                                    status: 429,
                                    code: "rate_limit_exceeded",
                                    message: "rate limit",
                                    retryAfterMs: 2500,
                                };
                            }
                            return "ok";
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        const storedRun = st.runs()[0]!;
        assert.equal(wfResult.status, "running");
        assert.equal(storedRun.status, "running");
        assert.equal(storedRun.endedAt, undefined);
        assert.equal(storedRun.failureCode, "rate_limited");
        assert.equal(storedRun.failureDisposition, "active_blocked");
        assert.equal(calls.some((c) => c.type === "workflow.run.end"), false);
        const runBlocked = calls.find((c) => c.type === "workflow.run.blocked")!;
        assert.equal(runBlocked.payload["failureKind"], "rate_limit");
        assert.equal(runBlocked.payload["failureCode"], "rate_limited");
        assert.equal(runBlocked.payload["failureDisposition"], "active_blocked");
        assert.equal(runBlocked.payload["retryAfterMs"], 2500);
    });

    test("fail-fast skipped queued parallel stages persist start before end", async () => {
        const { persistence, calls } = makePersistence();
        const st = createStore();
        const promptCalls: string[] = [];

        const def = workflow({ name: "fail-fast-pending-persist-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "first", prompt: "fail" },
                        { name: "queued-a", prompt: "queued-a" },
                        { name: "queued-b", prompt: "queued-b" },
                    ],
                    { concurrency: 3 },
                );
                return {};
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                config: {
                    defaultConcurrency: 1,
                    maxDepth: 10,
                    persistRuns: false,
                    statusFile: false,
                    resumeInFlight: "never",
                },
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            promptCalls.push(text);
                            await Promise.resolve();
                            if (text === "fail") throw new Error("boom");
                            await new Promise<string>(() => {});
                            return `unexpected:${text}`;
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.equal(promptCalls[0], "fail");

        const stages = st
            .runs()
            .find((runSnap) => runSnap.id === wfResult.runId)!.stages;
        for (const name of ["queued-a", "queued-b"]) {
            const stage = stages.find((candidate) => candidate.name === name)!;
            assert.equal(stage.status, "skipped");
            assert.equal(stage.skippedReason, "fail-fast");
        }

        const stageEntryKey = (payload: Record<string, unknown>): string =>
            `${String(payload["runId"])}:${String(payload["stageId"])}`;
        const startsByStage = new Map<string, number>();
        for (const call of calls) {
            if (call.type === "workflow.stage.start") {
                const key = stageEntryKey(call.payload);
                startsByStage.set(key, (startsByStage.get(key) ?? 0) + 1);
                continue;
            }
            if (call.type !== "workflow.stage.end") continue;
            const key = stageEntryKey(call.payload);
            assert.equal(
                startsByStage.get(key) ?? 0,
                1,
                `stage ${key} ended without exactly one preceding start`,
            );
        }

        const stageStartCount = calls.filter(
            (call) => call.type === "workflow.stage.start",
        ).length;
        const stageEndCount = calls.filter(
            (call) => call.type === "workflow.stage.end",
        ).length;
        assert.equal(stageStartCount, stageEndCount);
    });

    test("no appendEntry calls when persistence not provided", async () => {
        // Ensure no crash and no global side effects
        const def = workflow({ name: "no-persist-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.stage("s").prompt("x");
                return {};
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "r" } },
                store: createStore(),
                // no persistence
            },
        );

        assert.equal(wfResult.status, "completed");
    });

});
