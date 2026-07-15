import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import factory, {
  type ExtensionAPI,
  type PiCommandOptions,
  type PiExecuteContext,
  type PiToolOpts,
  type WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { killAllRuns } from "../../packages/workflows/src/runs/background/status.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";

const originalCwd = process.cwd();
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const roots: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
  else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  killAllRuns({ store, cancellation: cancellationRegistry });
  store.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  readonly commands: Map<string, PiCommandOptions>;
  readonly messages: string[];
  execute(args: WorkflowToolArgs, ctx?: PiExecuteContext): Promise<WorkflowToolResult>;
}

function fakeSession(prompt?: (text: string) => Promise<string>): StageSessionRuntime {
  let last: string | undefined;
  return {
    prompt: async (text: string) => {
      last = await (prompt ?? (async (value: string) => `declared:${value}`))(text);
      return last;
    },
    steer: async () => undefined,
    followUp: async () => undefined,
    subscribe: () => () => undefined,
    sessionFile: undefined,
    sessionId: "reload-matrix-stage",
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    cycleModel: async () => undefined,
    cycleThinkingLevel: () => undefined,
    agent: {} as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "medium",
    messages: [],
    isStreaming: false,
    navigateTree: async () => ({ cancelled: true }),
    compact: async () => undefined as never,
    abortCompaction: () => undefined,
    abort: async () => undefined,
    dispose: () => undefined,
    getLastAssistantText: () => last,
  };
}

function createHarness(overrides: Partial<ExtensionAPI> = {}): Harness {
  const commands = new Map<string, PiCommandOptions>();
  const messages: string[] = [];
  let tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
  const pi: ExtensionAPI = {
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: (options) => { tool = options as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>; },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    registerShortcut: () => undefined,
    sendMessage: (message) => { if (message.content !== undefined) messages.push(message.content); },
    on: () => undefined,
    ui: { setWidget: () => undefined },
    createAgentSession: async () => ({ session: fakeSession() }),
    disableAsyncDiscovery: true,
    ...overrides,
  };
  factory(pi);
  assert.ok(tool);
  return {
    commands,
    messages,
    async execute(args, ctx = { hasUI: false } as PiExecuteContext) {
      const result = await tool!.execute("reload-matrix-call", args, undefined, undefined, ctx);
      return result.details;
    },
  };
}

