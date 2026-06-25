import { describe, test } from "bun:test";
import type {
    CompleteAdapter,
    CompleteStageOpts,
    StageExecutionMeta,
} from "./stage-runner-helpers.js";
import {
    assert,
    createStageContext,
    makeOpts,
    makeSignal,
} from "./stage-runner-helpers.js";

describe("createStageContext — complete metadata propagation", () => {
    test("complete adapter receives full meta", async () => {
        const received: StageExecutionMeta[] = [];
        const signal = makeSignal();
        const completeAdapter: CompleteAdapter = {
            async complete(_text, _opts, meta) {
                received.push(meta!);
                return "done";
            },
        };
        const ctx = createStageContext({
            stageId: "s-7",
            stageName: "Draft",
            runId: "r-55",
            signal,
            adapters: { complete: completeAdapter },
        });
        await ctx.complete("write a draft");
        assert.deepEqual(received[0], {
            runId: "r-55",
            stageId: "s-7",
            stageName: "Draft",
            signal,
            stageOptions: undefined,
            executionMode: undefined,
        });
    });

    test("complete adapter receives CompleteStageOpts.model", async () => {
        const receivedOpts: Array<CompleteStageOpts | undefined> = [];
        const completeAdapter: CompleteAdapter = {
            async complete(_text, opts) {
                receivedOpts.push(opts);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { complete: completeAdapter } }),
        );
        await ctx.complete("write", { model: "gpt-4o" });
        assert.equal(receivedOpts[0]?.model, "gpt-4o");
    });

    test("complete adapter receives CompleteStageOpts.maxTokens", async () => {
        const receivedOpts: Array<CompleteStageOpts | undefined> = [];
        const completeAdapter: CompleteAdapter = {
            async complete(_text, opts) {
                receivedOpts.push(opts);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { complete: completeAdapter } }),
        );
        await ctx.complete("write", { maxTokens: 512 });
        assert.equal(receivedOpts[0]?.maxTokens, 512);
    });

    test("complete adapter receives both model and maxTokens intact", async () => {
        const receivedOpts: Array<CompleteStageOpts | undefined> = [];
        const completeAdapter: CompleteAdapter = {
            async complete(_text, opts) {
                receivedOpts.push(opts);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { complete: completeAdapter } }),
        );
        await ctx.complete("write", {
            model: "claude-opus-4",
            maxTokens: 1024,
        });
        assert.deepEqual(receivedOpts[0], {
            model: "claude-opus-4",
            maxTokens: 1024,
        });
    });

    test("complete adapter receives undefined opts when none passed", async () => {
        const receivedOpts: Array<CompleteStageOpts | undefined> = [];
        const completeAdapter: CompleteAdapter = {
            async complete(_text, opts) {
                receivedOpts.push(opts);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { complete: completeAdapter } }),
        );
        await ctx.complete("write");
        assert.equal(receivedOpts[0], undefined);
    });

    test("complete adapter receives text passed to ctx.complete", async () => {
        const texts: string[] = [];
        const completeAdapter: CompleteAdapter = {
            async complete(text) {
                texts.push(text);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { complete: completeAdapter } }),
        );
        await ctx.complete("the input text");
        assert.deepEqual(texts, ["the input text"]);
    });

    test("complete meta signal is undefined when opts.signal absent", async () => {
        const received: Array<StageExecutionMeta | undefined> = [];
        const completeAdapter: CompleteAdapter = {
            async complete(_text, _opts, meta) {
                received.push(meta);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { complete: completeAdapter } }),
        );
        await ctx.complete("hi");
        assert.equal(received[0]?.signal, undefined);
    });
});

// ---------------------------------------------------------------------------
// Stage surface
// ---------------------------------------------------------------------------

