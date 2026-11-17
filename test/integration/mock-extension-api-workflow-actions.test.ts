import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import type {
	ExtensionAPI,
	PiCommandOptions,
	PiFlagNamedOpts,
	PiMessageRendererResult,
	PiToolOpts,
} from "./mock-extension-api-helpers.js";
import { defaultStore, factory, getCommand, makeMock, runTool, waitForRun } from "./mock-extension-api-helpers.js";

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

describe("MockExtensionAPI — tool list returns bundled workflow names", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		mock = makeMock();
		factory(mock);
	});

	test("action='list' returns the exact bundled workflow names", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { inputs: {}, action: "list" });
		assert.equal(result.action, "list");
		const r = result as { action: "list"; items: { name: string }[] };
		assert.deepEqual(r.items.map((item) => item.name).sort(), [...BUILTIN_WORKFLOW_NAMES].sort());
	});
});

describe("MockExtensionAPI — tool inputs returns schema for fan-out-and-synthesize", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		mock = makeMock();
		factory(mock);
	});

	test("action='inputs' returns prompt and bounded fan-out fields", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { workflow: "fan-out-and-synthesize", inputs: {}, action: "inputs" });
		assert.equal(result.action, "inputs");
		const r = result as {
			action: "inputs";
			name: string;
			inputs: Array<{ name: string; type: string; required?: boolean; default?: unknown }>;
		};
		assert.equal(r.name, "fan-out-and-synthesize");
		const byName = Object.fromEntries(r.inputs.map((input) => [input.name, input]));
		assert.equal(byName.prompt?.type, "text");
		assert.equal(byName.prompt?.required, true);
		assert.equal(byName.max_branches?.type, "integer");
		assert.equal(byName.max_branches?.default, 4);
		assert.equal(byName.max_concurrency?.default, 4);
	});

	test("action='inputs' has no error field", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { workflow: "fan-out-and-synthesize", inputs: {}, action: "inputs" });
		const r = result as { action: "inputs"; error?: string };
		assert.equal(r.error, undefined);
	});
});

describe("MockExtensionAPI — tool run returns non-placeholder runId and terminal status", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		mock = makeMock();
		factory(mock);
	});

	test("action='run' for fan-out-and-synthesize returns a non-placeholder runId", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const ctx = {};
		// Background dispatch returns `status: "running"` synchronously with a real UUID.
		const result = await runTool(
			execute,
			{
				workflow: "fan-out-and-synthesize",
				inputs: { prompt: "test query", max_branches: 1 },
				action: "run",
			},
			ctx,
		);
		assert.equal(result.action, "run");
		const r = result as {
			action: "run";
			runId: string;
			status: string;
			stages: unknown[];
			error?: string;
		};
		// runId must be a non-empty non-placeholder value (real UUID).
		assert.equal(typeof r.runId, "string");
		assert.ok(r.runId.length > 0);
		assert.notEqual(r.runId, "");
		// Synchronous status from background dispatch is "running".
		assert.equal(r.status, "running");
		// stages is an empty array at dispatch time; the live snapshot lives on the store.
		assert.equal(Array.isArray(r.stages), true);

		// After the background promise settles, the store records a terminal status.
		await waitForRun(r.runId, { store: defaultStore });
		const settled = defaultStore.runs().find((run) => run.id === r.runId);
		assert.notEqual(settled, undefined);
		assert.ok(["completed", "failed"].includes(settled!.status));
	}, 15_000);

	test("action='run' without adapters reports honest failure, not a stub", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const ctx = {};
		const result = await runTool(
			execute,
			{
				workflow: "fan-out-and-synthesize",
				inputs: { prompt: "test", max_branches: 1 },
				action: "run",
			},
			ctx,
		);
		const r = result as {
			action: "run";
			runId: string;
			status: string;
			stages: unknown[];
			error?: string;
		};
		// runId is minted synchronously by the background dispatch.
		assert.notEqual(r.runId, "");
		// The final terminal state lives on the store after the background promise settles.
		await waitForRun(r.runId, { store: defaultStore });
		const settled = defaultStore.runs().find((run) => run.id === r.runId);
		assert.notEqual(settled, undefined);
		// When no adapters and complete adapter is missing, the workflow should fail honestly.
		// A "failed" run must carry an error message (not placeholder text like "not yet implemented").
		if (settled!.status === "failed") {
			assert.notEqual(settled!.error, undefined);
			assert.ok(!settled!.error!.includes("not yet implemented"));
			assert.ok(!settled!.error!.includes("Phase B stub"));
		}
	});

	test("action='run' rejects an unknown workflow name without admission", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const runsBefore = defaultStore.runs().map((run) => run.id);
		const result = await runTool(
			execute,
			{
				workflow: "nonexistent-workflow-xyz",
				inputs: {},
				action: "run",
			},
			{},
		);
		const r = result as { action: "run"; runId: string; status: string; error?: string };
		assert.equal(r.status, "failed");
		assert.match(r.error ?? "", /not found/i);
		assert.equal(r.runId, "");
		assert.deepEqual(
			defaultStore.runs().map((run) => run.id),
			runsBefore,
		);
	});
});

