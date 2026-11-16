import assert from "node:assert/strict";
import { test } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
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

test("registers /workflows with its optional stage argument (#5234)", async () => {
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
		assert.deepEqual(
			registered.filter((name) => name.startsWith("workflow")),
			["workflow", "workflows"],
		);
		assert.equal(
			descriptions.get("workflows"),
			"Open this session's workflow runs. Usage: /workflows [run-id] [stage]",
		);
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
