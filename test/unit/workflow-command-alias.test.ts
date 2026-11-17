import assert from "node:assert/strict";
import {
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import factory from "../../packages/workflows/src/extension/extension-factory.js";
import type { ExtensionAPI, PiCommandOptions } from "../../packages/workflows/src/extension/public-types.js";
import {
	formatWorkflowAuthoringCollapsedLine,
	registerWorkflowSlashCommand,
} from "../../packages/workflows/src/extension/workflow-command-registration.js";
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
		registerWorkflowSlashCommand(pi, handlers, { overlay });

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

test("/workflows stage argument validates against the resolved run and passes stageId and stageRunId (#5234)", async () => {
	setDurableBackend(await createMemoryTestBackend());
	const { store } = await import("../../packages/workflows/src/shared/store.js");
	const runId = crypto.randomUUID();
	store.recordRunStart({
		id: runId,
		name: "demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [
			{ id: "build-step", name: "Build", status: "running", parentIds: [], toolEvents: [] },
			{ id: "test-step", name: "Test", status: "pending", parentIds: ["build-step"], toolEvents: [] },
		],
		startedAt: Date.now(),
	});
	try {
		const handlers = new Map<string, WorkflowCommandHandler>();
		const opened: Array<{ runId?: string | null; stageId?: string; stageRunId?: string }> = [];
		const graph: GraphOverlayPort = {
			open: (id, _surface, stageId, stageRunId) => {
				opened.push({ runId: id, stageId, stageRunId });
			},
			toggle: () => {},
			close: () => {},
		};
		const pi: ExtensionAPI = {
			registerCommand() {},
		};
		registerWorkflowSlashCommand(pi, handlers, { overlay: graph });

		const errors: string[] = [];
		const ui = {
			custom: async () => undefined,
			select: async () => undefined,
			notify: (msg: string, level?: string) => {
				if (level === "error") errors.push(msg);
			},
		};
		const ctx = { ui, hasUI: true, cwd: process.cwd() } as never;
		const workflowsHandler = handlers.get("workflows");
		assert.ok(workflowsHandler);

		await workflowsHandler(`${runId.slice(0, 8)} Build`, ctx);
		assert.deepEqual(opened, [{ runId, stageId: "build-step", stageRunId: runId }]);
		assert.deepEqual(errors, []);

		await workflowsHandler(`${runId.slice(0, 8)} nope`, ctx);
		assert.equal(opened.length, 1);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /Stage not found.*nope/);
	} finally {
		store.removeRun(runId);
		setDurableBackend(undefined);
	}
});

