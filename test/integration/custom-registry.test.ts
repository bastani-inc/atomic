import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import type { DiscoveryResult } from "../../packages/workflows/src/extension/discovery.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import factory, {
	type ExtensionAPI,
	type PiCommandOptions,
	type PiToolOpts,
	type WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { store as defaultStore } from "../../packages/workflows/src/shared/store.ts";
import { waitForRun } from "../support/helpers.ts";

// ---------------------------------------------------------------------------
// Temp-dir fixture: one project-local workflow, one user-global workflow
// ---------------------------------------------------------------------------

const CUSTOM_WF_NORM = "custom-integration-workflow";
const CUSTOM_WF_NAME = "Custom Integration Workflow";
const BUILTIN_WORKFLOW_NAMES = [
	"adversarial-verification",
	"classify-and-act",
	"fan-out-and-synthesize",
	"generate-and-filter",
	"goal",
	"loop-until-done",
	"open-claude-design",
	"ralph",
	"tournament",
] as const;

const USER_WF_NORM = "user-global-integration-workflow";
const USER_WF_NAME = "User Global Integration Workflow";

/** Minimal valid WorkflowDefinition as a .js source string. */
function makeWorkflowSource(normalizedName: string, name: string): string {
	return `
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
const definition = workflow({
  name: ${JSON.stringify(name)},
  description: "Integration test custom workflow",
  inputs: {
    message: Type.String({ description: "Test message" }),
    count: Type.Number({ default: 1 }),
  },
  outputs: {},
  run: async (ctx) => {
    await ctx.task("validation-smoke", { prompt: "validation smoke" });
    return {};
  },
});
if (definition.normalizedName !== ${JSON.stringify(normalizedName)}) throw new Error("unexpected normalized name");
export default definition;
`.trim();
}

let tempRoot: string;
let cwdWorkflowDir: string;
let homeWorkflowDir: string;

// Shared fixtures (expensive — set up once per suite)
let discoveryResult: DiscoveryResult;
let runtime: ExtensionRuntime;

beforeAll(async () => {
	// Create isolated temp dirs
	tempRoot = join(tmpdir(), `pi-wf-int-${randomUUID()}`);
	cwdWorkflowDir = join(tempRoot, "cwd", ".atomic", "workflows");
	homeWorkflowDir = join(tempRoot, "home", ".atomic", "agent", "workflows");

	mkdirSync(cwdWorkflowDir, { recursive: true });
	mkdirSync(homeWorkflowDir, { recursive: true });

	writeFileSync(join(cwdWorkflowDir, `${CUSTOM_WF_NORM}.js`), makeWorkflowSource(CUSTOM_WF_NORM, CUSTOM_WF_NAME));

	writeFileSync(join(homeWorkflowDir, `${USER_WF_NORM}.js`), makeWorkflowSource(USER_WF_NORM, USER_WF_NAME));

	// Run full discovery with both custom dirs + bundled
	discoveryResult = await discoverWorkflows({
		cwd: join(tempRoot, "cwd"),
		homeDir: join(tempRoot, "home"),
		includeBundled: true,
	});
});

// The runtime captures the store's durable backend when it is created. The shared setup file injects the isolated
// in-memory backend in its own `beforeEach`, which runs after `beforeAll`; a runtime built in `beforeAll` therefore
// misses it and opens the real `~/.atomic/workflows/journal.sqlite`, which every parallel test worker shares.
beforeEach(() => {
	runtime = createExtensionRuntime({ registry: discoveryResult.registry });
});

