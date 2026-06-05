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
  INTERACTIVE_WORKFLOW_POLICY,
  NON_INTERACTIVE_WORKFLOW_POLICY,
  createCancellationRegistry,
  createStore,
  defineWorkflow,
  run,
  Type,
} from "@bastani/workflows";
import { goal, openClaudeDesign, ralph } from "@bastani/workflows/builtin";
import goalDefault from "@bastani/workflows/builtin/goal";
import openClaudeDesignDefault from "@bastani/workflows/builtin/open-claude-design";
import ralphDefault from "@bastani/workflows/builtin/ralph";
import type {
  DeepResearchCodebaseWorkflowOutputs,
  GoalWorkflowOutputs,
  GoalWorkflowStatus,
  OpenClaudeDesignWorkflowOutputs,
  RalphWorkflowOutputs,
  RalphWorkflowRunInputs,
} from "@bastani/workflows/builtin";
import type {
  AgentSessionAdapter,
  StageAdapters,
  StageOptions,
  StageStatus,
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
  .input("pickedConfig", Type.Pick(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["enabled"] as const, { default: { enabled: true } }))
  .input("omittedConfig", Type.Omit(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["name"] as const, { default: { enabled: true } }))
  .input("requiredConfig", Type.Required(Type.Object({ enabled: Type.Optional(Type.Boolean()) }), { default: { enabled: true } }))
  .input("pickedNoDefault", Type.Pick(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["enabled"] as const))
  .input("omittedNoDefault", Type.Omit(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["name"] as const))
  .input("variant", Type.Union([Type.Literal("a"), Type.Literal("b")], { default: "a" }))
  .input("labels", Type.Record(Type.String(), Type.String(), { default: {} }))
  .input("finiteLabels", Type.Record(Type.Union([Type.Literal("foo"), Type.Literal("bar")]), Type.Number(), { default: { foo: 1, bar: 2 } }))
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
    const pickedConfig: { enabled: boolean } = ctx.inputs.pickedConfig;
    const omittedConfig: { enabled: boolean } = ctx.inputs.omittedConfig;
    const requiredConfig: { enabled: boolean } = ctx.inputs.requiredConfig;
    // @ts-expect-error pickedConfig should not expose keys removed by Pick.
    ctx.inputs.pickedConfig.name;
    // @ts-expect-error omittedConfig should not expose keys removed by Omit.
    ctx.inputs.omittedConfig.name;
    const pickedNoDefault: { enabled: boolean } = ctx.inputs.pickedNoDefault;
    const omittedNoDefault: { enabled: boolean } = ctx.inputs.omittedNoDefault;
    // @ts-expect-error pickedNoDefault should not expose keys removed by Pick.
    ctx.inputs.pickedNoDefault.name;
    // @ts-expect-error omittedNoDefault should not expose keys removed by Omit.
    ctx.inputs.omittedNoDefault.name;
    const variant: "a" | "b" = ctx.inputs.variant;
    const labels: Record<string, string> = ctx.inputs.labels;
    const finiteLabels: { foo: number; bar: number } = ctx.inputs.finiteLabels;
    // @ts-expect-error finite record keys should not accept extra keys.
    const finiteLabelsWithExtra: typeof finiteLabels = { foo: 1, bar: 2, baz: 3 };
    // @ts-expect-error finite record keys should require all literal keys.
    const finiteLabelsMissingKey: typeof finiteLabels = { foo: 1 };
    const tuple: [string, number] = ctx.inputs.tuple;
    const nothing: null = ctx.inputs.nothing;
    // @ts-expect-error optional input is not a definite string.
    const requiredNickname: string = ctx.inputs.nickname;
    // @ts-expect-error stage options do not accept prompt/output-only fields.
    ctx.stage("invalid-stage-output", { output: "stage.md" });
    const typedStage = ctx.stage("typed-stage", { cwd: ".", fallbackModels: ["fallback-model"], scopedModels: [{ model: "model-a", thinkingLevel: "low" }] });
    // @ts-expect-error standalone authors cannot supply runtime SessionManager objects without Atomic types.
    ctx.stage("invalid-session-manager", { sessionManager: {} });
    // @ts-expect-error standalone authors cannot supply partial runtime SettingsManager objects without Atomic types.
    ctx.stage("invalid-settings-manager", { settingsManager: { getCodexFastModeSettings() { return { enabled: true }; } } });
    // @ts-expect-error custom tools must provide the full runtime tool shape.
    ctx.stage("invalid-custom-tool", { customTools: [{ name: "bad" }] });
    await typedStage.prompt("typed prompt", {
      output: "typed.md",
      outputMode: "file-only",
      streamingBehavior: "steer",
      source: "extension",
      preflightResult(success: boolean) { void success; },
      images: [{ type: "image", image: "data:image/png;base64,AA==" }],
    });
    // @ts-expect-error streamingBehavior is forwarded to the runtime SDK and must be a supported literal.
    await typedStage.prompt("bad streaming", { streamingBehavior: "invalid" });
    // @ts-expect-error source is forwarded to the runtime SDK and must be a supported literal.
    await typedStage.prompt("bad source", { source: "invalid" });
    // @ts-expect-error preflightResult must be a runtime callback, not an object.
    await typedStage.prompt("bad preflight", { preflightResult: {} });
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
      { name: "picked", prompt: JSON.stringify(pickedConfig) },
      { name: "omitted", prompt: JSON.stringify(omittedConfig) },
      { name: "required", prompt: JSON.stringify(requiredConfig) },
      { name: "pickedNoDefault", prompt: JSON.stringify(pickedNoDefault) },
      { name: "omittedNoDefault", prompt: JSON.stringify(omittedNoDefault) },
      { name: "tenth", prompt: variant },
      { name: "eleventh", prompt: Object.keys(labels).join(",") },
      { name: "finite", prompt: String(finiteLabels.foo + finiteLabels.bar) },
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

const nonSerializableOutputWorkflow = defineWorkflow("Non Serializable Output Fixture")
  .output("n", Type.BigInt())
  // @ts-expect-error workflow outputs must be JSON-serializable at runtime.
  .run(() => ({ n: 1n }))
  .compile();

const postRunEditedWorkflow = defineWorkflow("Post Run Edited Fixture")
  .output("summary", Type.String())
  .run(() => ({ summary: "ok" }))
  .description("Runtime supports metadata edits after run")
  .input("postRunInput", Type.String({ default: "ok" }))
  .compile();

run(workflow, { message: "hello", pickedNoDefault: { enabled: true }, omittedNoDefault: { enabled: true } }, { executionMode: "non_interactive" });
run(workflow, { message: "hello", mode: "fast", size: "large", count: 2, integerCount: 3, enabled: false, pickedNoDefault: { enabled: true }, omittedNoDefault: { enabled: true } }, { executionMode: "interactive" });
// @ts-expect-error detached is not a runtime executionMode literal.
run(workflow, { message: "hello", pickedNoDefault: { enabled: true }, omittedNoDefault: { enabled: true } }, { executionMode: "detached" });
// @ts-expect-error message has no default and remains required.
run(workflow, {});

run(optionalOutputWorkflow, {});
run(postRunEditedWorkflow, {});
run(goal, { objective: "x" });
run(goalDefault, { objective: "x" });
run(ralph, { prompt: "x" });
run(ralph, { prompt: "x", create_pr: true });
run(ralphDefault, { prompt: "x", create_pr: false });
run(openClaudeDesign, { prompt: "x", output_type: "prototype" });
run(openClaudeDesignDefault, { prompt: "x", output_type: "tokens" });
run(goal, { objective: "x" }).then((runResult) => {
  const status: GoalWorkflowStatus | undefined = runResult.result?.status;
  const firstReceiptPath: string | undefined = runResult.result?.receipts?.[0]?.artifact_path;
  void status;
  void firstReceiptPath;
});
const typedGoalOutputs: GoalWorkflowOutputs = { status: "complete", approved: true, receipts: [{ turn: 1, stage: "worker", artifact_path: "worker.md", summary: "done" }] };
const typedDesignOutputs: OpenClaudeDesignWorkflowOutputs = { approved_for_export: true, preview_path: "preview.html", refinements_completed: 1 };
const typedDeepResearchOutputs: DeepResearchCodebaseWorkflowOutputs = { partitions: ["core"], explorer_count: 1, research_doc_path: "research.md" };
const typedRalphOutputs: RalphWorkflowOutputs = { approved: true, iterations_completed: 1, plan_path: "spec.md" };
const typedRalphRunInputs: RalphWorkflowRunInputs = { prompt: "x", create_pr: true };
void typedGoalOutputs;
void typedDesignOutputs;
void typedDeepResearchOutputs;
void typedRalphOutputs;
void typedRalphRunInputs;
// @ts-expect-error builtin goal status is a declared literal union.
const invalidGoalOutputs: GoalWorkflowOutputs = { status: "done" };
// @ts-expect-error builtin open-claude-design only accepts runtime-declared output_type values.
run(openClaudeDesign, { prompt: "x", output_type: "flow" });
// @ts-expect-error builtin ralph create_pr must be boolean.
run(ralph, { prompt: "x", create_pr: "true" });
// @ts-expect-error builtin goal requires an objective input.
run(goal, {});
// @ts-expect-error builtin goal default export requires an objective input.
run(goalDefault, {});
// @ts-expect-error WorkflowDefinition is non-structural; only compile() can produce it.
const forgedWorkflow: WorkflowDefinition = { __piWorkflow: true, name: "forged", normalizedName: "forged", description: "forged", inputs: {}, run: () => ({}) };
const forgedRunnable = { __piWorkflow: true, name: "forged", normalizedName: "forged", description: "forged", inputs: {}, run: () => ({}) } as const;
// @ts-expect-error run requires a branded compiled WorkflowDefinition, not a structural object.
run(forgedRunnable, {});
const frontier = new GraphFrontierTracker();
const store = createStore();
store.runs();
store.notices();
store.activeRunId();
const cancellationRegistry = createCancellationRegistry();
const controller = new AbortController();
cancellationRegistry.register("run-1", controller);
cancellationRegistry.registerChild("run-1", new AbortController());
cancellationRegistry.abort("run-1", "stop");
cancellationRegistry.abortAll("stop-all");
cancellationRegistry.isAborted("run-1");
cancellationRegistry.unregister("run-1");
const adapter: AgentSessionAdapter = {
  async create(options: StageOptions) {
    void options;
    return {
      settingsManager: {
        getCodexFastModeSettings() { return { enabled: true, model: "fixture" }; },
      },
      session: {
      async prompt() {},
      async steer() {},
      async followUp() {},
      subscribe() { return () => {}; },
      sessionFile: undefined,
      sessionId: "fixture-session",
      async setModel() {},
      setThinkingLevel() {},
      cycleModel() { return null; },
      cycleThinkingLevel() { return undefined; },
      agent: {},
      model: null,
      thinkingLevel: undefined,
      messages: [],
      isStreaming: false,
      async navigateTree() { return { cancelled: false }; },
      async compact() { return {}; },
      abortCompaction() {},
      async abort() {},
      dispose() {},
      },
    };
  },
};
const adapters: StageAdapters = { agentSession: adapter };
const policy: WorkflowExecutionPolicy = { mode: "interactive", allowHumanInput: true, awaitTerminalRun: false, allowInputPicker: true };
const interactivePolicy: WorkflowExecutionPolicy = INTERACTIVE_WORKFLOW_POLICY;
const nonInteractivePolicyMode: WorkflowExecutionPolicy["mode"] = NON_INTERACTIVE_WORKFLOW_POLICY.mode;
const inputBindings: WorkflowInputBindings = { worktree: { gitWorktreeDir: ".worktrees", baseBranch: "main" } };
const inputSchemas: WorkflowInputSchemaMap = { message: Type.String() };
const outputSchemas: WorkflowOutputSchemaMap = { summary: Type.String() };
const runOutput: WorkflowRunOutput = { summary: "ok" };
const runtimeConfig: WorkflowRuntimeConfig = { maxDepth: 4, defaultConcurrency: 4, persistRuns: true, statusFile: false, resumeInFlight: "ask" };
const ui: WorkflowUIAdapter | undefined = undefined;
const mcp: WorkflowMcpPort | undefined = undefined;
const persistence: WorkflowPersistencePort | undefined = undefined;
const catalog: WorkflowModelCatalogPort | undefined = undefined;
const taskSession: WorkflowTaskSessionOptions = { prompt: "hello", tools: ["bash"], noTools: "builtin", customTools: [{
  name: "custom",
  label: "Custom",
  description: "Custom tool",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_toolCallId, params) { void params; return { content: [{ type: "text", text: "ok" }] }; },
}] };
type StageSnapshotStatus = import("@bastani/workflows").StageSnapshot["status"];
const skippedStageStatus: StageSnapshotStatus = "skipped";
const awaitingInputStageStatus: StageSnapshotStatus = "awaiting_input";
const blockedStageSnapshotStatus: StageSnapshotStatus = "blocked";
const skippedNamedStageStatus: StageStatus = "skipped";
const awaitingInputNamedStageStatus: StageStatus = "awaiting_input";
const blockedNamedStageStatus: StageStatus = "blocked";
// @ts-expect-error stage snapshots only expose runtime stage statuses.
const invalidStageStatus: StageSnapshotStatus = "detached";
void undeclaredOutputWorkflow;
void nonSerializableOutputWorkflow;
void frontier;
void store;
void cancellationRegistry;
void adapters;
void policy;
void interactivePolicy;
void nonInteractivePolicyMode;
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
void skippedStageStatus;
void awaitingInputStageStatus;
void blockedStageSnapshotStatus;
void skippedNamedStageStatus;
void awaitingInputNamedStageStatus;
void blockedNamedStageStatus;
void invalidStageStatus;
void forgedWorkflow;
run(workflow, { message: "hello", pickedNoDefault: { enabled: true }, omittedNoDefault: { enabled: true } }, { adapters, ui, signal: new AbortController().signal, config: runtimeConfig, models: catalog, mcp, persistence, cancellation: cancellationRegistry });
// @ts-expect-error runWorkflow is a removed runtime stub and must not be called.
runWorkflow();
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
  }, 60_000);
});