// ---------------------------------------------------------------------------
// Slash command registration — no bundled workflow aliases
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — no slash aliases for bundled workflows", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		mock = makeMock();
		factory(mock);
	});

	test("no workflow:<name> commands are registered", () => {
		assert.equal(
			mock.commands.some((command) => command.name.startsWith("workflow:")),
			false,
		);
	});
});

describe("MockExtensionAPI — /workflows completions list session runs (#5224)", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		defaultStore.clear();
		mock = makeMock();
		factory(mock);
	});

	test("/workflows completions include top-level session run IDs and exclude removed /workflow subcommands and bundled names (#5224)", async () => {
		defaultStore.recordRunStart({
			id: "run-alpha-1",
			name: "fan-out-and-synthesize",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		defaultStore.recordRunStart({
			id: "run-beta-2",
			name: "goal",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 2,
		});
		assert.equal(getCommand(mock.commands, "workflow"), undefined);
		const cmd = getCommand(mock.commands, "workflows")!;
		const completions = (await cmd.options.getArgumentCompletions?.("")) ?? [];
		const labels = completions.map((c) => c.label);

		assert.deepEqual(labels.sort(), ["run-alpha-1", "run-beta-2"]);
		for (const sub of ["list", "status", "pause", "resume", "inputs", "session", "interrupt"]) {
			assert.equal(labels.includes(sub), false);
		}
		for (const name of BUILTIN_WORKFLOW_NAMES) {
			assert.equal(labels.includes(name), false);
		}
	});

	test("/workflows completions filter partial input to a matching run ID (#5224)", async () => {
		defaultStore.recordRunStart({
			id: "run-alpha-1",
			name: "fan-out-and-synthesize",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		defaultStore.recordRunStart({
			id: "run-beta-2",
			name: "goal",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 2,
		});
		const cmd = getCommand(mock.commands, "workflows")!;
		const completions = (await cmd.options.getArgumentCompletions?.("run-alpha")) ?? [];
		const labels = completions.map((c) => c.label);
		assert.deepEqual(labels, ["run-alpha-1"]);
	});
});

describe("MockExtensionAPI — workflow tool dispatches run while /workflows is runs-only (#5224)", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		defaultStore.clear();
		mock = makeMock();
		factory(mock);
	});

	test("registered workflow tool fan-out-and-synthesize dispatches run while /workflows rejects definition names (#5224)", async () => {
		const cmd = getCommand(mock.commands, "workflows")!;
		const messages: string[] = [];
		await cmd.options.handler("fan-out-and-synthesize", {
			ui: { notify: (m: string) => messages.push(m) },
		});
		assert.equal(
			messages.some((m) =>
				m.includes(
					'Run id must be a full 36-character UUID or a unique 8-character hexadecimal prefix; got "fan-out-and-synthesize"',
				),
			),
			true,
		);

		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(
			execute,
			{
				workflow: "fan-out-and-synthesize",
				inputs: { prompt: "test", max_branches: 1 },
				action: "run",
			},
			{},
		);
		const r = result as { action: "run"; runId: string; status: string };
		assert.equal(r.action, "run");
		assert.equal(r.status, "running");
		assert.ok(r.runId.length > 0);
		await waitForRun(r.runId, { store: defaultStore });
	});
});

