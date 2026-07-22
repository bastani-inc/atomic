import { afterAll, afterEach, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  PiToolOpts,
  WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import {
  buildMockPi,
  factory,
  singletonStore,
  type CapturedCustomCall,
} from "./overlay-entrypoints-helpers.js";

type ExtensionEventHandler = Parameters<NonNullable<ExtensionAPI["on"]>>[1];
type RegisteredWorkflowTool = PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;

let fixtureDirectory: string;
let fixturePath: string;
const capturedCallGroups: CapturedCustomCall[][] = [];

async function createFactoryHost() {
  const events = new Map<string, ExtensionEventHandler[]>();
  let registeredTool: RegisteredWorkflowTool | undefined;
  const mock = buildMockPi();
  capturedCallGroups.push(mock.customCalls);

  mock.pi.disableAsyncDiscovery = false;
  mock.pi.getWorkflowResources = () => [{ path: fixturePath, enabled: true }];
  mock.pi.on = (event, handler) => {
    const handlers = events.get(event) ?? [];
    handlers.push(handler);
    events.set(event, handlers);
  };
  mock.pi.registerTool = (options) => {
    registeredTool = options as unknown as RegisteredWorkflowTool;
  };

  factory(mock.pi);
  for (const startHandler of events.get("session_start") ?? []) {
    await startHandler({}, { ui: { notify: () => undefined } });
  }

  assert.ok(registeredTool, "expected workflow tool registration");
  const workflowCommand = mock.commands["workflow"];
  assert.ok(workflowCommand, "expected /workflow command registration");

  return { ...mock, tool: registeredTool, workflowCommand };
}

async function executeWorkflow(
  tool: RegisteredWorkflowTool,
  workflow: "attach-enabled" | "attach-default",
  hasUI: boolean,
) {
  const response = await tool.execute(
    "workflow-auto-attach-test",
    { action: "run", workflow, inputs: {} },
    undefined,
    undefined,
    { hasUI } as never,
  );
  return response.details;
}

function overlayMounts(calls: CapturedCustomCall[]) {
  return calls.filter((call) => call.options.overlay === true);
}

async function settleDetachedJobs() {
  await Promise.all(
    jobTracker.runIds().map((runId) => jobTracker.get(runId)?.promise),
  );
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "atomic-workflow-auto-attach-"));
  fixturePath = join(fixtureDirectory, "auto-attach-workflows.ts");
  await writeFile(
    fixturePath,
    `import { workflow } from "@bastani/workflows";

export const attachEnabled = workflow({
  name: "attach-enabled",
  autoAttach: true,
  description: "",
  inputs: {},
  outputs: {},
  run: (ctx) => ctx.exit(),
});

export const attachDefault = workflow({
  name: "attach-default",
  description: "",
  inputs: {},
  outputs: {},
  run: (ctx) => ctx.exit(),
});
`,
    "utf8",
  );
});

afterEach(async () => {
  await settleDetachedJobs();
  for (const calls of capturedCallGroups) {
    for (const call of calls) call.component.dispose?.();
  }
  capturedCallGroups.length = 0;
  singletonStore.clear();
});

afterAll(async () => {
  await settleDetachedJobs();
  singletonStore.clear();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("workflow auto-attach host entrypoints", () => {
  test.serial("/workflow opens one graph through extension pi.ui.custom when autoAttach is enabled", async () => {
    const host = await createFactoryHost();

    await host.workflowCommand.options.handler("attach-enabled", {
      ui: { notify: () => undefined },
    });

    assert.equal(host.customCalls.length, 1);
    assert.equal(overlayMounts(host.customCalls).length, 1);
  });

  test.serial("/workflow remains detached when autoAttach is omitted", async () => {
    const host = await createFactoryHost();

    await host.workflowCommand.options.handler("attach-default", {
      ui: { notify: () => undefined },
    });

    assert.equal(host.customCalls.length, 0);
  });

  test.serial("interactive registered tool returns the running result after mounting one graph", async () => {
    const host = await createFactoryHost();

    const result = await executeWorkflow(host.tool, "attach-enabled", true);

    assert.equal(result.action, "run");
    assert.equal(result.status, "running");
    assert.equal(result.name, "attach-enabled");
    assert.ok(result.runId.length > 0);
    assert.equal(host.customCalls.length, 1);
    assert.equal(overlayMounts(host.customCalls).length, 1);
  });

  test.serial("interactive registered tool remains detached when autoAttach is omitted", async () => {
    const host = await createFactoryHost();

    await executeWorkflow(host.tool, "attach-default", true);

    assert.equal(host.customCalls.length, 0);
  });

  test.serial("headless registered tool remains detached when autoAttach is enabled", async () => {
    const host = await createFactoryHost();

    await executeWorkflow(host.tool, "attach-enabled", false);

    assert.equal(host.customCalls.length, 0);
  });
});
