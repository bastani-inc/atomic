import { describe, test } from "bun:test";
import type { AgentSessionAdapter, InternalStageContext } from "./stage-runner-helpers.js";
import {
    assert,
    createStageContext,
    makeMockSession,
    makeOpts,
} from "./stage-runner-helpers.js";

describe("createStageContext — reasoning suffix retry behavior", () => {
    async function exerciseRetryWithReasoning(
        invoke: (ctx: InternalStageContext) => Promise<string>,
    ): Promise<{
        readonly calls: string[];
        readonly thinkingLevels: string[];
        readonly meta: ReturnType<InternalStageContext["__modelFallbackMeta"]>;
        readonly text: string;
    }> {
        const calls: string[] = [];
        const thinkingLevels: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model =
                    typeof options.model === "string"
                        ? options.model
                        : `${String(options.model?.provider)}/${options.model?.id}`;
                calls.push(model);
                const { session } = makeMockSession({
                    setThinkingLevel(level) {
                        thinkingLevels.push(`${model}:${String(level)}`);
                    },
                    async prompt() {
                        if (model === "anthropic/primary") {
                            throw new Error("429 rate limit exceeded");
                        }
                    },
                    getLastAssistantText() {
                        return model === "openai/fallback" ? "fallback answer" : undefined;
                    },
                });
                return session;
            },
        };

        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    model: "anthropic/primary:high",
                    fallbackModels: ["openai/fallback:low"],
                    thinkingLevel: "xhigh",
                },
            }),
        ) as InternalStageContext;

        const text = await invoke(ctx);
        return { calls, thinkingLevels, meta: ctx.__modelFallbackMeta(), text };
    }

    test("direct task retry applies suffixed reasoning and records attempt metadata", async () => {
        const result = await exerciseRetryWithReasoning((ctx) => ctx.prompt("go"));

        assert.equal(result.text, "fallback answer");
        assert.deepEqual(result.calls, ["anthropic/primary", "openai/fallback"]);
        assert.deepEqual(result.thinkingLevels, [
            "anthropic/primary:high",
            "openai/fallback:low",
        ]);
        assert.deepEqual(
            result.meta.modelAttempts?.map((attempt) => ({
                model: attempt.model,
                reasoningLevel: attempt.reasoningLevel,
                success: attempt.success,
            })),
            [
                { model: "anthropic/primary", reasoningLevel: "high", success: false },
                { model: "openai/fallback", reasoningLevel: "low", success: true },
            ],
        );
        // The live session's active thinking level is surfaced on the meta so
        // background-run widgets can show the same model + thinking identity as
        // the main session footer.
        assert.equal(result.meta.thinkingLevel, "medium");
        // The fallback model — not the failed primary — is the one surfaced to
        // background/graph UIs (meta.model → stageSnapshot.model → node card),
        // so a fallback visibly changes the displayed model.
        assert.equal(result.meta.model, "openai/fallback");
    });

    test("chain-step retry uses the next candidate reasoning level", async () => {
        const result = await exerciseRetryWithReasoning((ctx) => ctx.prompt("chain step"));

        assert.deepEqual(result.thinkingLevels, [
            "anthropic/primary:high",
            "openai/fallback:low",
        ]);
        assert.deepEqual(
            result.meta.modelAttempts?.map((attempt) => attempt.reasoningLevel),
            ["high", "low"],
        );
    });

    test("parallel-step retry uses the next candidate reasoning level", async () => {
        const result = await exerciseRetryWithReasoning((ctx) => ctx.prompt("parallel step"));

        assert.deepEqual(result.thinkingLevels, [
            "anthropic/primary:high",
            "openai/fallback:low",
        ]);
        assert.deepEqual(
            result.meta.modelAttempts?.map((attempt) => attempt.reasoningLevel),
            ["high", "low"],
        );
    });

    test("legacy thinkingLevel applies when candidates have no suffix", async () => {
        const thinkingLevels: string[] = [];
        const agentSession: AgentSessionAdapter = {
            async create(options) {
                const model = typeof options.model === "string" ? String(options.model) : "object-model";
                const { session } = makeMockSession({
                    setThinkingLevel(level) {
                        thinkingLevels.push(`${model}:${String(level)}`);
                    },
                    async prompt() {
                        if (model === "anthropic/primary") throw new Error("503 service unavailable");
                    },
                    getLastAssistantText() {
                        return model === "openai/fallback" ? "legacy answer" : undefined;
                    },
                });
                return session;
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { agentSession },
                stageOptions: {
                    model: "anthropic/primary",
                    fallbackModels: ["openai/fallback"],
                    thinkingLevel: "medium",
                },
            }),
        ) as InternalStageContext;

        assert.equal(await ctx.prompt("go"), "legacy answer");
        assert.deepEqual(thinkingLevels, [
            "anthropic/primary:medium",
            "openai/fallback:medium",
        ]);
        assert.deepEqual(
            ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => attempt.reasoningLevel),
            ["medium", "medium"],
        );
    });
});
