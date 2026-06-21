import { describe } from "bun:test";
import {
    assert, createStore, workflow, run, test,
    WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("outer invalid credentials after a caught rate-limited stage kill the run", async () => {
        const st = createStore();
        const def = workflow({
          name: "caught-rate-limit-outer-401-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // The stage failure is intentionally caught; the outer error
                    // must still participate in run-level disposition selection.
                }
                throw { status: 401, message: "Unauthorized" };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "killed");
        assert.equal(wfResult.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "killed");
        assert.notEqual(storedRun.endedAt, undefined);
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.resumable, false);
        assert.equal(storedRun.failureKind, "auth");
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureRecoverability, "non_recoverable");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, undefined);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("aggregate invalid credentials after a caught rate-limited stage use aggregate metadata", async () => {
        const st = createStore();
        const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const persistence = {
            appendEntry(type: string, payload: Record<string, unknown>): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
            setLabel(_entryId: string, _label: string): void {},
        };
        const rawSecret = "sk-testsecret1234567890";
        const def = workflow({
          name: "caught-rate-limit-aggregate-invalid-key-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Continue to the aggregate provider credential failure.
                }
                throw new AggregateError([
                    { status: 401, message: `Incorrect API key provided: ${rawSecret}` },
                ], "atomic-workflows: 1 parallel step failed");
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
                persistence,
            },
        );

        assert.equal(wfResult.status, "killed");
        assert.equal(wfResult.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "killed");
        assert.equal(storedRun.failureKind, "auth");
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureRecoverability, "non_recoverable");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, undefined);
        assert.match(storedRun.failureMessage ?? "", /Incorrect API key/);
        assert.equal(storedRun.failureMessage?.includes(rawSecret), false);
        assert.notEqual(storedRun.failureMessage, stage.failureMessage);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureDisposition, "active_blocked");

        const runEnd = calls.find((call) => call.type === "workflow.run.end")!;
        assert.equal(runEnd.payload["failedStageId"], undefined);
        assert.equal(runEnd.payload["failureCode"], "invalid_api_key");
        assert.equal(String(runEnd.payload["failureMessage"] ?? "").includes(rawSecret), false);
        assert.equal(JSON.stringify({ wfResult, runs: st.runs(), calls }).includes(rawSecret), false);
    });

    test("aggregate ordinary errors after a caught rate-limited stage do not inherit stale rate-limit metadata", async () => {
        const st = createStore();
        const def = workflow({
          name: "caught-rate-limit-aggregate-error-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Continue to an aggregate domain failure.
                }
                throw new AggregateError([
                    new Error("aggregate domain terminal"),
                ], "atomic-workflows: 1 parallel step failed");
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /atomic-workflows: 1 parallel step failed/);
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "failed");
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.failureKind, "unknown");
        assert.equal(storedRun.failureCode, "unknown");
        assert.equal(storedRun.failureDisposition, "terminal_failed");
        assert.notEqual(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failureMessage, "aggregate domain terminal");
        assert.notEqual(storedRun.failureMessage, "stage rate limited");
        assert.equal(storedRun.failedStageId, undefined);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("outer ordinary errors after a caught rate-limited stage fail with outer error text", async () => {
        const st = createStore();
        const def = workflow({
          name: "caught-rate-limit-outer-error-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Continue to the workflow-level validation failure.
                }
                throw new Error("outer domain validation failed");
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "failed");
        assert.equal(wfResult.error, "outer domain validation failed");
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "failed");
        assert.equal(storedRun.error, "outer domain validation failed");
        assert.notEqual(storedRun.endedAt, undefined);
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.failureKind, "unknown");
        assert.equal(storedRun.failureCode, "unknown");
        assert.equal(storedRun.failureDisposition, "terminal_failed");
        assert.notEqual(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failureMessage, "outer domain validation failed");
        assert.equal(storedRun.failedStageId, undefined);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("outer rate limits after a caught rate-limited stage keep the run active-blocked", async () => {
        const st = createStore();
        const def = workflow({
          name: "caught-rate-limit-outer-429-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                try {
                    await ctx.stage("limited").prompt("limited");
                } catch {
                    // Both observed failures are recoverable rate limits.
                }
                throw { status: 429, message: "outer rate limited" };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => {
                            throw { status: 429, message: "stage rate limited" };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "running");
        const storedRun = st.runs()[0]!;
        const stage = storedRun.stages[0]!;
        assert.equal(storedRun.status, "running");
        assert.equal(storedRun.endedAt, undefined);
        assert.equal(typeof storedRun.blockedAt, "number");
        assert.equal(storedRun.resumable, true);
        assert.equal(storedRun.failureKind, "rate_limit");
        assert.equal(storedRun.failureCode, "rate_limited");
        assert.equal(storedRun.failureRecoverability, "recoverable");
        assert.equal(storedRun.failureDisposition, "active_blocked");
        assert.equal(storedRun.failedStageId, stage.id);
        assert.equal(stage.status, "failed");
        assert.equal(stage.failureCode, "rate_limited");
        assert.equal(stage.failureRecoverability, "recoverable");
        assert.equal(stage.failureDisposition, "active_blocked");
    });

    test("non-fail-fast parallel invalid provider credentials kill the run", async () => {
        const st = createStore();
        const def = workflow({
          name: "parallel-invalid-key-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "ok", prompt: "ok" },
                        { name: "bad-key", prompt: "bad-key" },
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
                            if (text === "bad-key") {
                                throw { status: 401, message: "Unauthorized" };
                            }
                            return "ok";
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "killed");
        assert.equal(wfResult.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        const storedRun = st.runs()[0]!;
        const badKeyStage = storedRun.stages.find((stage) => stage.name === "bad-key")!;
        assert.equal(storedRun.status, "killed");
        assert.equal(storedRun.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, badKeyStage.id);
        assert.equal(badKeyStage.status, "failed");
        assert.equal(badKeyStage.failureCode, "invalid_api_key");
        assert.equal(badKeyStage.error, WORKFLOW_INVALID_PROVIDER_CREDENTIALS_MESSAGE);
    });

    test("non-fail-fast parallel terminal failures beat recoverable blocked failures", async () => {
        const st = createStore();
        const def = workflow({
          name: "parallel-mixed-provider-failures-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "limited", prompt: "limited" },
                        { name: "bad-key", prompt: "bad-key" },
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
                                throw { status: 429, message: "too many requests" };
                            }
                            throw { status: 401, message: "Unauthorized" };
                        },
                    },
                },
                store: st,
            },
        );

        const storedRun = st.runs()[0]!;
        const badKeyStage = storedRun.stages.find((stage) => stage.name === "bad-key")!;
        const limitedStage = storedRun.stages.find((stage) => stage.name === "limited")!;
        assert.equal(wfResult.status, "killed");
        assert.equal(storedRun.failureCode, "invalid_api_key");
        assert.equal(storedRun.failureDisposition, "terminal_killed");
        assert.equal(storedRun.failedStageId, badKeyStage.id);
        assert.equal(badKeyStage.failureDisposition, "terminal_killed");
        assert.equal(limitedStage.failureDisposition, "active_blocked");
    });

    test("non-fail-fast parallel ordinary failures beat recoverable blocked failures", async () => {
        const st = createStore();
        const def = workflow({
          name: "parallel-mixed-ordinary-failures-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "limited", prompt: "limited" },
                        { name: "domain", prompt: "domain" },
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
                                throw { status: 429, message: "too many requests" };
                            }
                            throw new Error("domain model validation failed");
                        },
                    },
                },
                store: st,
            },
        );

        const storedRun = st.runs()[0]!;
        const domainStage = storedRun.stages.find((stage) => stage.name === "domain")!;
        const limitedStage = storedRun.stages.find((stage) => stage.name === "limited")!;
        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /atomic-workflows: 2 parallel steps failed/);
        assert.equal(storedRun.status, "failed");
        assert.match(storedRun.error ?? "", /atomic-workflows: 2 parallel steps failed/);
        assert.notEqual(storedRun.endedAt, undefined);
        assert.equal(storedRun.blockedAt, undefined);
        assert.equal(storedRun.failureKind, "unknown");
        assert.equal(storedRun.failureCode, "unknown");
        assert.equal(storedRun.failureDisposition, "terminal_failed");
        assert.equal(storedRun.failedStageId, domainStage.id);
        assert.equal(storedRun.resumable, true);
        assert.equal(domainStage.failureDisposition, "terminal_failed");
        assert.equal(domainStage.failureMessage, "domain model validation failed");
        assert.equal(limitedStage.failureCode, "rate_limited");
        assert.equal(limitedStage.failureDisposition, "active_blocked");
    });

    test("parallel fail-fast marks slow sibling skipped instead of completed", async () => {
        const st = createStore();
        const def = workflow({
          name: "parallel-fail-fast-skip-wf",
          description: "",
          inputs: {},
          outputs: {},
          run: async (ctx) => {
                await ctx.parallel(
                    [
                        { name: "fast", prompt: "fail" },
                        { name: "slow", prompt: "slow" },
                    ],
                    { concurrency: 2 },
                );
                return {};
            },
        });

        const result = await run(
            def,
            {},
            {
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            if (text === "fail") throw new Error("boom");
                            await new Promise<void>((resolve) =>
                                setTimeout(resolve, 20),
                            );
                            return "slow-ok";
                        },
                    },
                },
            },
        );

        assert.equal(result.status, "failed");
        const stages = st
            .runs()
            .find((runSnap) => runSnap.id === result.runId)!.stages;
        assert.equal(
            stages.find((stage) => stage.name === "fast")?.status,
            "failed",
        );
        const slow = stages.find((stage) => stage.name === "slow")!;
        assert.equal(slow.status, "skipped");
        assert.equal(slow.skippedReason, "fail-fast");
    });

});
