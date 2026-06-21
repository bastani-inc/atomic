import { describe } from "bun:test";
import {
    assert, createRegistry, createStore, workflow, join, mkdtempSync, mockSession,
    readFileSync, run, structuredOutputMockSession, test, tmpdir, Type,
    type CreateAgentSessionOptions, type WorkflowDefinition,
} from "./executor-shared.js";
describe("executor.run", () => {
    test("ctx.workflow fails when declared required output is missing", async () => {
        const seenPrompts: string[] = [];
        const child = workflow({
          name: "missing-output-child",
          description: "",
          inputs: {},
          outputs: {
            summary: Type.String(),
          },
          run: async (ctx) => {
                await ctx.task("child", { prompt: "child" });
                // Intentionally omit the required `summary` output to exercise the
                // runtime missing-output guard; bypass the static contract here.
                return {} as { readonly summary: string };
            },
        });
        const parent = workflow({ name: "missing-output-parent", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                await ctx.workflow(child);
                await ctx.task("downstream", { prompt: "should-not-run" });
                return {};
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: createStore(),
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return "ok";
                        },
                    },
                },
            },
        );
        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /missing output "summary"/);
        assert.deepEqual(seenPrompts, ["child"]);
        assert.deepEqual(
            wfResult.stages.map((stage) => stage.name),
            ["workflow:missing-output-child"],
        );
        assert.equal(wfResult.stages[0]?.status, "failed");
    });
    test("ctx.workflow validates child inputs before starting a child run", async () => {
        const seenPrompts: string[] = [];
        const st = createStore();
        const child = workflow({
          name: "input-child",
          description: "",
          inputs: {
            topic: Type.String(),
          },
          outputs: {},
          run: async (ctx) => {
                await ctx.task("child", { prompt: String(ctx.inputs.topic) });
                return {};
            },
        });
        const parent = workflow({ name: "input-parent", description: "", inputs: {}, outputs: {}, run: async (ctx) => {
                // Intentionally pass a wrong-typed input to exercise the runtime
                // input validation guard; bypass the static contract here.
                await ctx.workflow(child, { inputs: { topic: 123 as unknown as string } });
                return {};
            },
        });
        const wfResult = await run(
            parent,
            {},
            {
                registry: createRegistry([
                    parent as WorkflowDefinition,
                    child as WorkflowDefinition,
                ]),
                store: st,
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return "ok";
                        },
                    },
                },
            },
        );
        assert.equal(wfResult.status, "failed");
        assert.match(wfResult.error ?? "", /invalid inputs/);
        assert.deepEqual(seenPrompts, []);
        assert.equal(st.runs().length, 1);
        assert.equal(wfResult.stages[0]?.name, "workflow:input-child");
        assert.equal(wfResult.stages[0]?.status, "failed");
    });
    test("ctx.chain follows direct workflow previous defaults", async () => {
        const seenPrompts: string[] = [];
        const def = workflow({
          name: "task-chain-wf",
          description: "",
          inputs: {},
          outputs: {
            final: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const results = await ctx.chain(
                    [
                        { name: "scout" },
                        { name: "planner" },
                        { name: "worker", task: "implement from {previous}" },
                    ],
                    { task: "analyze auth" },
                );
                return { final: results.at(-1)?.text };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return `out:${seenPrompts.length}`;
                        },
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.deepEqual(seenPrompts, [
            "analyze auth",
            "out:1",
            "implement from out:2",
        ]);
        assert.equal(wfResult.result?.["final"], "out:3");
    });
    test("ctx.parallel follows direct workflow shared task fallback", async () => {
        const seenPrompts: string[] = [];
        const def = workflow({
          name: "task-parallel-wf",
          description: "",
          inputs: {},
          outputs: {
            count: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const results = await ctx.parallel([
                    { name: "frontend", task: "audit UI" },
                    { name: "backend" },
                ]);
                return { count: results.length };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return `out:${text}`;
                        },
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.deepEqual(seenPrompts.sort(), ["audit UI", "audit UI"]);
        assert.equal(wfResult.result?.["count"], 2);
    });
    test("ctx.task forwards createAgentSession options to the SDK session", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const def = workflow({
          name: "task-session-options-wf",
          description: "",
          inputs: {},
          outputs: {
            text: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const result = await ctx.task("scout", {
                    task: "inspect",
                    cwd: "/repo",
                    tools: ["read"],
                    noTools: "builtin",
                    thinkingLevel: "high",
                });
                return { text: result.text };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return mockSession();
                        },
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.equal(calls[0]?.cwd, "/repo");
        assert.deepEqual(calls[0]?.tools, ["read"]);
        assert.equal(calls[0]?.noTools, "builtin");
        assert.equal(calls[0]?.thinkingLevel, "high");
    });
    test("ctx.stage schema opt-in registers structured_output and returns captured params", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const DecisionSchema = Type.Object(
            { approved: Type.Boolean() },
            { additionalProperties: false },
        );
        const def = workflow({
          name: "stage-schema-structured-output-wf",
          description: "",
          inputs: {},
          outputs: {
            approved: Type.Boolean(),
          },
          run: async (ctx) => {
                const decision = await ctx
                    .stage("decision", { schema: DecisionSchema, tools: ["read"] })
                    .prompt("Decide whether the work is approved.");
                return { approved: decision.approved };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return structuredOutputMockSession(options, { approved: true });
                        },
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["approved"], true);
        assert.deepEqual(calls[0]?.tools, ["read", "structured_output"]);
        assert.equal(calls[0]?.customTools?.some((tool) => tool.name === "structured_output"), true);
        assert.equal("schema" in (calls[0] ?? {}), false);
    });
    test("ctx.chain and ctx.parallel only add structured_output for schema items", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const DecisionSchema = Type.Object(
            { approved: Type.Boolean() },
            { additionalProperties: false },
        );
        const def = workflow({
          name: "task-schema-structured-output-wf",
          description: "",
          inputs: {},
          outputs: {
            chainStructured: Type.Boolean(),
            parallelStructured: Type.Boolean(),
            plainStructured: Type.Boolean(),
          },
          run: async (ctx) => {
                const chainResults = await ctx.chain([
                    { name: "chain-decision", task: "Decide", schema: DecisionSchema },
                    { name: "chain-plain", task: "Plain" },
                ]);
                const parallelResults = await ctx.parallel([
                    { name: "parallel-decision", task: "Decide", schema: DecisionSchema },
                    { name: "parallel-plain", task: "Plain" },
                ]);
                return {
                    chainStructured: chainResults[0]?.structured !== undefined,
                    parallelStructured: parallelResults[0]?.structured !== undefined,
                    plainStructured: chainResults[1]?.structured !== undefined || parallelResults[1]?.structured !== undefined,
                };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    agentSession: {
                        async create(options) {
                            calls.push(options);
                            return structuredOutputMockSession(options, { approved: true });
                        },
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.equal(wfResult.result?.["chainStructured"], true);
        assert.equal(wfResult.result?.["parallelStructured"], true);
        assert.equal(wfResult.result?.["plainStructured"], false);
        assert.equal(calls.filter((call) => call.customTools?.some((tool) => tool.name === "structured_output")).length, 2);
    });
    test("ctx.task applies maxOutput truncation to reusable task output", async () => {
        const def = workflow({
          name: "task-max-output-wf",
          description: "",
          inputs: {},
          outputs: {
            text: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const result = await ctx.task("summarizer", {
                    task: "summarize",
                    maxOutput: { lines: 1, bytes: 8 },
                });
                return { text: result.text };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "first line\nsecond line",
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.match(
            String(wfResult.result?.["text"]),
            /^first li\n\n\[workflow output truncated/,
        );
    });
    test("ctx.chain prepends reads as resolved instructions from chainDir", async () => {
        const seenPrompts: string[] = [];
        const dir = mkdtempSync(join(tmpdir(), "workflow-task-reads-"));
        const def = workflow({
          name: "task-reads-wf",
          description: "",
          inputs: {},
          outputs: {
            done: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                await ctx.chain([{ name: "reader", task: "summarize docs" }], {
                    reads: ["notes.md", join(dir, "absolute.md")],
                    chainDir: dir,
                });
                return { done: true };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async (text) => {
                            seenPrompts.push(text);
                            return "ok";
                        },
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.match(
            seenPrompts[0] ?? "",
            new RegExp(
                `^\\[Read from: ${join(dir, "notes.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, ${join(dir, "absolute.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
            ),
        );
        assert.match(seenPrompts[0] ?? "", /summarize docs/);
    });
    test("ctx.task forwards output options to the stage prompt", async () => {
        const dir = mkdtempSync(join(tmpdir(), "workflow-task-output-"));
        const output = join(dir, "summary.md");
        const def = workflow({
          name: "task-output-wf",
          description: "",
          inputs: {},
          outputs: {
            text: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const result = await ctx.task("writer", {
                    task: "write",
                    output,
                    outputMode: "file-only",
                });
                return { text: result.text };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "full task output",
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.equal(readFileSync(output, "utf8"), "full task output");
        assert.match(String(wfResult.result?.["text"]), /Output saved to:/);
    });
    test("ctx.parallel forwards step output options", async () => {
        const dir = mkdtempSync(join(tmpdir(), "workflow-parallel-output-"));
        const output = join(dir, "parallel.md");
        const def = workflow({
          name: "parallel-output-wf",
          description: "",
          inputs: {},
          outputs: {
            text: Type.Optional(Type.Any()),
          },
          run: async (ctx) => {
                const [result] = await ctx.parallel([
                    {
                        name: "writer",
                        task: "write",
                        output,
                        outputMode: "file-only",
                    },
                ]);
                return { text: result?.text };
            },
        });
        const wfResult = await run(
            def,
            {},
            {
                adapters: {
                    prompt: {
                        prompt: async () => "parallel task output",
                    },
                },
                store: createStore(),
            },
        );
        assert.equal(wfResult.status, "completed");
        assert.equal(readFileSync(output, "utf8"), "parallel task output");
        assert.match(String(wfResult.result?.["text"]), /Output saved to:/);
    });
});