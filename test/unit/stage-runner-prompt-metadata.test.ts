import { describe, test } from "bun:test";
import type {
    AgentSessionAdapter,
    InternalStageContext,
    PromptAdapter,
    StageExecutionMeta,
} from "./stage-runner-helpers.js";
import {
    assert,
    createStageContext,
    join,
    makeMockSession,
    makeOpts,
    makeSignal,
    mkdtemp,
    readFile,
    rm,
    tmpdir,
} from "./stage-runner-helpers.js";

describe("createStageContext — prompt metadata propagation", () => {
    test("prompt adapter receives runId from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter }, runId: "run-001" }),
        );
        await ctx.prompt("hello");
        assert.equal(received[0]?.runId, "run-001");
    });

    test("prompt adapter receives stageId from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter }, stageId: "s-99" }),
        );
        await ctx.prompt("hi");
        assert.equal(received[0]?.stageId, "s-99");
    });

    test("prompt adapter receives stageName from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { prompt: promptAdapter },
                stageName: "Analysis",
            }),
        );
        await ctx.prompt("analyze");
        assert.equal(received[0]?.stageName, "Analysis");
    });

    test("prompt adapter receives signal from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const signal = makeSignal();
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter }, signal }),
        );
        await ctx.prompt("go");
        assert.equal(received[0]?.signal, signal);
    });

    test("prompt adapter receives full meta object in one call", async () => {
        const received: StageExecutionMeta[] = [];
        const signal = makeSignal();
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "done";
            },
        };
        const ctx = createStageContext({
            stageId: "s-42",
            stageName: "Summarise",
            runId: "r-100",
            signal,
            adapters: { prompt: promptAdapter },
        });
        await ctx.prompt("summarise this");
        assert.deepEqual(received[0], {
            runId: "r-100",
            stageId: "s-42",
            stageName: "Summarise",
            signal,
            stageOptions: undefined,
            executionMode: undefined,
        });
    });

    test("prompt adapter receives the text passed to ctx.prompt", async () => {
        const texts: string[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(text) {
                texts.push(text);
                return "ack";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter } }),
        );
        await ctx.prompt("specific text payload");
        assert.deepEqual(texts, ["specific text payload"]);
    });

    test("signal is undefined in meta when opts.signal absent", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter } }),
        );
        await ctx.prompt("go");
        assert.equal(received[0]?.signal, undefined);
    });

    test("prompt adapter receives executionMode from opts", async () => {
        const received: StageExecutionMeta[] = [];
        const promptAdapter: PromptAdapter = {
            async prompt(_text, meta) {
                received.push(meta!);
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({
                adapters: { prompt: promptAdapter },
                executionMode: "non_interactive",
            }),
        );
        await ctx.prompt("go");
        assert.equal(received[0]?.executionMode, "non_interactive");
    });

    test("prompt outputMode=file-only writes full output and returns a saved-file reference", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-output-"));
        try {
            const output = join(dir, "answer.md");
            const promptAdapter: PromptAdapter = {
                async prompt() {
                    return "line one\nline two";
                },
            };
            const ctx = createStageContext(
                makeOpts({ adapters: { prompt: promptAdapter } }),
            );

            const result = await ctx.prompt("go", {
                output,
                outputMode: "file-only",
            });

            assert.match(result, /^Output saved to: /);
            assert.match(result, /answer\.md/);
            assert.equal(await readFile(output, "utf8"), "line one\nline two");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("prompt outputMode=file-only requires an output path", async () => {
        const promptAdapter: PromptAdapter = {
            async prompt() {
                return "ok";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter } }),
        );
        await assert.rejects(
            ctx.prompt("go", { outputMode: "file-only" }),
            /outputMode: "file-only".*output file/,
        );
    });

    test("prompt maxOutput truncates inline output", async () => {
        const promptAdapter: PromptAdapter = {
            async prompt() {
                return "first line\nsecond line";
            },
        };
        const ctx = createStageContext(
            makeOpts({ adapters: { prompt: promptAdapter } }),
        );

        const result = await ctx.prompt("go", { maxOutput: { lines: 1 } });

        assert.equal(
            result,
            "first line\n\n[workflow output truncated; limits: 204800 bytes, 1 lines]",
        );
    });

    test("prompt strips workflow output options before delegating to the SDK session", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-workflows-session-dir-"));
        try {
            const receivedOptions: Array<Record<string, unknown> | undefined> =
                [];
            const { session } = makeMockSession({
                async prompt(_text, options) {
                    receivedOptions.push(
                        options as Record<string, unknown> | undefined,
                    );
                },
                getLastAssistantText() {
                    return "ok";
                },
            });
            const agentSession: AgentSessionAdapter = {
                async create() {
                    return session;
                },
            };
            const ctx = createStageContext(
                makeOpts({
                    adapters: { agentSession },
                    stageOptions: {
                        cwd: dir,
                        sessionDir: dir,
                        context: "fork",
                    },
                }),
            ) as InternalStageContext;

            const result = await ctx.prompt("go", {
                output: false,
                maxOutput: { bytes: 10 },
                cwd: "/ignored-for-session",
                context: "fresh",
                sessionDir: "/ignored-sessions",
                expandPromptTemplates: false,
            });

            assert.equal(result, "ok");
            assert.deepEqual(receivedOptions[0], {
                expandPromptTemplates: false,
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// complete — metadata propagation + CompleteStageOpts preservation
// ---------------------------------------------------------------------------

