import assert from "node:assert/strict";
import { test } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { ExtensionAPI, PiCommandOptions } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import type { WorkflowCommandHandler } from "../../packages/workflows/src/extension/workflow-command-utils.js";
import type { GraphOverlayPort } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const overlay: GraphOverlayPort = {
	open: () => {},
	toggle: () => {},
	close: () => {},
};

test("registers only /workflows and /workflow-authoring with their exact descriptions (#5224)", async () => {
	setDurableBackend(await createMemoryTestBackend());
	try {
		const handlers = new Map<string, WorkflowCommandHandler>();
		const registered: string[] = [];
		const descriptions = new Map<string, string>();
		const pi: ExtensionAPI = {
			registerCommand(name, options) {
				registered.push(name);
				descriptions.set(name, options.description);
			},
		};
		const runtime = createExtensionRuntime();
		registerWorkflowSlashCommand(pi, handlers, {
			runtimeProxy: runtime,
			runtimeForContext: () => runtime,
			overlay,
			reloadWorkflowResources: () => undefined,
			ensureWorkflowResourcesLoaded: () => undefined,
			runWithLifecycleSuppressedForPolicy: (_policy, run) => run(),
			runControl: {
				pi,
				overlay,
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
			},
		});

		assert.equal(handlers.has("workflow"), true);
		assert.equal(handlers.has("workflows"), true);
		assert.equal(handlers.has("workflow-authoring"), true);
		assert.deepEqual(
			registered.filter((name) => name.startsWith("workflow")),
			["workflows", "workflow-authoring"],
		);
		assert.equal(descriptions.get("workflows"), "Browse running and completed workflows");
		assert.equal(descriptions.get("workflow-authoring"), "Load the reference for writing workflow definitions");

		const notices: string[] = [];
		const ctx = {
			ui: {
				notify: (message: string) => {
					notices.push(message);
				},
			},
			hasUI: true,
			cwd: process.cwd(),
		} as never;
		await handlers.get("workflow")?.("", ctx);
		await handlers.get("workflow")?.("list", ctx);
		assert.deepEqual(notices, [
			"! /workflow was removed · use /workflows, /resume or ask the agent to run a workflow",
			"! /workflow was removed · use /workflows, /resume or ask the agent to run a workflow",
		]);
	} finally {
		setDurableBackend(undefined);
	}
});

test("/workflows opens the session's only run in its graph, never a resume picker (#5224)", async () => {
	setDurableBackend(await createMemoryTestBackend());
	const { store } = await import("../../packages/workflows/src/shared/store.js");
	const runId = crypto.randomUUID();
	store.recordRunStart({
		id: runId,
		name: "demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: Date.now(),
	});
	try {
		const handlers = new Map<string, WorkflowCommandHandler>();
		const opened: string[] = [];
		const pickers: string[] = [];
		const graph: GraphOverlayPort = {
			open: (id) => {
				opened.push(String(id));
			},
			toggle: () => {},
			close: () => {},
		};
		const pi: ExtensionAPI = { registerCommand() {} };
		const runtime = createExtensionRuntime();
		registerWorkflowSlashCommand(pi, handlers, {
			runtimeProxy: runtime,
			runtimeForContext: () => runtime,
			overlay: graph,
			reloadWorkflowResources: () => undefined,
			ensureWorkflowResourcesLoaded: () => undefined,
			runWithLifecycleSuppressedForPolicy: (_policy, run) => run(),
			runControl: {
				pi,
				overlay: graph,
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
			},
		});
		const ui = {
			custom: async () => undefined,
			select: async () => undefined,
			notify: () => {},
			sessionPicker: async () => {
				pickers.push("session");
				return undefined;
			},
			showSessionPicker: async () => {
				pickers.push("session");
				return undefined;
			},
		};
		await handlers.get("workflows")?.("", { ui, hasUI: true, cwd: process.cwd() } as never);
		assert.deepEqual(opened, [runId]);
		assert.deepEqual(pickers, [], "no resume picker opens");
	} finally {
		store.removeRun(runId);
		setDurableBackend(undefined);
	}
});

