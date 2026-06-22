import { describe } from "bun:test";
import {
    assert, createStore, deferred, workflow, mockSession, run, sleep, test, Type,
    WORKFLOW_UNKNOWN_MODEL_MESSAGE, type AgentSession, type CreateAgentSessionOptions,
    type StageSnapshot,
} from "./executor-shared.js";

describe("executor.run", () => {
    test("dummy workflow: a (1m) token stage runs end-to-end and applies the long-context window to the SDK session", async () => {
        const st = createStore();
        let createdModel: string | undefined;
        let createdContextWindow: number | undefined = -1;
        const def = workflow({
          name: "context-window-token-smoke",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                await ctx
                    .stage("opus", { model: "github-copilot/claude-opus-4.8 (1m):xhigh" })
                    .prompt("hello");
                return { ok: true };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                models: {
                    listModels: async () => [
                        {
                            provider: "github-copilot",
                            id: "claude-opus-4.8",
                            fullId: "github-copilot/claude-opus-4.8",
                            // Tiered window mirroring the live CAPI catalog (200K default + ~936K long).
                            model: {
                                provider: "github-copilot",
                                id: "claude-opus-4.8",
                                contextWindow: 200_000,
                                defaultContextWindow: 200_000,
                                contextWindowOptions: [200_000, 936_000],
                            } as unknown as NonNullable<CreateAgentSessionOptions["model"]>,
                        },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create(options) {
                            createdModel =
                                typeof options.model === "string"
                                    ? options.model
                                    : `${String(options.model?.provider)}/${options.model?.id}`;
                            createdContextWindow = options.contextWindow;
                            return mockSession();
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["ok"], true);
        // The `(1m)` token resolved against the opus model's advertised windows
        // and reached createAgentSession as the ~936K long-context budget.
        assert.equal(createdModel, "github-copilot/claude-opus-4.8");
        assert.equal(createdContextWindow, 936_000);
    });

    test("bare explicit model stage publishes running fast-mode metadata after catalog resolution", async () => {
        const promptGate = deferred<string | void>();
        const st = createStore();
        const def = workflow({
          name: "bare-explicit-model-running-fast-metadata",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                await ctx
                    .stage("scout", { model: "gpt-5.1-codex" })
                    .prompt("inspect");
                return { ok: true };
            },
        });

        const runPromise = run(
            def,
            {},
            {
                models: {
                    listModels: async () => [
                        {
                            provider: "openai",
                            id: "gpt-5.1-codex",
                            fullId: "openai/gpt-5.1-codex",
                        },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create(options) {
                            assert.equal(
                                (options as { readonly model?: string }).model,
                                "openai/gpt-5.1-codex",
                            );
                            return {
                                session: {
                                    ...mockSession(),
                                    model: {
                                        provider: "openai",
                                        id: "gpt-5.1-codex",
                                    } as AgentSession["model"],
                                    async prompt() {
                                        await promptGate.promise;
                                    },
                                },
                                settingsManager: {
                                    getCodexFastModeSettings: () => ({
                                        chat: false,
                                        workflow: true,
                                    }),
                                },
                            };
                        },
                    },
                },
                store: st,
            },
        );

        try {
            const deadline = Date.now() + 1000;
            let runningStage: StageSnapshot | undefined;
            while (Date.now() < deadline) {
                runningStage = st
                    .runs()
                    .flatMap((runSnapshot) => runSnapshot.stages)
                    .find(
                        (stage) =>
                            stage.name === "scout" &&
                            stage.status === "running",
                    );
                if (runningStage !== undefined) break;
                await sleep(5);
            }

            assert.equal(runningStage?.model, "openai/gpt-5.1-codex");
            assert.equal(runningStage?.fastMode, true);
        } finally {
            promptGate.resolve();
            await runPromise;
        }
    });

    test("prompt adapter stages do not eagerly create SDK sessions for fast metadata", async () => {
        const st = createStore();
        const def = workflow({
          name: "prompt-adapter-no-eager-session",
          description: "",
          inputs: {},
          outputs: {
            text: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const text = await ctx.stage("scout").prompt("inspect");
                return { text };
            },
        });

        const result = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "adapter ok",
                    },
                    agentSession: {
                        async create() {
                            throw new Error(
                                "agent session should not be created",
                            );
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.stages[0]?.result, "adapter ok");
    });

    test("workflow fallback refreshes running fast metadata when switching to an eligible model", async () => {
        const fallbackGate = deferred<string | void>();
        const st = createStore();
        const def = workflow({
          name: "fallback-running-fast-metadata",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                await ctx
                    .stage("scout", {
                        model: "anthropic/primary",
                        fallbackModels: ["openai/fallback"],
                    })
                    .prompt("inspect");
                return { ok: true };
            },
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const model = (
                                options as { readonly model?: string }
                            ).model;
                            return {
                                session: {
                                    ...mockSession(),
                                    model:
                                        model === "openai/fallback"
                                            ? ({
                                                  provider: "openai",
                                                  id: "fallback",
                                              } as AgentSession["model"])
                                            : ({
                                                  provider: "anthropic",
                                                  id: "primary",
                                              } as AgentSession["model"]),
                                    async prompt() {
                                        if (model === "openai/fallback") {
                                            await fallbackGate.promise;
                                            return;
                                        }
                                        throw new Error(
                                            "anthropic/primary timed out",
                                        );
                                    },
                                },
                                settingsManager: {
                                    getCodexFastModeSettings: () => ({
                                        chat: false,
                                        workflow: true,
                                    }),
                                },
                            };
                        },
                    },
                },
                store: st,
            },
        );

        try {
            const deadline = Date.now() + 1000;
            let runningStage: StageSnapshot | undefined;
            while (Date.now() < deadline) {
                runningStage = st
                    .runs()
                    .flatMap((runSnapshot) => runSnapshot.stages)
                    .find(
                        (stage) =>
                            stage.name === "scout" &&
                            stage.status === "running" &&
                            stage.model === "openai/fallback",
                    );
                if (runningStage?.fastMode === true) break;
                await sleep(5);
            }

            assert.equal(runningStage?.model, "openai/fallback");
            assert.equal(runningStage?.fastMode, true);
        } finally {
            fallbackGate.resolve();
            await runPromise;
        }
    });

    test("workflow fallback clears fast metadata when final model is not eligible", async () => {
        const st = createStore();
        const def = workflow({
          name: "fallback-clears-fast-metadata",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx
                    .stage("scout", {
                        model: "openai/gpt-5.1-codex",
                        fallbackModels: ["anthropic/claude-sonnet-4"],
                    })
                    .prompt("inspect");
                return { ok: true };
            },
        });

        const result = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            const model = (
                                options as { readonly model?: string }
                            ).model;
                            return {
                                session: {
                                    ...mockSession(),
                                    model:
                                        model === "anthropic/claude-sonnet-4"
                                            ? ({
                                                  provider: "anthropic",
                                                  id: "claude-sonnet-4",
                                              } as AgentSession["model"])
                                            : ({
                                                  provider: "openai",
                                                  id: "gpt-5.1-codex",
                                              } as AgentSession["model"]),
                                    async prompt() {
                                        if (
                                            model ===
                                            "anthropic/claude-sonnet-4"
                                        )
                                            return;
                                        throw new Error(
                                            "openai/gpt-5.1-codex timed out",
                                        );
                                    },
                                },
                                settingsManager: {
                                    getCodexFastModeSettings: () => ({
                                        chat: false,
                                        workflow: true,
                                    }),
                                },
                            };
                        },
                    },
                },
                store: st,
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.stages[0]?.model, "anthropic/claude-sonnet-4");
        assert.equal(result.stages[0]?.fastMode, undefined);
    });

    test("invalid dynamic stage model fails before SDK session creation", async () => {
        let creates = 0;
        // A bare id that cannot be resolved against the catalog is still a hard
        // configuration error (it is neither provider-qualified nor uniquely
        // matched), so the run must fail before any SDK session is created.
        const def = workflow({
          name: "invalid-stage-model",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                await ctx.task("scout", {
                    prompt: "inspect",
                    model: "missing-model",
                });
                return { ok: true };
            },
        });

        const result = await run(
            def,
            {},
            {
                models: {
                    listModels: async () => [
                        {
                            provider: "openai",
                            id: "fallback",
                            fullId: "openai/fallback",
                        },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create() {
                            creates += 1;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(result.status, "killed");
        assert.equal(result.error, WORKFLOW_UNKNOWN_MODEL_MESSAGE);
        assert.equal(creates, 0);
        assert.equal(result.stages[0]?.status, "failed");
        assert.equal(result.stages[0]?.failureCode, "unknown_model");
        assert.match(result.stages[0]?.failureMessage ?? "", /missing-model \(not available\)/);
    });

    test("provider-qualified stage model absent from the catalog is trusted and creates a session", async () => {
        // Regression: a fully-qualified provider/model id that the catalog does
        // not list must be trusted (passed through), not collapsed to the user's
        // current model or rejected up front, so the workflow's defined model is
        // what actually drives the stage session.
        let createdModel: unknown;
        let creates = 0;
        const def = workflow({
          name: "trusted-stage-model",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Boolean(),
          },
          run: async (ctx) => {
                await ctx.task("scout", {
                    prompt: "inspect",
                    model: "some-provider/brand-new:high",
                });
                return { ok: true };
            },
        });

        const result = await run(
            def,
            {},
            {
                models: {
                    listModels: async () => [
                        { provider: "openai", id: "fallback", fullId: "openai/fallback" },
                    ],
                },
                adapters: {
                    agentSession: {
                        async create(options: CreateAgentSessionOptions) {
                            creates += 1;
                            createdModel = options.model;
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(result.status, "completed");
        assert.equal(creates, 1);
        assert.equal(createdModel, "some-provider/brand-new");
        assert.equal(result.stages[0]?.status, "completed");
    });

    test("stage snapshot records failed status when stage throws", async () => {
        const def = workflow({ name: "fail-stage-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.stage("bad-stage").prompt("x");
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
                            throw new Error("explode");
                        },
                    },
                },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "failed");
        const badStage = wfResult.stages.find((s) => s.name === "bad-stage");
        assert.equal(badStage?.status, "failed");
        assert.ok(badStage?.error!.includes("explode"));
    });

});