test("/workflows argument completions complete only the first run-id token (#5234)", async () => {
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
		let workflowsCommand: PiCommandOptions | undefined;
		const pi: ExtensionAPI = {
			registerCommand(name, options) {
				if (name === "workflows") workflowsCommand = options;
			},
		};
		registerWorkflowSlashCommand(pi, handlers, { overlay });

		assert.ok(workflowsCommand?.getArgumentCompletions);
		assert.deepEqual(await workflowsCommand.getArgumentCompletions(runId.slice(0, 8)), [
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
	initTheme("dark", false);
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
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
		registerWorkflowSlashCommand(pi, handlers, { overlay });

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
		assert.deepEqual(
			collapsed.render(80).map((line) => stripTerminalSequences(line).trimEnd()),
			[" › Loaded workflow authoring reference (ctrl+o to expand)"],
		);

		setKeybindings(new KeybindingsManager({ "app.tools.expand": "alt+e" }));
		const rebound = renderer(customMessages[0]!.message, { expanded: false });
		assert.ok(rebound && typeof rebound === "object" && "render" in rebound);
		assert.deepEqual(
			rebound.render(80).map((line) => stripTerminalSequences(line).trimEnd()),
			[" › Loaded workflow authoring reference (alt+e to expand)"],
		);

		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		const unbound = renderer(customMessages[0]!.message, { expanded: false });
		assert.ok(unbound && typeof unbound === "object" && "render" in unbound);
		assert.deepEqual(
			unbound.render(80).map((line) => stripTerminalSequences(line).trimEnd()),
			[" › Loaded workflow authoring reference"],
		);

		setKeybindings(new KeybindingsManager());
		const expanded = renderer(customMessages[0]!.message, { expanded: true });
		assert.ok(expanded && typeof expanded === "object" && "render" in expanded);
		const expandedLines = expanded.render(80).map((line) => stripTerminalSequences(line).trimEnd());
		assert.equal(expandedLines[0], " › Loaded workflow authoring reference (ctrl+o to expand)");
		assert.match(expandedLines.join("\n"), /Custom Workflow Authoring/);

		await authoringHandler("  Write a two-stage verification workflow  ", ctx);
		assert.equal(customMessages.length, 2);
		assert.deepEqual(customMessages[1]!.options, { triggerTurn: false });
		assert.deepEqual(userPrompts, ["Write a two-stage verification workflow"]);
	} finally {
		setKeybindings(previousKeys);
		setDurableBackend(undefined);
	}
});

test("/workflow-authoring reports an error when sendMessage or sendUserMessage is unavailable or fails (#5224)", async () => {
	setDurableBackend(await createMemoryTestBackend());
	try {
		const registerWith = (pi: ExtensionAPI) => {
			const handlers = new Map<string, WorkflowCommandHandler>();
			registerWorkflowSlashCommand(pi, handlers, { overlay });
			return handlers.get("workflow-authoring")!;
		};

		const noSendErrors: string[] = [];
		const noSendPrompts: string[] = [];
		const noSendHandler = registerWith({
			registerCommand() {},
			sendUserMessage(content) {
				noSendPrompts.push(content);
			},
		});
		await noSendHandler("Build a workflow", {
			ui: { notify: (msg: string, level?: string) => level === "error" && noSendErrors.push(msg) },
			hasUI: true,
			cwd: process.cwd(),
		} as never);
		assert.equal(noSendErrors.length, 1);
		assert.match(noSendErrors[0]!, /Could not load workflow authoring reference/);
		assert.deepEqual(noSendPrompts, [], "request must not be sent without the reference");

		const throwSendErrors: string[] = [];
		const throwSendPrompts: string[] = [];
		const throwSendHandler = registerWith({
			registerCommand() {},
			sendMessage() {
				throw new Error("context write failed");
			},
			sendUserMessage(content) {
				throwSendPrompts.push(content);
			},
		});
		await throwSendHandler("Build a workflow", {
			ui: { notify: (msg: string, level?: string) => level === "error" && throwSendErrors.push(msg) },
			hasUI: true,
			cwd: process.cwd(),
		} as never);
		assert.equal(throwSendErrors.length, 1);
		assert.match(throwSendErrors[0]!, /context write failed/);
		assert.deepEqual(throwSendPrompts, [], "request must not be sent when loading the reference fails");

		const noUserMsgErrors: string[] = [];
		const noUserMsgSent: unknown[] = [];
		const noUserMsgHandler = registerWith({
			registerCommand() {},
			sendMessage(msg) {
				noUserMsgSent.push(msg);
			},
		});
		await noUserMsgHandler("Build a workflow", {
			ui: { notify: (msg: string, level?: string) => level === "error" && noUserMsgErrors.push(msg) },
			hasUI: true,
			cwd: process.cwd(),
		} as never);
		assert.equal(noUserMsgErrors.length, 1);
		assert.match(noUserMsgErrors[0]!, /Could not send workflow authoring request/);
		assert.deepEqual(noUserMsgSent, [], "reference must not be partially loaded when request cannot be sent");

		const oscErrors: string[] = [];
		const oscHandler = registerWith({
			registerCommand() {},
			sendMessage() {
				throw new Error("bad\x1b]52;c;c2VjcmV0\x07\x1b[2J\x9b31m\u202eerror\n    at secret (/tmp/x.ts:1:1)");
			},
		});
		await oscHandler("", {
			ui: { notify: (msg: string, level?: string) => level === "error" && oscErrors.push(msg) },
			hasUI: true,
			cwd: process.cwd(),
		} as never);
		assert.equal(oscErrors.length, 1);
		assert.equal(oscErrors[0]!.includes("\x1b"), false);
		assert.equal(oscErrors[0]!.includes("\x9b"), false);
		assert.equal(oscErrors[0]!.includes("\u202e"), false);
		assert.equal(oscErrors[0]!.includes("/tmp/x.ts"), false);
	} finally {
		setDurableBackend(undefined);
	}
});

test("/workflow-authoring never mutates global keybindings and steers requests when the session is busy (#5224)", async () => {
	initTheme("dark", false);
	const previousKeys = getKeybindings();
	const customManager = new TuiKeybindingsManager({
		...TUI_KEYBINDINGS,
		"ext.custom.sentinel": { defaultKeys: "ctrl+g", description: "Custom sentinel" },
	});
	setKeybindings(customManager);
	setDurableBackend(await createMemoryTestBackend());
	try {
		assert.equal(formatWorkflowAuthoringCollapsedLine(), "› Loaded workflow authoring reference");
		assert.equal(getKeybindings(), customManager, "global KeybindingsManager instance must not be replaced");
		assert.deepEqual(getKeybindings().getKeys("ext.custom.sentinel" as never), ["ctrl+g"]);

		const events: string[] = [];
		const handlers = new Map<string, WorkflowCommandHandler>();
		const pi: ExtensionAPI = {
			registerCommand() {},
			sendMessage() {
				events.push("ref");
			},
			sendUserMessage(content, options) {
				if (options?.deliverAs !== "steer") {
					throw new Error("streaming session requires deliverAs: steer");
				}
				events.push(`steer:${content}`);
			},
		};
		registerWorkflowSlashCommand(pi, handlers, { overlay });
		await handlers.get("workflow-authoring")!("  Add retry gate  ", {
			isIdle: () => false,
			ui: { notify: (msg: string) => events.push(`notify:${msg}`) },
			hasUI: true,
			cwd: process.cwd(),
		} as never);
		assert.deepEqual(events, ["ref", "steer:Add retry gate"]);
	} finally {
		setKeybindings(previousKeys);
		setDurableBackend(undefined);
	}
});

test("/workflows opens a run immediately without awaiting workflow resource discovery (#5224)", async () => {
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
		let refreshCalls = 0;
		let workflowsCommand: PiCommandOptions | undefined;
		let customMounts = 0;
		const pi: ExtensionAPI = {
			registerTool() {},
			registerCommand(name, options) {
				if (name === "workflows") workflowsCommand = options;
			},
			registerMessageRenderer() {},
			registerFlag() {},
			registerShortcut() {},
			on() {},
			refreshWorkflowResources: () => {
				refreshCalls += 1;
				return new Promise(() => {});
			},
		};
		factory(pi);
		assert.ok(workflowsCommand?.handler);
		const ui = {
			custom: async () => {
				customMounts += 1;
				return undefined;
			},
			select: async () => undefined,
			notify: () => {},
		};
		const outcome = await Promise.race([
			Promise.resolve(workflowsCommand.handler("", { ui, hasUI: true, cwd: process.cwd() } as never)).then(
				() => "settled" as const,
			),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
		]);
		assert.equal(outcome, "settled");
		assert.equal(refreshCalls, 0);
		assert.equal(customMounts, 1);
	} finally {
		store.removeRun(runId);
		setDurableBackend(undefined);
	}
});
