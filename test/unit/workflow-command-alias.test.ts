import assert from "node:assert/strict";
import { test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
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

test("registers /workflows as the durable run-history alias", async () => {
	setDurableBackend(await createMemoryTestBackend());
	try {
		const handlers = new Map<string, WorkflowCommandHandler>();
		const registered: string[] = [];
		const pi: ExtensionAPI = {
			registerCommand(name) {
				registered.push(name);
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

test("/workflows with no run opens the workflows sheet, which lists runs and definitions, and Esc closes it (#5224)", async () => {
	initTheme("dark");
	setDurableBackend(await createMemoryTestBackend());
	try {
		const handlers = new Map<string, WorkflowCommandHandler>();
		const opened: string[] = [];
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
		const rendered: string[][] = [];
		const ui = {
			notify: () => {},
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					keys: unknown,
					done: (r: undefined) => void,
				) => {
					render(width: number): string[];
					handleInput(data: string): boolean;
				},
			) => {
				let finished = false;
				const component = factory({ requestRender: () => {} }, undefined, undefined, () => {
					finished = true;
				});
				rendered.push(component.render(80));
				component.handleInput("\x1b");
				assert.equal(finished, true, "Esc closes the sheet");
				return undefined;
			},
		};
		await handlers.get("workflows")?.("", { ui, hasUI: true, cwd: process.cwd() } as never);
		assert.equal(rendered.length, 1, "the sheet mounted");
		const text = rendered[0]?.join("\n") ?? "";
		assert.match(text, /Workflows/);
		assert.deepEqual(opened, [], "nothing opens on Esc");
	} finally {
		setDurableBackend(undefined);
	}
});