test("/workflows completes current-session run IDs (#5224)", async () => {
	setDurableBackend(await createMemoryTestBackend());
	const { store } = await import("../../packages/workflows/src/shared/store.js");
	const runId = crypto.randomUUID();
	store.recordRunStart({
		id: runId,
		name: "demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: Date.now(),
	});
	try {
		const handlers = new Map<string, WorkflowCommandHandler>();
		const commands = new Map<string, PiCommandOptions>();
		const pi: ExtensionAPI = {
			registerCommand(name, options) {
				commands.set(name, options);
			},
		};
		const runtime = createExtensionRuntime();
		registerWorkflowSlashCommand(pi, handlers, {
			runtimeProxy: runtime,
			runtimeForContext: () => runtime,
			overlay,
			reloadWorkflowResources: () => undefined,
			ensureWorkflowResourcesLoaded: () => undefined,
			runWithLifecycleSuppressedForPolicy: (_policy, run) => run(),
			runControl: {
				pi,
				overlay,
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
			},
		});
		const workflowsCommand = commands.get("workflows");
		assert.ok(workflowsCommand?.getArgumentCompletions);
		const completions = await workflowsCommand.getArgumentCompletions(runId.slice(0, 8));
		assert.deepEqual(completions, [
			{
				value: `${runId} `,
				label: runId,
				description: "demo — running",
			},
		]);
		assert.equal(await workflowsCommand.getArgumentCompletions("no-such-run"), null);
		assert.equal(await workflowsCommand.getArgumentCompletions(`${runId} `), null);
		assert.equal(await workflowsCommand.getArgumentCompletions(`${runId} ${runId.slice(0, 2)}`), null);
		assert.equal(await workflowsCommand.getArgumentCompletions(`  ${runId}\t`), null);
		assert.deepEqual(await workflowsCommand.getArgumentCompletions(`  ${runId.slice(0, 8)}`), [
			{ value: `  ${runId} `, label: runId, description: "demo — running" },
		]);
	} finally {
		store.removeRun(runId);
		setDurableBackend(undefined);
	}
});

test("/workflow-authoring loads the authoring reference without a turn and expands on ctrl+o, or sends a trailing request (#5224)", async () => {
	setDurableBackend(await createMemoryTestBackend());
	try {
		const handlers = new Map<string, WorkflowCommandHandler>();
		const customMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
		const userPrompts: string[] = [];
		const renderers = new Map<
			string,
			NonNullable<Parameters<NonNullable<ExtensionAPI["registerMessageRenderer"]>>[1]>
		>();
		const pi: ExtensionAPI = {
			registerCommand() {},
			registerMessageRenderer(type, renderer) {
				renderers.set(type, renderer);
			},
			sendMessage(message, options) {
				customMessages.push({
					message: message as unknown as Record<string, unknown>,
					options: options as unknown as Record<string, unknown>,
				});
			},
			sendUserMessage(content) {
				userPrompts.push(typeof content === "string" ? content : JSON.stringify(content));
			},
		};
		const runtime = createExtensionRuntime();
		registerWorkflowSlashCommand(pi, handlers, {
			runtimeProxy: runtime,
			runtimeForContext: () => runtime,
			overlay,
			reloadWorkflowResources: () => undefined,
			ensureWorkflowResourcesLoaded: () => undefined,
			runWithLifecycleSuppressedForPolicy: (_policy, run) => run(),
			runControl: {
				pi,
				overlay,
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
			},
		});

		const authoringHandler = handlers.get("workflow-authoring");
		assert.ok(authoringHandler);
		const ctx = { ui: { notify: () => {} }, hasUI: true, cwd: process.cwd() } as never;

		await authoringHandler("", ctx);
		assert.equal(customMessages.length, 1);
		assert.equal(userPrompts.length, 0);
		assert.deepEqual(customMessages[0]!.options, { triggerTurn: false });
		assert.equal(customMessages[0]!.message.display, true);
		assert.match(String(customMessages[0]!.message.content), /# Custom Workflow Authoring/);

		const renderer = renderers.get(String(customMessages[0]!.message.customType));
		assert.ok(renderer);
		const collapsed = renderer(customMessages[0]!.message, { expanded: false });
		assert.ok(collapsed && typeof collapsed === "object" && "render" in collapsed);
		assert.deepEqual(collapsed.render(80), ["› Loaded workflow authoring reference (ctrl+o to expand)"]);

		const rebound = renderer(customMessages[0]!.message, {
			expanded: false,
			keyText: () => "alt+e",
		});
		assert.ok(rebound && typeof rebound === "object" && "render" in rebound);
		assert.deepEqual(rebound.render(80), ["› Loaded workflow authoring reference (alt+e to expand)"]);

		const expanded = renderer(customMessages[0]!.message, { expanded: true });
		assert.ok(expanded && typeof expanded === "object" && "render" in expanded);
		assert.match(expanded.render(80).join("\n"), /Custom Workflow Authoring/);

		await authoringHandler("  Write a two-stage verification workflow  ", ctx);
		assert.equal(customMessages.length, 2);
		assert.deepEqual(customMessages[1]!.options, { triggerTurn: false });
		assert.deepEqual(userPrompts, ["Write a two-stage verification workflow"]);
	} finally {
		setDurableBackend(undefined);
	}
});