async function writeJson(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function writeWorkflow(
  path: string,
  options: { name: string; description: string; named?: boolean; prompt?: string },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const definition = `workflow({
  name: ${JSON.stringify(options.name)},
  description: ${JSON.stringify(options.description)},
  inputs: { message: Type.String() },
  outputs: { value: Type.String() },
  run: async (ctx) => ({ value: await ctx.stage("emit").prompt(${JSON.stringify(options.prompt ?? options.name)} + ":" + ctx.inputs.message) }),
})`;
  await writeFile(path, [
    `import { workflow } from "@bastani/workflows";`,
    `import { Type } from "typebox";`,
    options.named ? `export const namedWorkflow = ${definition};` : `export default ${definition};`,
  ].join("\n"), "utf8");
}

function names(result: WorkflowToolResult): string[] {
  assert.equal(result.action, "list");
  return result.items.map((item) => item.name);
}

function reloadResult(result: WorkflowToolResult): Extract<WorkflowToolResult, { action: "reload" }> {
  assert.equal(result.action, "reload");
  return result;
}

async function makeIsolatedRoots(label: string): Promise<{ root: string; project: string; agent: string }> {
  const root = await mkdtemp(join(tmpdir(), `atomic-${label}-`));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  const agent = join(home, ".atomic", "agent");
  await mkdir(project, { recursive: true });
  await mkdir(agent, { recursive: true });
  process.chdir(project);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ATOMIC_CODING_AGENT_DIR;
  return { root, project, agent };
}

describe("workflow reload rediscovery matrix", () => {
  test.serial("reload refreshes all discovery scopes and public list/get/inputs/help/completion/invocation surfaces", async () => {
    const { root, project, agent } = await makeIsolatedRoots("workflow-reload-matrix");
    const paths = {
      projectAtomic: join(project, ".atomic/workflows/project-atomic.ts"),
      projectLegacy: join(project, ".pi/workflows/project-legacy.ts"),
      globalAtomic: join(agent, "workflows/global-atomic.ts"),
      globalLegacy: join(root, "home/.pi/agent/workflows/global-legacy.ts"),
      projectRelative: join(project, "configured/project-relative.ts"),
      projectAbsoluteDir: join(root, "project-absolute-dir/project-absolute.ts"),
      globalRelative: join(agent, "configured/global-relative.ts"),
      globalAbsolute: join(root, "global-absolute.ts"),
      globalRelativeDir: join(agent, "configured/global-dir/global-dir.ts"),
      projectConflict: join(project, ".atomic/workflows/conflict.ts"),
      globalConflict: join(agent, "workflows/conflict.ts"),
    };
    await Promise.all([
      writeWorkflow(paths.projectAtomic, { name: "scope-project-atomic", description: "project atomic" }),
      writeWorkflow(paths.projectLegacy, { name: "scope-project-legacy", description: "project legacy", named: true }),
      writeWorkflow(paths.globalAtomic, { name: "scope-global-atomic", description: "global atomic" }),
      writeWorkflow(paths.globalLegacy, { name: "scope-global-legacy", description: "global legacy", named: true }),
      writeWorkflow(paths.projectRelative, { name: "scope-project-relative", description: "project relative" }),
      writeWorkflow(paths.projectAbsoluteDir, { name: "scope-project-absolute", description: "project absolute", named: true }),
      writeWorkflow(paths.globalRelative, { name: "scope-global-relative", description: "global relative" }),
      writeWorkflow(paths.globalAbsolute, { name: "scope-global-absolute", description: "global absolute", named: true }),
      writeWorkflow(paths.globalRelativeDir, { name: "scope-global-relative-dir", description: "global relative directory" }),
      writeWorkflow(paths.projectConflict, { name: "scope-conflict", description: "project conflict wins" }),
      writeWorkflow(paths.globalConflict, { name: "scope-conflict", description: "global conflict loses" }),
    ]);
    await writeJson(join(project, ".atomic/extensions/workflow/config.json"), {
      workflows: {
        projectRelative: { path: "configured/project-relative.ts" },
        projectAbsoluteDir: { path: dirname(paths.projectAbsoluteDir) },
      },
    });
    await writeJson(join(agent, "extensions/workflow/config.json"), {
      workflows: {
        globalRelative: { path: "configured/global-relative.ts" },
        globalAbsolute: { path: paths.globalAbsolute },
        globalRelativeDir: { path: "configured/global-dir" },
      },
    });

    const harness = createHarness();
    const reload = reloadResult(await harness.execute({ action: "reload" }));
    assert.equal(reload.status, "ok");
    assert.equal(reload.outcome, "applied");
    assert.ok(reload.diagnostics.some((diagnostic) => diagnostic.code === "DUPLICATE_NAME"));
    const listed = names(await harness.execute({ action: "list" }));
    for (const expected of [
      "scope-project-atomic", "scope-project-legacy", "scope-global-atomic", "scope-global-legacy",
      "scope-project-relative", "scope-project-absolute", "scope-global-relative", "scope-global-absolute",
      "scope-global-relative-dir", "scope-conflict",
    ]) assert.ok(listed.includes(expected), expected);

    const get = await harness.execute({ action: "get", workflow: "scope-project-atomic" });
    assert.equal(get.action, "get");
    assert.equal(get.details?.output?.description, "project atomic");
    const conflict = await harness.execute({ action: "get", workflow: "scope-conflict" });
    assert.equal(conflict.action, "get");
    assert.equal(conflict.details?.output?.description, "project conflict wins");
    const inputs = await harness.execute({ action: "inputs", workflow: "scope-project-atomic" });
    assert.equal(inputs.action, "inputs");
    assert.deepEqual(inputs.inputs.map((input) => input.name), ["message"]);
    const workflowCommand = harness.commands.get("workflow");
    assert.ok(workflowCommand?.getArgumentCompletions);
    const completions = await workflowCommand.getArgumentCompletions("scope-project-at");
    assert.ok(completions?.some((item) => item.label === "scope-project-atomic"));
    const messageStart = harness.messages.length;
    await workflowCommand.handler?.("scope-project-atomic --help", { hasUI: false, ui: { notify: () => undefined } });
    assert.match(harness.messages.slice(messageStart).join("\n"), /message/);

    const run = await harness.execute({ action: "run", workflow: "scope-project-atomic", inputs: { message: "hello" } });
    assert.equal(run.action, "run");
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.deepEqual(run.result, { value: "declared:scope-project-atomic:hello" });
  });

  test.serial("add edit rename delete and malformed siblings replace metadata while preserving valid workflows", async () => {
    const { project } = await makeIsolatedRoots("workflow-reload-mutations");
    const dir = join(project, ".atomic/workflows");
    const stable = join(dir, "stable.ts");
    const changing = join(dir, "changing.ts");
    await writeWorkflow(stable, { name: "reload-stable", description: "stable" });
    const harness = createHarness();
    await harness.execute({ action: "reload" });

    await writeWorkflow(changing, { name: "reload-changing", description: "version one" });
    await writeFile(join(dir, "invalid.ts"), "export default { broken: true };", "utf8");
    const added = reloadResult(await harness.execute({ action: "reload" }));
    assert.equal(added.status, "ok");
    assert.ok(added.diagnostics.some((diagnostic) => diagnostic.code === "INVALID_DEFINITION"));
    assert.ok(names(await harness.execute({ action: "list" })).includes("reload-stable"));
    const slashMessageStart = harness.messages.length;
    await harness.commands.get("workflow")?.handler?.("reload", { hasUI: false, ui: { notify: () => undefined } });
    assert.match(harness.messages.slice(slashMessageStart).join("\n"), /INVALID_DEFINITION/);

    await writeWorkflow(changing, { name: "reload-edited", description: "version two", named: true });
    const edited = reloadResult(await harness.execute({ action: "reload" }));
    assert.equal(edited.status, "ok");
    const editedGet = await harness.execute({ action: "get", workflow: "reload-edited" });
    assert.equal(editedGet.action, "get");
    assert.equal(editedGet.details?.output?.description, "version two");
    assert.ok(!names(await harness.execute({ action: "list" })).includes("reload-changing"));

    const renamedPath = join(dir, "renamed.ts");
    await rename(changing, renamedPath);
    await writeWorkflow(renamedPath, { name: "reload-renamed", description: "renamed" });
    await harness.execute({ action: "reload" });
    assert.ok(names(await harness.execute({ action: "list" })).includes("reload-renamed"));
    await unlink(renamedPath);
    await harness.execute({ action: "reload" });
    const finalNames = names(await harness.execute({ action: "list" }));
    assert.ok(!finalNames.includes("reload-renamed"));
    assert.ok(finalNames.includes("reload-stable"));
  });

  test.serial("fatal refresh failure retains the complete previously applied registry", async () => {
    const { project } = await makeIsolatedRoots("workflow-reload-failure");
    const workflowPath = join(project, ".atomic/workflows/retained.ts");
    await writeWorkflow(workflowPath, { name: "reload-retained", description: "before failure" });
    let failRefresh = false;
    const harness = createHarness({
      refreshWorkflowResources: async () => {
        if (failRefresh) throw new Error("deterministic refresh failure");
        return [];
      },
    });
    const applied = reloadResult(await harness.execute({ action: "reload" }));
    await writeWorkflow(workflowPath, { name: "reload-retained", description: "must not publish" });
    failRefresh = true;
    const failed = reloadResult(await harness.execute({ action: "reload" }));
    assert.equal(failed.status, "noop");
    assert.equal(failed.outcome, "failed");
    assert.match(failed.message, /deterministic refresh failure/);
    assert.equal(failed.generation, applied.generation);
    assert.equal(failed.workflowCount, applied.workflowCount);
    assert.equal(failed.error, "deterministic refresh failure");
    const retained = await harness.execute({ action: "get", workflow: "reload-retained" });
    assert.equal(retained.action, "get");
    assert.equal(retained.details?.output?.description, "before failure");
  });

  test.serial("reload during an in-flight workflow publishes new metadata without changing the running definition", async () => {
    const { project } = await makeIsolatedRoots("workflow-reload-inflight");
    const workflowPath = join(project, ".atomic/workflows/inflight.ts");
    await writeWorkflow(workflowPath, { name: "reload-inflight", description: "old metadata", prompt: "old prompt" });
    let releasePrompt: (value: string) => void = () => undefined;
    let markPromptStarted: () => void = () => undefined;
    const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
    const promptResult = new Promise<string>((resolve) => { releasePrompt = resolve; });
    const harness = createHarness({
      createAgentSession: async () => ({
        session: fakeSession(async () => {
          markPromptStarted();
          return promptResult;
        }),
      }),
    });
    await harness.execute({ action: "reload" });
    const running = harness.execute({ action: "run", workflow: "reload-inflight", inputs: { message: "value" } });
    await promptStarted;
    await writeWorkflow(workflowPath, { name: "reload-inflight", description: "new metadata", prompt: "new prompt" });
    const reloaded = reloadResult(await harness.execute({ action: "reload" }));
    assert.equal(reloaded.status, "ok");
    const current = await harness.execute({ action: "get", workflow: "reload-inflight" });
    assert.equal(current.action, "get");
    assert.equal(current.details?.output?.description, "new metadata");
    releasePrompt("held:old prompt:value");
    const completed = await running;
    assert.equal(completed.action, "run");
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.deepEqual(completed.result, { value: "held:old prompt:value" });
  });

  test.serial("overlapping reload requests serialize and coalesce one trailing generation", async () => {
    await makeIsolatedRoots("workflow-reload-coalesce");
    const gates: Array<() => void> = [];
    const starts: Array<() => void> = [];
    let refreshCalls = 0;
    const started = (index: number): Promise<void> => new Promise((resolve) => { starts[index] = resolve; });
    const start0 = started(0);
    const start1 = started(1);
    const harness = createHarness({
      refreshWorkflowResources: async () => {
        const index = refreshCalls++;
        starts[index]?.();
        await new Promise<void>((resolve) => { gates[index] = resolve; });
        return [];
      },
    });

    const first = harness.execute({ action: "reload" });
    await start0;
    const trailingA = harness.execute({ action: "reload" });
    const trailingB = harness.execute({ action: "reload" });
    assert.equal(refreshCalls, 1);
    gates[0]?.();
    await start1;
    assert.equal(refreshCalls, 2);
    gates[1]?.();
    const [firstResult, secondResult, thirdResult] = await Promise.all([first, trailingA, trailingB]);
    assert.equal(reloadResult(firstResult).coalescedRequests, 1);
    assert.equal(reloadResult(secondResult).coalescedRequests, 2);
    assert.equal(reloadResult(thirdResult).generation, reloadResult(secondResult).generation);
  });

  test.serial("queued old-session requests cannot coalesce with or publish into a new session", async () => {
    await makeIsolatedRoots("workflow-reload-session-boundary");
    const gates: Array<() => void> = [];
    const starts: Array<() => void> = [];
    let refreshCalls = 0;
    const firstStarted = new Promise<void>((resolve) => { starts[0] = resolve; });
    const freshStarted = new Promise<void>((resolve) => { starts[1] = resolve; });
    const pi = {
      refreshWorkflowResources: async () => {
        const index = refreshCalls++;
        starts[index]?.();
        await new Promise<void>((resolve) => { gates[index] = resolve; });
        return [];
      },
    } as ExtensionAPI;
    const state = createWorkflowExtensionRuntimeState(pi, {} as never);

    const activeOld = state.reloadWorkflowResources();
    await firstStarted;
    const queuedOld = state.reloadWorkflowResources();
    state.resetWorkflowDiscoveryForSession();
    const fresh = state.reloadWorkflowResources();
    gates[0]?.();
    await freshStarted;
    assert.equal(refreshCalls, 2, "stale queued generation must be rejected before refresh");
    gates[1]?.();

    const [activeReport, queuedReport, freshReport] = await Promise.all([activeOld, queuedOld, fresh]);
    assert.equal(activeReport.outcome, "superseded");
    assert.equal(queuedReport.outcome, "superseded");
    assert.equal(freshReport.outcome, "applied");
    assert.ok(freshReport.generation > activeReport.generation);
  });
});