// ---------------------------------------------------------------------------
// Registered tool — list/status without name or inputs (schema-tool-args: optional fields)
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — tool list/status without name or inputs", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		// #3106: this empty-session schema fixture must not inherit another test's owned runs.
		defaultStore.clear();
		mock = makeMock();
		factory(mock);
	});

	// Schema: name and inputs must NOT appear in the required array
	test("schema has no required fields — name absent from required", () => {
		const params = mock.tools[0]!.opts.parameters as { required?: string[] };
		assert.ok(!(params.required ?? []).includes("name"));
	});

	test("schema has no required fields — inputs absent from required", () => {
		const params = mock.tools[0]!.opts.parameters as { required?: string[] };
		assert.ok(!(params.required ?? []).includes("inputs"));
	});

	// Tool execute: { action: "list" } — no name, no inputs
	test("execute({ action: 'list' }) returns action='list'", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "list" });
		assert.equal(result.action, "list");
	});

	test("execute({ action: 'list' }) returns items array", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "list" });
		const r = result as { action: "list"; items: unknown[] };
		assert.equal(Array.isArray(r.items), true);
	});

	test("execute({ action: 'list' }) items includes bundled names", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "list" });
		const r = result as { action: "list"; items: { name: string }[] };
		assert.ok(r.items.some((i) => i.name === "fan-out-and-synthesize"));
	});

	// Tool execute: { action: "status" } — no name, no inputs
	test("execute({ action: 'status' }) returns action='status'", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "status" });
		assert.equal(result.action, "status");
	});

	test("execute({ action: 'status' }) returns snapshots array", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "status" });
		const r = result as { action: "status"; snapshots: unknown[] };
		assert.equal(Array.isArray(r.snapshots), true);
	});

	// Tool execute: { action: "models" } — no name, no inputs
	test("execute({ action: 'models' }) returns action='models'", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "models" });
		assert.equal(result.action, "models");
	});

	test("execute({ action: 'models' }) returns models array", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "models" });
		const r = result as { action: "models"; models: unknown[] };
		assert.equal(Array.isArray(r.models), true);
	});

	test("execute({ action: 'models' }) entries have required fields and no secrets", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { action: "models" });
		const r = result as {
			action: "models";
			models: Array<{ provider: string; id: string; fullId: string; isCurrent: boolean }>;
		};
		for (const entry of r.models) {
			assert.equal(typeof entry.provider, "string");
			assert.equal(typeof entry.id, "string");
			assert.equal(typeof entry.fullId, "string");
			assert.equal(typeof entry.isCurrent, "boolean");
		}
		const raw = JSON.stringify(result);
		assert.ok(!raw.includes("token"));
		assert.ok(!raw.includes("apiKey"));
		assert.ok(!raw.includes("auth"));
		assert.ok(!raw.includes("secret"));
		assert.ok(!raw.includes("credential"));
	});
});

// ---------------------------------------------------------------------------
// Graceful degradation — empty API object
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — graceful degradation", () => {
	test("factory({}) does not throw", () => {
		assert.doesNotThrow(() => factory({}));
	});

	test("factory with partial API (only registerTool) does not throw", () => {
		const api: ExtensionAPI = {
			registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
				void opts;
			},
		};
		assert.doesNotThrow(() => factory(api));
	});

	test("factory with partial API (only registerCommand) does not throw", () => {
		const api: ExtensionAPI = {
			registerCommand(_name: string, options: PiCommandOptions) {
				void options;
			},
		};
		assert.doesNotThrow(() => factory(api));
	});

	test("factory with partial API (only registerMessageRenderer) does not throw", () => {
		const api: ExtensionAPI = {
			registerMessageRenderer(
				event: string,
				renderer: (payload: Record<string, unknown>) => PiMessageRendererResult,
			) {
				void event;
				void renderer;
			},
		};
		assert.doesNotThrow(() => factory(api));
	});

	test("factory with partial API (only registerFlag) does not throw", () => {
		const api: ExtensionAPI = {
			registerFlag(name: string, opts: PiFlagNamedOpts) {
				void name;
				void opts;
			},
		};
		assert.doesNotThrow(() => factory(api));
	});
});
