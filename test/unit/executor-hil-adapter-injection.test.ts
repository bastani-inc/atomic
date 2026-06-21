import { describe } from "bun:test";
import {
    assert, createStore, workflow, run, test, Type, type WorkflowCustomUiFactory,
    type WorkflowCustomUiOptions, type WorkflowUIAdapter,
} from "./executor-shared.js";

describe("executor.run — HIL adapter injection", () => {
    test("ctx.ui.input delegates to injected adapter", async () => {
        let capturedPrompt: string | undefined;
        const uiAdapter = {
            input: async (prompt: string) => {
                capturedPrompt = prompt;
                return "user-input";
            },
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (_initial?: string) => "",
        };

        const def = workflow({
          name: "hil-input-wf",
          description: "",
          inputs: {},
          outputs: {
            value: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const value = await ctx.ui.input("What is your name?");
                await ctx.task("after-input", { prompt: "record input" });
                return { value };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["value"], "user-input");
        assert.equal(capturedPrompt, "What is your name?");
    });

    test("ctx.ui.confirm delegates to injected adapter", async () => {
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => true,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (_initial?: string) => "",
        };

        const def = workflow({
          name: "hil-confirm-wf",
          description: "",
          inputs: {},
          outputs: {
            ok: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const ok = await ctx.ui.confirm("Continue?");
                await ctx.task("after-confirm", { prompt: "record confirm" });
                return { ok };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["ok"], true);
    });

    test("ctx.ui.select delegates to injected adapter", async () => {
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[1] as T,
            editor: async (_initial?: string) => "",
        };

        const def = workflow({
          name: "hil-select-wf",
          description: "",
          inputs: {},
          outputs: {
            choice: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const choice = await ctx.ui.select("Pick one", [
                    "a",
                    "b",
                    "c",
                ] as const);
                await ctx.task("after-select", { prompt: "record select" });
                return { choice };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["choice"], "b");
    });

    test("ctx.ui.editor delegates to injected adapter", async () => {
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (initial?: string) => `edited: ${initial ?? ""}`,
        };

        const def = workflow({
          name: "hil-editor-wf",
          description: "",
          inputs: {},
          outputs: {
            content: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const content = await ctx.ui.editor("draft");
                await ctx.task("after-editor", { prompt: "record editor" });
                return { content };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["content"], "edited: draft");
    });

    test("ctx.ui.custom delegates to an injected adapter when prompt nodes are disabled", async () => {
        let capturedLabel: string | undefined;
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (_initial?: string) => "",
            custom: async <T,>(
                _factory: Parameters<NonNullable<import("../../packages/workflows/src/shared/types.js").WorkflowUIAdapter["custom"]>>[0],
                options?: Parameters<NonNullable<import("../../packages/workflows/src/shared/types.js").WorkflowUIAdapter["custom"]>>[1],
            ): Promise<T> => {
                capturedLabel = options?.label;
                return "adapter-custom-result" as T;
            },
        };

        const def = workflow({
          name: "hil-custom-adapter-wf",
          description: "",
          inputs: {},
          outputs: {
            value: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const value = await ctx.ui.custom<string>(
                    () => ({ render: () => ["custom"], invalidate: () => undefined }),
                    { label: "Adapter custom" },
                );
                await ctx.task("after-custom", { prompt: "record custom" });
                return { value };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                ui: uiAdapter,
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["value"], "adapter-custom-result");
        assert.equal(capturedLabel, "Adapter custom");
    });

    test("method-syntax UI adapters preserve this for every ctx.ui method", async () => {
        const uiAdapter = {
            prefix: "object-method",
            async input(this: { readonly prefix: string }, prompt: string) {
                return `${this.prefix}:input:${prompt}`;
            },
            async confirm(this: { readonly prefix: string }, message: string) {
                return message === `${this.prefix}:confirm`;
            },
            async select<T extends string>(
                this: { readonly prefix: string },
                message: string,
                options: readonly T[],
            ) {
                assert.equal(message, `${this.prefix}:select`);
                return (options[1] ?? options[0]) as T;
            },
            async editor(this: { readonly prefix: string }, initial?: string) {
                return `${this.prefix}:editor:${initial ?? ""}`;
            },
            async custom<T>(
                this: { readonly prefix: string },
                _factory: WorkflowCustomUiFactory<T>,
                options?: WorkflowCustomUiOptions,
            ) {
                return `${this.prefix}:custom:${options?.label ?? ""}` as T;
            },
        } satisfies WorkflowUIAdapter & { readonly prefix: string };

        const def = workflow({
          name: "hil-method-syntax-adapter-this-wf",
          description: "",
          inputs: {},
          outputs: {
            values: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const values = {
                    input: await ctx.ui.input("hello"),
                    confirm: await ctx.ui.confirm("object-method:confirm"),
                    select: await ctx.ui.select("object-method:select", ["a", "b"] as const),
                    editor: await ctx.ui.editor("draft"),
                    custom: await ctx.ui.custom<string>(
                        () => ({ render: () => ["custom"], invalidate: () => undefined }),
                        { label: "widget" },
                    ),
                };
                await ctx.task("after-ui", { prompt: "record ui adapter" });
                return { values };
            },
        });

        const wfResult = await run(def, {}, {
            adapters: { prompt: { prompt: async () => "ok" } },
            ui: uiAdapter,
            store: createStore(),
        });

        assert.equal(wfResult.status, "completed");
        assert.deepEqual(wfResult.result?.["values"], {
            input: "object-method:input:hello",
            confirm: true,
            select: "b",
            editor: "object-method:editor:draft",
            custom: "object-method:custom:widget",
        });
    });

    test("class-instance UI adapters preserve this for every ctx.ui method", async () => {
        class StatefulUiAdapter implements WorkflowUIAdapter {
            constructor(private readonly prefix: string) {}

            async input(prompt: string): Promise<string> {
                return `${this.prefix}:input:${prompt}`;
            }

            async confirm(message: string): Promise<boolean> {
                return message === `${this.prefix}:confirm`;
            }

            async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
                assert.equal(message, `${this.prefix}:select`);
                return (options[1] ?? options[0]) as T;
            }

            async editor(initial?: string): Promise<string> {
                return `${this.prefix}:editor:${initial ?? ""}`;
            }

            async custom<T>(
                _factory: WorkflowCustomUiFactory<T>,
                options?: WorkflowCustomUiOptions,
            ): Promise<T> {
                return {
                    prefix: this.prefix,
                    label: options?.label,
                } as T;
            }
        }

        const def = workflow({
          name: "hil-class-adapter-this-wf",
          description: "",
          inputs: {},
          outputs: {
            values: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const values = {
                    input: await ctx.ui.input("hello"),
                    confirm: await ctx.ui.confirm("class-adapter:confirm"),
                    select: await ctx.ui.select("class-adapter:select", ["a", "b"] as const),
                    editor: await ctx.ui.editor("draft"),
                    custom: await ctx.ui.custom<{ prefix: string; label?: string }>(
                        () => ({ render: () => ["custom"], invalidate: () => undefined }),
                        { label: "widget" },
                    ),
                };
                await ctx.task("after-ui", { prompt: "record ui adapter" });
                return { values };
            },
        });

        const wfResult = await run(def, {}, {
            adapters: { prompt: { prompt: async () => "ok" } },
            ui: new StatefulUiAdapter("class-adapter"),
            store: createStore(),
        });

        assert.equal(wfResult.status, "completed");
        assert.deepEqual(wfResult.result?.["values"], {
            input: "class-adapter:input:hello",
            confirm: true,
            select: "b",
            editor: "class-adapter:editor:draft",
            custom: {
                prefix: "class-adapter",
                label: "widget",
            },
        });
    });

    test("primitive-only UI adapters reject ctx.ui.custom with the unavailable UI message", async () => {
        const uiAdapter = {
            input: async (_prompt: string) => "",
            confirm: async (_message: string) => false,
            select: async <T extends string>(
                _message: string,
                options: readonly T[],
            ) => options[0] as T,
            editor: async (_initial?: string) => "",
        };
        const def = workflow({ name: "hil-custom-adapter-missing-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.ui.custom<string>(() => ({ render: () => ["custom"], invalidate: () => undefined }));
                return {};
            },
        });

        const wfResult = await run(def, {}, { ui: uiAdapter, store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.custom is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("fallback rejects ctx.ui.input with precise missing-adapter error", async () => {
        const def = workflow({ name: "fallback-input-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.ui.input("hello");
                return {};
            },
        });

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.input is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("fallback rejects ctx.ui.confirm with precise missing-adapter error", async () => {
        const def = workflow({ name: "fallback-confirm-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.ui.confirm("sure?");
                return {};
            },
        });

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.confirm is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("fallback rejects ctx.ui.select with precise missing-adapter error", async () => {
        const def = workflow({ name: "fallback-select-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.ui.select("pick", ["x"] as const);
                return {};
            },
        });

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.select is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("fallback rejects ctx.ui.editor with precise missing-adapter error", async () => {
        const def = workflow({ name: "fallback-editor-wf", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.ui.editor();
                return {};
            },
        });

        const wfResult = await run(def, {}, { store: createStore() });

        assert.equal(wfResult.status, "failed");
        assert.equal(
            wfResult.error,
            "atomic-workflows: HIL ctx.ui.editor is unavailable because Atomic runtime did not provide a UI adapter",
        );
    });

    test("no HIL: existing run behavior unchanged when no HIL used", async () => {
        const def = workflow({
          name: "no-hil-wf",
          description: "",
          inputs: {},
          outputs: {
            r: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const r = await ctx.stage("s").prompt("go");
                return { r };
            },
        });

        const wfResult = await run(
            def,
            {},
            {
                adapters: { prompt: { prompt: async () => "ok" } },
                store: createStore(),
            },
        );

        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["r"], "ok");
    });
});

// ---------------------------------------------------------------------------
// Lifecycle persistence — appendEntry ordering
// ---------------------------------------------------------------------------

