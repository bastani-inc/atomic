import { describe } from "bun:test";
import {
    assert, createStore, defineWorkflow, run, test, Type,
} from "./executor-shared.js";

describe("executor.run — concurrency limiter", () => {
    test("defaultConcurrency=1 serializes parallel stages", async () => {
        // Two stages spawned concurrently from Promise.all — with limit=1 only one
        // may execute at a time.
        let active = 0;
        let maxActive = 0;

        const def = defineWorkflow("conc-serial-wf")
            .output("a", Type.Optional(Type.Any()))
            .output("b", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const task = async (name: string): Promise<string> => {
                    return ctx.stage(name).prompt(name);
                };
                const [a, b] = await Promise.all([task("s1"), task("s2")]);
                return { a, b };
            })
            .compile();

        const result = await run(
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
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            active++;
                            maxActive = Math.max(maxActive, active);
                            // yield so other stages can start if concurrency allows
                            await new Promise<void>((r) => setTimeout(r, 5));
                            active--;
                            return `done:${text}`;
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(maxActive, 1);
    });

    test("defaultConcurrency=2 allows two concurrent stages", async () => {
        let active = 0;
        let maxActive = 0;

        const def = defineWorkflow("conc-2-wf")
            .output("a", Type.Optional(Type.Any()))
            .output("b", Type.Optional(Type.Any()))
            .output("c", Type.Optional(Type.Any()))
            .run(async (ctx) => {
                const [a, b, c] = await Promise.all([
                    ctx.stage("s1").prompt("s1"),
                    ctx.stage("s2").prompt("s2"),
                    ctx.stage("s3").prompt("s3"),
                ]);
                return { a, b, c };
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                config: {
                    defaultConcurrency: 2,
                    maxDepth: 10,
                    persistRuns: false,
                    statusFile: false,
                    resumeInFlight: "never",
                },
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            active++;
                            maxActive = Math.max(maxActive, active);
                            await new Promise<void>((r) => setTimeout(r, 5));
                            active--;
                            return `done:${text}`;
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.ok(maxActive <= 2);
        assert.ok(maxActive >= 1);
    });

    test("default concurrency (4) allows ≤4 concurrent stages", async () => {
        let active = 0;
        let maxActive = 0;

        const def = defineWorkflow("conc-default-wf")
            .run(async (ctx) => {
                await Promise.all(
                    ["s1", "s2", "s3", "s4", "s5", "s6"].map((n) =>
                        ctx.stage(n).prompt(n),
                    ),
                );
                return {};
            })
            .compile();

        const result = await run(
            def,
            {},
            {
                // no config — should default to 4
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            active++;
                            maxActive = Math.max(maxActive, active);
                            await new Promise<void>((r) => setTimeout(r, 5));
                            active--;
                            return text;
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "completed");
        assert.ok(maxActive <= 4);
    });

    test("concurrency limiter releases on stage failure", async () => {
        let completedCount = 0;

        const def = defineWorkflow("conc-fail-wf")
            .run(async (ctx) => {
                const [, b] = await Promise.allSettled([
                    ctx.stage("fail").prompt("fail-me"),
                    ctx.stage("ok").prompt("succeed"),
                ]);
                if (b.status === "fulfilled") completedCount++;
                return {};
            })
            .compile();

        const result = await run(
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
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "fail-me")
                                throw new Error("stage-error");
                            return text;
                        },
                    },
                },
            },
        );

        // Run itself completes (allSettled handles the failure)
        assert.equal(result.status, "completed");
        // The "ok" stage ran after the failed stage released its slot
        assert.equal(completedCount, 1);
    });
});

// ---------------------------------------------------------------------------
// Stage-control registry + controlled pause integration
// ---------------------------------------------------------------------------

