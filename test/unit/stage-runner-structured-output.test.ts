import { describe, test } from "bun:test";
import type {
    AgentSessionAdapter,
    InternalStageContext,
    StageSessionCreateOptions,
} from "./stage-runner-helpers.js";
import {
    Type,
    assert,
    createStageContext,
    makeMockSession,
    makeOpts,
} from "./stage-runner-helpers.js";

describe("createStageContext — structured_output corrective retry", () => {
    test("schema-backed noTools=all stages still expose structured_output", async () => {
        let createOptions: StageSessionCreateOptions | undefined;
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                createOptions = options;
                return makeMockSession().session;
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    noTools: "all",
                    schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
                },
            }),
        ) as InternalStageContext;

        await ctx.__ensureSession();

        assert.deepEqual(createOptions?.tools, ["structured_output"]);
        assert.equal(createOptions?.customTools?.some((tool) => tool.name === "structured_output"), true);
    });

    test("re-prompts when a schema-backed stage skips structured_output and then succeeds", async () => {
        let createOptions: StageSessionCreateOptions | undefined;
        const prompts: string[] = [];
        const mock = makeMockSession({
            async prompt(promptText) {
                prompts.push(promptText);
                if (prompts.length === 1) return;
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
                return mock.session;
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

        assert.deepEqual(await ctx.prompt("review this"), { ok: true });
        assert.equal(prompts.length, 2);
        assert.equal(prompts[0], "review this");
        assert.match(prompts[1] ?? "", /Corrective attempt 1\/3/);
        assert.match(prompts[1] ?? "", /must finish by calling structured_output/);
        assert.match(prompts[1] ?? "", /Do not answer with plain JSON text/);
    });

    test("echoes structured_output validation errors in the corrective prompt", async () => {
        let createOptions: StageSessionCreateOptions | undefined;
        const prompts: string[] = [];
        const validationError = "Validation failed for tool \"structured_output\": ok: Expected boolean";
        let emit: ((event: { type: string; [k: string]: unknown }) => void) | undefined;
        const mock = makeMockSession({
            async prompt(promptText) {
                prompts.push(promptText);
                if (prompts.length === 1) {
                    emit?.({
                        type: "tool_execution_end",
                        toolName: "structured_output",
                        result: {
                            isError: true,
                            content: [{ type: "text", text: validationError }],
                        },
                    });
                    return;
                }
                const structuredTool = createOptions?.customTools?.find(
                    (tool) => tool.name === "structured_output",
                );
                assert.ok(structuredTool);
                await structuredTool.execute(
                    "structured-call-2",
                    { ok: true },
                    undefined,
                    undefined,
                    undefined as never,
                );
            },
        });
        emit = mock.emit;
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                createOptions = options;
                return mock.session;
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

        assert.deepEqual(await ctx.prompt("review this"), { ok: true });
        assert.equal(prompts.length, 2);
        assert.match(prompts[1] ?? "", new RegExp(validationError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });

    test("stops after three corrective prompts when structured_output is still missing", async () => {
        const prompts: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create() {
                return makeMockSession({
                    async prompt(promptText) {
                        prompts.push(promptText);
                    },
                }).session;
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

        await assert.rejects(
            ctx.prompt("review this"),
            /must finish by calling structured_output/,
        );
        assert.equal(prompts.length, 4);
        assert.match(prompts[1] ?? "", /Corrective attempt 1\/3/);
        assert.match(prompts[2] ?? "", /Corrective attempt 2\/3/);
        assert.match(prompts[3] ?? "", /Corrective attempt 3\/3/);
    });
});

// A github-copilot opus catalog entry whose Model object advertises a tiered
// context window (200K default + ~936K long-context), mirroring the live CAPI
// catalog. Only contextWindow/defaultContextWindow/contextWindowOptions are read
// by the resolver, so the rest of Model<Api> is intentionally omitted.
