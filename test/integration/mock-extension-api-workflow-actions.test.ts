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
		// Background dispatch returns `status: "running"` synchronously with a real UUID.
		const result = await runTool(execute, {
			workflow: "fan-out-and-synthesize",
			inputs: { prompt: "test query", max_branches: 1 },
			action: "run",
		});
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
		const result = await runTool(execute, {
			workflow: "fan-out-and-synthesize",
			inputs: { prompt: "test", max_branches: 1 },
			action: "run",
		});
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

	test("action='run' for unknown workflow returns non-placeholder empty runId string with failed status", async () => {
		const execute = mock.tools[0]!.opts.execute;
		const result = await runTool(execute, { workflow: "nonexistent-workflow-xyz", inputs: {}, action: "run" });
		const r = result as { action: "run"; runId: string; status: string; error?: string };
		assert.equal(r.status, "failed");
		assert.ok(r.error!.includes("nonexistent-workflow-xyz"));
		// not-found returns "" as runId (documented behaviour: empty sentinel for not-found)
		assert.equal(r.runId, "");
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

// ---------------------------------------------------------------------------
// Completions include admin subcommands and workflow names
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — completions include admin subcommands and workflow names", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		mock = makeMock();
		factory(mock);
	});

	test("/workflow completions include all admin subcommands and all bundled workflow names", async () => {
		const cmd = getCommand(mock.commands, "workflow")!;
		const completions = (await cmd.options.getArgumentCompletions?.("")) ?? [];
		const labels = completions.map((c) => c.label);

		// Admin subcommands
		for (const sub of ["list", "status", "connect", "interrupt", "resume", "inputs"]) {
			assert.ok(labels.includes(sub));
		}
		assert.equal(labels.includes("session"), false);

		for (const name of BUILTIN_WORKFLOW_NAMES) assert.ok(labels.includes(name));
	});

	test("/workflow completions filter partial input to a workflow name", async () => {
		const cmd = getCommand(mock.commands, "workflow")!;
		const completions = (await cmd.options.getArgumentCompletions?.("fan")) ?? [];
		const labels = completions.map((c) => c.label);
		assert.deepEqual(labels, ["fan-out-and-synthesize"]);
	});
});

// /workflow <name> prompt=test dispatches run, not unknown subcommand.

describe("MockExtensionAPI — /workflow <name> dispatches run not unknown-subcommand", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
		mock = makeMock();
		factory(mock);
	});

	test("/workflow fan-out-and-synthesize prompt=test dispatches run", async () => {
		const cmd = getCommand(mock.commands, "workflow")!;
		const messages: string[] = [];
		await cmd.options.handler("fan-out-and-synthesize prompt=test", {
			ui: { notify: (m: string) => messages.push(m) },
		});

		// Must not say "unknown subcommand"
		assert.equal(
			messages.some((m) => m.toLowerCase().includes("unknown subcommand")),
			false,
		);

		// Must print a dispatch confirmation or a failure — never silent.
		// The success path now emits via pi.sendMessage (kind: "dispatch")
		// instead of ctx.ui.notify; either signal counts as evidence the
		// handler resolved without the unknown-subcommand fallback.
		const dispatchedSent = mock.sent.some((m) => (m.details as { kind?: string } | undefined)?.kind === "dispatch");
		const errored = messages.some(
			(m) => m.includes("completed") || m.includes("failed") || m.includes("Workflow not found"),
		);
		assert.equal(dispatchedSent || errored, true);
	});
});

// ---------------------------------------------------------------------------
// Registered tool — list/status without name or inputs (schema-tool-args: optional fields)
// ---------------------------------------------------------------------------

describe("MockExtensionAPI — tool list/status without name or inputs", () => {
	let mock: ReturnType<typeof makeMock>;

	beforeEach(() => {
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
