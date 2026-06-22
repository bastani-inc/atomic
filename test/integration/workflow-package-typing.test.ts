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
  test("type-checks workflow from @bastani/workflows and Type from typebox without a local shim", () => {
    const fixtureRoot = join(tmpdir(), `atomic-workflow-types-${randomUUID()}`);
    try {
      mkdirSync(join(fixtureRoot, "src"), { recursive: true });
      mkdirSync(join(fixtureRoot, "node_modules", "@bastani"), { recursive: true });
      symlinkSync(workflowsPackage, join(fixtureRoot, "node_modules", "@bastani", "workflows"), "dir");
      symlinkSync(join(repoRoot, "node_modules", "typebox"), join(fixtureRoot, "node_modules", "typebox"), "dir");
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
              skipLibCheck: true,
              allowImportingTsExtensions: true,
              allowArbitraryExtensions: true,
              ignoreDeprecations: "6.0",
              baseUrl: ".",
              paths: {
                "@bastani/atomic": [join(repoRoot, "packages", "coding-agent", "src", "index.ts")],
                "@earendil-works/pi-tui": [join(repoRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.d.ts")],
              },
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
  workflow,
  run,
} from "@bastani/workflows";
import { Type } from "typebox";
import { goal, openClaudeDesign, ralph } from "@bastani/workflows/builtin";
import goalDefault from "@bastani/workflows/builtin/goal";
import openClaudeDesignDefault from "@bastani/workflows/builtin/open-claude-design";
import ralphDefault from "@bastani/workflows/builtin/ralph";
import type {
  DeepResearchCodebaseWorkflowOutputs,
  GoalWorkflowOutputs,
  GoalWorkflowRunInputs,
  GoalWorkflowStatus,
  OpenClaudeDesignWorkflowOutputs,
  RalphWorkflowOutputs,
  RalphWorkflowRunInputs,
} from "@bastani/workflows/builtin";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@bastani/atomic";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type {
  AgentSessionAdapter,
  StageAdapters,
  StageOptions,
  StageStatus,
  WorkflowDefinition,
  WorkflowExecutionPolicy,
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
  WorkflowCustomUiComponent,
  WorkflowCustomUiFactory,
  WorkflowCustomUiKeybindings,
  WorkflowCustomUiOptions,
  WorkflowCustomUiOverlayHandle,
  WorkflowCustomUiOverlayOptions,
  WorkflowCustomUiTheme,
  WorkflowCustomUiTui,
} from "@bastani/workflows";
import { runWorkflow } from "@bastani/workflows";
// @ts-expect-error WorkflowOptions was removed with the object-form runWorkflow API.
import type { WorkflowOptions } from "@bastani/workflows";
// @ts-expect-error WorkflowRunOptions was removed with the object-form runWorkflow API.
import type { WorkflowRunOptions } from "@bastani/workflows";
declare const extensionUiForTypes: ExtensionUIContext;
const authoredWorkflow = workflow({
  name: "Standalone Typing Fixture",
  description: "Verifies package export types without declare module shims",
  inputs: {
    message: Type.String(),
    mode: Type.Literal("fast", { default: "fast" }),
    size: Type.Enum(["small", "large"] as const, { default: "small" }), objectMode: Type.Enum({ Fast: "fast", Slow: "slow" } as const, { default: "fast" }),
    count: Type.Number({ default: 1 }),
    integerCount: Type.Integer({ default: 2 }),
    enabled: Type.Boolean({ default: true }),
    nickname: Type.Optional(Type.String()),
    alias: Type.String({ default: "anon" }),
    tags: Type.Array(Type.String(), { default: [] }),
    settings: Type.Object({ enabled: Type.Boolean() }, { default: { enabled: true } }),
    partialConfig: Type.Partial(Type.Object({ enabled: Type.Boolean() }), { default: {} }),
    pickedConfig: Type.Pick(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["enabled"] as const, { default: { enabled: true } }),
    omittedConfig: Type.Omit(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["name"] as const, { default: { enabled: true } }),
    requiredConfig: Type.Required(Type.Object({ enabled: Type.Optional(Type.Boolean()) }), { default: { enabled: true } }),
    pickedNoDefault: Type.Pick(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["enabled"] as const),
    omittedNoDefault: Type.Omit(Type.Object({ enabled: Type.Boolean(), name: Type.String() }), ["name"] as const),
    variant: Type.Union([Type.Literal("a"), Type.Literal("b")], { default: "a" }),
    labels: Type.Record(Type.String(), Type.String(), { default: {} }),
    finiteLabels: Type.Record(Type.Union([Type.Literal("foo"), Type.Literal("bar")]), Type.Number(), { default: { foo: 1, bar: 2 } }),
    tuple: Type.Tuple([Type.String(), Type.Number()], { default: ["x", 1] }),
    nothing: Type.Null({ default: null }),
  },
  outputs: {
    summary: Type.String(),
    maybe: Type.Optional(Type.String()),
  },
  run: async (ctx) => {
    const message: string = ctx.inputs.message;
    const mode: "fast" = ctx.inputs.mode;
    const size: "small" | "large" = ctx.inputs.size; const objectMode: "fast" | "slow" = ctx.inputs.objectMode;
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
    const extensionCustomFactory: Parameters<typeof extensionUiForTypes.custom<{ ok: boolean }>>[0] = (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done,
    ) => {
      const workflowTui: WorkflowCustomUiTui = tui;
      const workflowTheme: WorkflowCustomUiTheme = theme;
      const workflowKeybindings: WorkflowCustomUiKeybindings = keybindings;
      void workflowTui;
      void workflowTheme;
      void workflowKeybindings;
      done({ ok: true });
      return { render: () => [], invalidate: () => undefined } satisfies Component & { dispose?(): void };
    };
    const workflowCustomFactory: WorkflowCustomUiFactory<{ ok: boolean }> = extensionCustomFactory;
    const workflowCustomOptions: WorkflowCustomUiOptions = {
      label: "Typed custom",
      replayIdentity: "typing-fixture:v1",
      overlayOptions: (): WorkflowCustomUiOverlayOptions => ({
        width: "50%",
        visible: (termWidth: number, termHeight: number) => termWidth > 0 && termHeight > 0,
      } satisfies OverlayOptions),
      onHandle(handle: WorkflowCustomUiOverlayHandle) {
        const realHandle: OverlayHandle = handle;
        realHandle.unfocus({ target: null });
      },
    };
    const workflowComponent: WorkflowCustomUiComponent = { render: () => [], invalidate: () => undefined };
    void workflowComponent;
    const customResult = await ctx.ui.custom<{ ok: boolean }>(
      workflowCustomFactory,
      workflowCustomOptions,
    );
    const customOk: boolean = customResult.ok;
    void customOk;
    await ctx.task("echo", { prompt: message, output: "echo.md" });
    const chained = await ctx.chain([
      { name: "first", prompt: message },
      { name: "second", prompt: String(count) },
      { name: "third", prompt: mode },
      { name: "fourth", prompt: String(enabled) },
      { name: "fifth", prompt: size }, { name: "object-mode", prompt: objectMode },
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
  },
}); const summarySchema = authoredWorkflow.outputs.summary; void summarySchema;
const optionalOutputWorkflow = workflow({
  name: "Optional Output Fixture",
  description: "",
  inputs: {},
  outputs: {
    maybe: Type.Optional(Type.String()),
  },
  run: () => ({}),
});
const undeclaredOutputWorkflow = workflow({
  name: "Undeclared Output Fixture",
  description: "",
  outputs: {},
  // @ts-expect-error run must not return keys when outputs is empty.
  run: () => ({ summary: "not declared" }),
});
const nonSerializableOutputWorkflow = workflow({
  name: "Non Serializable Output Fixture",
  description: "",
  inputs: {},
  outputs: {
    n: Type.BigInt(),
  },
  run: () => ({ n: 1n } as never),
});
const postRunEditedWorkflow = workflow({
  name: "Post Run Edited Fixture",
  description: "Runtime supports metadata edits after run",
  inputs: {
    postRunInput: Type.String({ default: "ok" }),
  },
  outputs: {
    summary: Type.String(),
  },
  run: () => ({ summary: "ok" }),
});
const providedInputs = {
  message: "hello",
  mode: "fast" as const,
  size: "large" as const, objectMode: "slow" as const,
  count: 2,
  integerCount: 3,
  enabled: false,
  alias: "anon",
  tags: [],
  settings: { enabled: true },
  partialConfig: {},
  pickedConfig: { enabled: true },
  omittedConfig: { enabled: true },
  requiredConfig: { enabled: true },
  pickedNoDefault: { enabled: true },
  omittedNoDefault: { enabled: true },
  variant: "a" as const,
  labels: {},
  finiteLabels: { foo: 1, bar: 2 }, tuple: ["x", 1] as [string, number], nothing: null,
};
const minimalProvidedInputs = { message: "hello", pickedNoDefault: { enabled: true }, omittedNoDefault: { enabled: true } };
run(authoredWorkflow, minimalProvidedInputs); run(authoredWorkflow, providedInputs, { executionMode: "non_interactive" });
run(authoredWorkflow, providedInputs, { executionMode: "interactive" });
// @ts-expect-error detached is not a runtime executionMode literal.
run(authoredWorkflow, providedInputs, { executionMode: "detached" });
// @ts-expect-error message has no default and remains required.
run(authoredWorkflow, {});
// @ts-expect-error pickedNoDefault has no default and remains required.
run(authoredWorkflow, { message: "hello", omittedNoDefault: { enabled: true } });
run(optionalOutputWorkflow, {}); run(postRunEditedWorkflow, {});
run(goal, { objective: "x" }); run(goal, { objective: "x", create_pr: true });
run(goalDefault, { objective: "x", create_pr: false });
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
const typedRalphOutputs: RalphWorkflowOutputs = { approved: true, iterations_completed: 1, research_path: "research.md" };
const typedGoalRunInputs: GoalWorkflowRunInputs = { objective: "x", create_pr: true };
const typedRalphRunInputs: RalphWorkflowRunInputs = { prompt: "x", create_pr: true };
void typedGoalOutputs; void typedGoalRunInputs; void typedDesignOutputs; void typedDeepResearchOutputs; void typedRalphOutputs; void typedRalphRunInputs;
// @ts-expect-error builtin goal status is a declared literal union.
const invalidGoalOutputs: GoalWorkflowOutputs = { status: "done" };
// @ts-expect-error builtin open-claude-design only accepts runtime-declared output_type values.
run(openClaudeDesign, { prompt: "x", output_type: "flow" });
// @ts-expect-error builtin goal create_pr must be boolean.
run(goal, { objective: "x", create_pr: "true" });
// @ts-expect-error builtin ralph create_pr must be boolean.
run(ralph, { prompt: "x", create_pr: "true" });
// @ts-expect-error builtin goal requires an objective input.
run(goal, {});
// @ts-expect-error builtin goal default export requires an objective input.
run(goalDefault, {});
// @ts-expect-error WorkflowDefinition is non-structural; only workflow({...}) can produce it.
const forgedWorkflow: WorkflowDefinition = { __piWorkflow: true, name: "forged", normalizedName: "forged", description: "forged", inputs: {}, run: () => ({}) };
const forgedRunnable = { __piWorkflow: true, name: "forged", normalizedName: "forged", description: "forged", inputs: {}, run: () => ({}) } as const;
// @ts-expect-error run requires a branded workflow({...}) definition, not a structural object.
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
run(authoredWorkflow, providedInputs, { adapters, ui, signal: new AbortController().signal, config: runtimeConfig, models: catalog, mcp, persistence, cancellation: cancellationRegistry });
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
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);
});