afterAll(() => {
	try {
		rmSync(tempRoot, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

// ---------------------------------------------------------------------------
// 1. discoverWorkflows — custom sources present in result
// ---------------------------------------------------------------------------

describe("discoverWorkflows — custom sources from temp cwd/home", () => {
	test("result.registry includes project-local custom workflow name", () => {
		assert.ok(discoveryResult.registry.names().includes(CUSTOM_WF_NORM));
	});

	test("result.registry includes user-global custom workflow name", () => {
		assert.ok(discoveryResult.registry.names().includes(USER_WF_NORM));
	});

	test("result.registry includes the exact bundled workflow set alongside custom", () => {
		const bundledNames = discoveryResult.sources
			.filter((source) => source.kind === "bundled")
			.map((source) => source.id)
			.sort();
		assert.deepEqual(bundledNames, [...BUILTIN_WORKFLOW_NAMES].sort());
	});

	test("result.sources contains a 'project-local' entry for custom workflow", () => {
		const src = discoveryResult.sources.find((s) => s.id === CUSTOM_WF_NORM);
		assert.notEqual(src, undefined);
		assert.equal(src!.kind, "project-local");
		assert.equal(src!.name, CUSTOM_WF_NAME);
		assert.ok(src!.filePath!.includes(CUSTOM_WF_NORM));
	});

	test("result.sources contains a 'user-global' entry for user-global workflow", () => {
		const src = discoveryResult.sources.find((s) => s.id === USER_WF_NORM);
		assert.notEqual(src, undefined);
		assert.equal(src!.kind, "user-global");
		assert.equal(src!.name, USER_WF_NAME);
	});

	test("no discovery errors for valid custom workflows", () => {
		const hardErrors = discoveryResult.errors.filter(
			(e) => e.level === "error" && (e.source?.includes(CUSTOM_WF_NORM) || e.source?.includes(USER_WF_NORM)),
		);
		assert.equal(hardErrors.length, 0);
	});
});

// ---------------------------------------------------------------------------
// 2. ExtensionRuntime — tool dispatch sees custom + bundled registry
// ---------------------------------------------------------------------------

describe("ExtensionRuntime with custom registry — tool dispatch", () => {
	test("action='list' returns custom workflow name", async () => {
		const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
		assert.equal(result.action, "list");
		const r = result as { action: "list"; items: { name: string }[] };
		assert.ok(r.items.some((i) => i.name === CUSTOM_WF_NORM));
	});

	test("action='list' returns user-global workflow name", async () => {
		const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
		const r = result as { action: "list"; items: { name: string }[] };
		assert.ok(r.items.some((i) => i.name === USER_WF_NORM));
	});

	test("action='list' includes every bundled workflow alongside custom", async () => {
		const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
		const r = result as { action: "list"; items: { name: string }[] };
		const names = r.items.map((item) => item.name);
		for (const name of BUILTIN_WORKFLOW_NAMES) assert.ok(names.includes(name));
	});

	test("action='inputs' for custom workflow returns declared inputs", async () => {
		const result = await runtime.dispatch({ workflow: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
		assert.equal(result.action, "inputs");
		const r = result as { action: "inputs"; name: string; inputs: Array<{ name: string }> };
		assert.equal(r.name, CUSTOM_WF_NORM);
		assert.notEqual(r.inputs, undefined);
		const names = r.inputs.map((i) => i.name);
		assert.ok(names.includes("message"));
		assert.ok(names.includes("count"));
	});

	test("action='inputs' for custom workflow has no error field", async () => {
		const result = await runtime.dispatch({ workflow: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
		const r = result as { action: "inputs"; error?: string };
		assert.equal(r.error, undefined);
	});

	test("action='run' for custom workflow dispatches (returns run result, not unknown-action)", async () => {
		const result = await runtime.dispatch({
			workflow: CUSTOM_WF_NORM,
			inputs: { message: "hello" },
			action: "run",
		});
		assert.equal(result.action, "run");
		const r = result as { action: "run"; runId: string; status: string };
		// runId must be a non-empty string and the synchronous status is "running".
		assert.equal(typeof r.runId, "string");
		assert.ok(r.runId.length > 0);
		assert.equal(r.status, "running");
		// After the background promise settles, the store carries the terminal status.
		await waitForRun(r.runId, { store: defaultStore });
		const settled = defaultStore.runs().find((run) => run.id === r.runId);
		assert.notEqual(settled, undefined);
		assert.ok(["completed", "failed"].includes(settled!.status));
	});

	test("shared registry: list from tool equals registry.names()", async () => {
		const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
		const r = result as { action: "list"; items: { name: string }[] };
		const toolNames = r.items.map((i) => i.name);
		const registryNames = discoveryResult.registry.names();
		// Every name in the registry is in the tool list and vice versa
		for (const name of registryNames) {
			assert.ok(toolNames.includes(name));
		}
		for (const name of toolNames) {
			assert.ok(registryNames.includes(name));
		}
	});
});

interface MockCmd {
	name: string;
	options: PiCommandOptions;
}

interface MockTool {
	opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
}

interface SentMessage {
	customType?: string;
	content?: string;
	display?: boolean;
	details?: unknown;
}

function makeMockApiForRuntime(): ExtensionAPI & {
	commands: MockCmd[];
	tools: MockTool[];
	sent: SentMessage[];
} {
	const commands: MockCmd[] = [];
	const tools: MockTool[] = [];
	const sent: SentMessage[] = [];

	return {
		commands,
		tools,
		sent,
		registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
			tools.push({ opts: opts as unknown as MockTool["opts"] });
		},
		registerCommand(name: string, options: PiCommandOptions) {
			commands.push({ name, options });
		},
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		sendMessage(msg: SentMessage) {
			sent.push(msg);
		},
	} as ExtensionAPI & {
		commands: MockCmd[];
		tools: MockTool[];
		sent: SentMessage[];
	};
}

function getCommand(commands: MockCmd[], name: string): MockCmd | undefined {
	return commands.find((c) => c.name === name);
}

describe("registered workflow tool and /workflows command — bundled-and-custom shared registry", () => {
	let mock: ReturnType<typeof makeMockApiForRuntime>;

	beforeEach(() => {
		defaultStore.clear();
		mock = makeMockApiForRuntime();
		factory(mock);
	});

	test("registered tool action='list' and startup registry produce same bundled workflow names (#5224)", async () => {
		const toolExecute = mock.tools[0]!.opts.execute;
		const toolOut = await toolExecute(
			"test-tool-call",
			{ inputs: {}, action: "list" },
			undefined,
			undefined,
			{} as never,
		);
		const toolItems = (toolOut.details as { action: "list"; items: { name: string }[] }).items;
		const toolWorkflows = toolItems.map((i) => i.name);

		assert.equal(getCommand(mock.commands, "workflow"), undefined);
		assert.notEqual(getCommand(mock.commands, "workflows"), undefined);

		for (const name of BUILTIN_WORKFLOW_NAMES) {
			assert.ok(toolWorkflows.includes(name));
		}
	});

	test("registered tool action='list' and action='inputs' agree on the count of bundled workflows (#5224)", async () => {
		const toolExecute = mock.tools[0]!.opts.execute;
		const toolOut = await toolExecute(
			"test-tool-call",
			{ inputs: {}, action: "list" },
			undefined,
			undefined,
			{} as never,
		);
		const toolWorkflows = (toolOut.details as { action: "list"; items: { name: string }[] }).items.map((i) => i.name);

		for (const name of toolWorkflows) {
			const inputsOut = await toolExecute(
				`inputs-${name}`,
				{ workflow: name, inputs: {}, action: "inputs" },
				undefined,
				undefined,
				{} as never,
			);
			const details = inputsOut.details as { action: "inputs"; name: string; error?: string };
			assert.equal(details.action, "inputs");
			assert.equal(details.name, name);
			assert.equal(details.error, undefined);
		}
	});

	test("/workflows completions list active session runs from the shared store (#5224)", async () => {
		const toolExecute = mock.tools[0]!.opts.execute;
		const runOut = await toolExecute(
			"test-tool-run-completion",
			{ workflow: "loop-until-done", inputs: { prompt: "test", max_iterations: 1 }, action: "run" },
			undefined,
			undefined,
			{} as never,
		);
		const runDetails = runOut.details as { action: "run"; runId: string };
		const cmd = getCommand(mock.commands, "workflows")!;
		const completions = (await cmd.options.getArgumentCompletions?.("")) ?? [];
		const labels = completions.map((c) => c.label);

		assert.ok(labels.includes(runDetails.runId));
		for (const name of BUILTIN_WORKFLOW_NAMES) {
			assert.equal(labels.includes(name), false);
		}
		await waitForRun(runDetails.runId, { store: defaultStore });
	});
});

describe("registered workflow tool dispatch and /workflows — no per-workflow aliases", () => {
	let mock: ReturnType<typeof makeMockApiForRuntime>;

	beforeEach(() => {
		defaultStore.clear();
		mock = makeMockApiForRuntime();
		factory(mock);
	});

	test("per-workflow aliases are not registered", () => {
		assert.equal(getCommand(mock.commands, "workflow"), undefined);
		const alias = getCommand(mock.commands, "workflow:open-claude-design");
		assert.equal(alias, undefined);
	});

	test("registered workflow tool fan-out-and-synthesize execute produces run output (#5224)", async () => {
		const toolExecute = mock.tools[0]!.opts.execute;
		const toolOut = await toolExecute(
			"test-tool-fan-out",
			{ workflow: "fan-out-and-synthesize", inputs: { prompt: "test", max_branches: 1 }, action: "run" },
			undefined,
			undefined,
			{} as never,
		);
		const details = toolOut.details as { action: "run"; runId: string; status: string };
		assert.equal(details.action, "run");
		assert.ok(details.runId.length > 0);
		await waitForRun(details.runId, { store: defaultStore });
		const settled = defaultStore.runs().find((run) => run.id === details.runId);
		assert.notEqual(settled, undefined);
		assert.ok(["completed", "failed"].includes(settled!.status));
	});

	test("registered workflow tool dispatch and /workflows reach same shared store (#5224)", async () => {
		const toolExecute = mock.tools[0]!.opts.execute;
		const toolOut = await toolExecute(
			"test-tool-call",
			{ workflow: "loop-until-done", inputs: { prompt: "test", max_iterations: 1 }, action: "run" },
			undefined,
			undefined,
			{} as never,
		);
		assert.equal(toolOut.details.action, "run");
		const runId = (toolOut.details as { action: "run"; runId: string }).runId;

		const cmd = getCommand(mock.commands, "workflows");
		const messages: string[] = [];
		await cmd!.options.handler(runId, {
			ui: { notify: (m: string) => messages.push(m) },
		});
		assert.equal(
			messages.some((m) => m.includes("Run not found")),
			false,
		);
		await waitForRun(runId, { store: defaultStore });
	});

	test("no bundled workflow aliases are registered", () => {
		const allAliases = mock.commands
			.filter((c) => c.name.startsWith("workflow:"))
			.map((c) => c.name.slice("workflow:".length));

		assert.deepEqual(allAliases, []);
	});
});

// ---------------------------------------------------------------------------
// 6. Shared registry invariant — end-to-end across extension consumers
// ---------------------------------------------------------------------------

describe("shared registry invariant — extension consumers see same workflows", () => {
	test("custom workflow visible to tool but NOT in startup bundled registry", async () => {
		// startup bundled discovery (no temp dirs)
		const { discoverStartupWorkflowsSync } = await import("../../packages/workflows/src/extension/discovery.js");
		const bundledResult = discoverStartupWorkflowsSync();
		assert.ok(!bundledResult.registry.names().includes(CUSTOM_WF_NORM));

		// Custom-inclusive runtime includes it
		const toolResult = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
		const toolNames = (toolResult as { action: "list"; items: { name: string }[] }).items.map((i) => i.name);
		assert.ok(toolNames.includes(CUSTOM_WF_NORM));
	});

	test("custom workflow inputs schema is available through tool dispatch", async () => {
		const inputsResult = await runtime.dispatch({ workflow: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
		const r = inputsResult as { action: "inputs"; inputs: Array<{ name: string; type: string }> };
		const inputsByName = Object.fromEntries(r.inputs.map((i) => [i.name, i]));

		assert.notEqual(inputsByName.message, undefined);
		// TString normalizes to the "text" descriptor kind via schema-introspection.
		assert.equal(inputsByName.message!.type, "text");
		assert.notEqual(inputsByName.count, undefined);
		assert.equal(inputsByName.count!.type, "number");
	});
});
