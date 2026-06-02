import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const repoRoot = resolve(import.meta.dir, "../..");
const workflowsPackage = join(repoRoot, "packages", "workflows");

describe("standalone workflow package typing", () => {
  test("type-checks import { defineWorkflow, Type } from @bastani/workflows without a local shim", () => {
    const fixtureRoot = join(tmpdir(), `atomic-workflow-types-${randomUUID()}`);

    try {
      mkdirSync(join(fixtureRoot, "src"), { recursive: true });
      mkdirSync(join(fixtureRoot, "node_modules", "@bastani"), { recursive: true });
      symlinkSync(workflowsPackage, join(fixtureRoot, "node_modules", "@bastani", "workflows"), "dir");

      writeFileSync(
        join(fixtureRoot, "package.json"),
        JSON.stringify(
          {
            name: "standalone-workflow-typing-fixture",
            private: true,
            type: "module",
            dependencies: {
              "@bastani/workflows": "file:../../packages/workflows",
            },
            devDependencies: {
              typescript: "^6.0.3",
            },
          },
          null,
          2,
        ),
      );

      writeFileSync(
        join(fixtureRoot, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
              skipLibCheck: false,
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        ),
      );

      writeFileSync(
        join(fixtureRoot, "src", "workflow.ts"),
        `import {
  GraphFrontierTracker,
  createCancellationRegistry,
  createStore,
  defineWorkflow,
  run,
  Type,
} from "@bastani/workflows";
import type {
  AgentSessionAdapter,
  StageAdapters,
  WorkflowExecutionPolicy,
  WorkflowDefinition,
  WorkflowInputBindings,
  WorkflowInputSchemaMap,
  WorkflowMcpPort,
  WorkflowModelCatalogPort,
  WorkflowOutputSchemaMap,
  WorkflowPersistencePort,
  WorkflowRunOutput,
  WorkflowRuntimeConfig,
  WorkflowTaskSessionOptions,
  WorkflowUIAdapter,
} from "@bastani/workflows";
// @ts-expect-error runWorkflow was removed from the public package surface.
import { runWorkflow } from "@bastani/workflows";
// @ts-expect-error WorkflowOptions was removed with the object-form runWorkflow API.
import type { WorkflowOptions } from "@bastani/workflows";
// @ts-expect-error WorkflowRunOptions was removed with the object-form runWorkflow API.
import type { WorkflowRunOptions } from "@bastani/workflows";

const workflow = defineWorkflow("Standalone Typing Fixture")
  .description("Verifies package export types without declare module shims")
  .input("message", Type.String())
  .input("mode", Type.Literal("fast", { default: "fast" }))
  .input("size", Type.Enum(["small", "large"] as const, { default: "small" }))
  .input("count", Type.Number({ default: 1 }))
  .input("integerCount", Type.Integer({ default: 2 }))
  .input("enabled", Type.Boolean({ default: true }))
  .input("nickname", Type.Optional(Type.String()))
  .input("alias", Type.String({ default: "anon" }))
  .input("tags", Type.Array(Type.String(), { default: [] }))
  .input("settings", Type.Object({ enabled: Type.Boolean() }, { default: { enabled: true } }))
  .input("partialConfig", Type.Partial(Type.Object({ enabled: Type.Boolean() }), { default: {} }))
  .input("variant", Type.Union([Type.Literal("a"), Type.Literal("b")], { default: "a" }))
  .input("labels", Type.Record(Type.String(), Type.String(), { default: {} }))
  .input("tuple", Type.Tuple([Type.String(), Type.Number()], { default: ["x", 1] }))
  .input("nothing", Type.Null({ default: null }))
  .output("summary", Type.String())
  .output("maybe", Type.Optional(Type.String()))
  .run(async (ctx) => {
    const message: string = ctx.inputs.message;
    const mode: "fast" = ctx.inputs.mode;
    const size: "small" | "large" = ctx.inputs.size;
    const count: number = ctx.inputs.count;
    const integerCount: number = ctx.inputs.integerCount;
    const enabled: boolean = ctx.inputs.enabled;
    const nickname: string | undefined = ctx.inputs.nickname;
    const alias: string = ctx.inputs.alias;
    const tags: string[] = ctx.inputs.tags;
    const settings: { enabled: boolean } = ctx.inputs.settings;
    const partialConfig: { enabled?: boolean } = ctx.inputs.partialConfig;
    const variant: "a" | "b" = ctx.inputs.variant;
    const labels: Record<string, string> = ctx.inputs.labels;
    const tuple: [string, number] = ctx.inputs.tuple;
    const nothing: null = ctx.inputs.nothing;
    // @ts-expect-error optional input is not a definite string.
    const requiredNickname: string = ctx.inputs.nickname;
    await ctx.task("echo", { prompt: message, output: "echo.md" });
    const chained = await ctx.chain([
      { name: "first", prompt: message },
      { name: "second", prompt: String(count) },
      { name: "third", prompt: mode },
      { name: "fourth", prompt: String(enabled) },
      { name: "fifth", prompt: size },
      { name: "sixth", prompt: String(integerCount) },
      { name: "seventh", prompt: alias },
      { name: "eighth", prompt: tags.join(",") },
      { name: "ninth", prompt: String(settings.enabled) },
      { name: "partial", prompt: String(partialConfig.enabled ?? "unset") },
      { name: "tenth", prompt: variant },
      { name: "eleventh", prompt: Object.keys(labels).join(",") },
      { name: "twelfth", prompt: tuple.join(":") },
      { name: "thirteenth", prompt: String(nothing) },
    ]);
    return { summary: chained.at(-1)?.text ?? "", maybe: nickname };
  })
  .compile();

const optionalOutputWorkflow = defineWorkflow("Optional Output Fixture")
  .output("maybe", Type.Optional(Type.String()))
  .run(() => ({}))
  .compile();

const undeclaredOutputWorkflow = defineWorkflow("Undeclared Output Fixture")
  // @ts-expect-error run outputs must be declared before returning them.
  .run(() => ({ summary: "not declared" }))
  .compile();

run(workflow, { message: "hello" }, { executionMode: "non_interactive" });
run(workflow, { message: "hello", mode: "fast", size: "large", count: 2, integerCount: 3, enabled: false }, { executionMode: "interactive" });
// @ts-expect-error detached is not a runtime executionMode literal.
run(workflow, { message: "hello" }, { executionMode: "detached" });
// @ts-expect-error message has no default and remains required.
run(workflow, {});

run(optionalOutputWorkflow, {});
// @ts-expect-error WorkflowDefinition is non-structural; only compile() can produce it.
const forgedWorkflow: WorkflowDefinition = { __piWorkflow: true, name: "forged", normalizedName: "forged", description: "forged", inputs: {}, run: () => ({}) };
const frontier = new GraphFrontierTracker();
const store = createStore();
const cancellationRegistry = createCancellationRegistry();
const adapter: AgentSessionAdapter | undefined = undefined;
const adapters: StageAdapters = { agentSession: adapter };
const policy: WorkflowExecutionPolicy = { mode: "interactive", allowHumanInput: true, awaitTerminalRun: false, allowInputPicker: true };
const inputBindings: WorkflowInputBindings = { worktree: { gitWorktreeDir: ".worktrees", baseBranch: "main" } };
const inputSchemas: WorkflowInputSchemaMap = { message: Type.String() };
const outputSchemas: WorkflowOutputSchemaMap = { summary: Type.String() };
const runOutput: WorkflowRunOutput = { summary: "ok" };
const runtimeConfig: WorkflowRuntimeConfig = { maxDepth: 4, defaultConcurrency: 4, persistRuns: true, statusFile: false, resumeInFlight: "ask" };
const ui: WorkflowUIAdapter | undefined = undefined;
const mcp: WorkflowMcpPort | undefined = undefined;
const persistence: WorkflowPersistencePort | undefined = undefined;
const catalog: WorkflowModelCatalogPort | undefined = undefined;
const taskSession: WorkflowTaskSessionOptions = { prompt: "hello", tools: ["bash"], noTools: "builtin", customTools: [{ name: "custom", description: "Custom tool" }] };
void undeclaredOutputWorkflow;
void frontier;
void store;
void cancellationRegistry;
void adapters;
void policy;
void inputBindings;
void inputSchemas;
void outputSchemas;
void runOutput;
void runtimeConfig;
void ui;
void mcp;
void persistence;
void catalog;
void taskSession;
void forgedWorkflow;
void runWorkflow;
type RemovedWorkflowOptions = WorkflowOptions;
type RemovedWorkflowRunOptions = WorkflowRunOptions;

export default workflow;
`,
      );

      const options: ExecFileSyncOptionsWithStringEncoding = {
        cwd: repoRoot,
        stdio: "pipe",
        encoding: "utf8",
      };
      try {
        execFileSync("bun", [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", fixtureRoot], options);
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        assert.fail([failure.message, failure.stdout, failure.stderr].filter(Boolean).join("\n"));
      }

      assert.ok(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
