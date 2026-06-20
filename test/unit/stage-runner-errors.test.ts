import { describe, test } from "bun:test";
import type { AgentSessionAdapter, StageSessionCreateOptions } from "./stage-runner-helpers.js";
import {
    Type,
    assert,
    createStageContext,
    makeMockSession,
    makeOpts,
} from "./stage-runner-helpers.js";

describe("createStageContext — stage surface", () => {
    test("does not expose a subagent helper", () => {
        const ctx = createStageContext(makeOpts({ adapters: {} }));
        assert.equal("subagent" in ctx, false);
    });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("createStageContext — error paths", () => {
    test("complete without adapters fails with a complete-specific configuration hint", async () => {
        const ctx = createStageContext(makeOpts({ adapters: {} }));
        await assert.rejects(ctx.complete("text"), {
            message:
                /ctx\.complete requires either RunOpts\.adapters\.complete or RunOpts\.adapters\.agentSession/,
        });
    });

    test("complete options require an explicit complete adapter", async () => {
        const ctx = createStageContext(
            makeOpts({
                adapters: {
                    agentSession: {
                        create: async () => makeMockSession().session,
                    },
                },
            }),
        );
        await assert.rejects(ctx.complete("text", { maxTokens: 12 }), {
            message: /complete options require a CompleteAdapter/,
        });
    });

    test("stage name exposed on ctx.name", () => {
        const ctx = createStageContext(makeOpts({ stageName: "Ingest" }));
        assert.equal(ctx.name, "Ingest");
    });

    test("schema-backed stages fail clearly when prompt is called more than once", async () => {
        let createOptions: StageSessionCreateOptions | undefined;
        const { session, state } = makeMockSession({
            async prompt() {
                state.promptCalls += 1;
                const structuredTool = createOptions?.customTools?.find(
                    (tool) => tool.name === "structured_output",
                );
                assert.ok(structuredTool);
                await structuredTool.execute(
                    "structured-call-1",
                    { ok: true },
                    undefined,
                    undefined,
                    undefined as never,
                );
            },
        });
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                createOptions = options;
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
                },
            }),
        );

        assert.deepEqual(await ctx.prompt("first"), { ok: true });
        await assert.rejects(
            ctx.prompt("second"),
            /stage schema supports one prompt\(\) call per stage context/,
        );
        assert.equal(state.promptCalls, 1);
    });
});

// ---------------------------------------------------------------------------
// Lazy attach + controlled pause
// ---------------------------------------------------------------------------

