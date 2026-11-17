import assert from "node:assert/strict";
import { stripTerminalSequences, Text } from "@bastani/atomic-tui";
import { beforeAll, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ToolRenderers } from "../src/core/extensions/types.ts";
import { bindOwnerTaskStore, type OwnerTaskStore } from "../src/core/tasks/owner-store.js";
import { renderChatMessageEntry } from "../src/modes/interactive/components/chat-message-renderer.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import { themedChatHostStyle } from "../src/modes/interactive/components/task-transcript-page.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { EngineRenderService } from "../src/modes/interactive-engine/engine-render-service.ts";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.ts";
import { RemoteToolExecutionComponent } from "../src/modes/interactive-engine/remote-renderer.ts";
import { createRpcExtensionUIContext } from "../src/modes/rpc/rpc-extension-ui.ts";

const transcripts = vi.hoisted(() => new Map<object, object>());
vi.mock("../src/core/tasks/supervisor.js", async (original) => ({
	...(await original<typeof import("../src/core/tasks/supervisor.js")>()),
	taskTranscriptSource: (lease: object) =>
		transcripts.has(lease)
			? { ok: true, value: { session: transcripts.get(lease) } }
			: { ok: false, error: { code: "TranscriptUnavailable" } },
}));

beforeAll(() => initTheme("dark", false));

function renderers(label: string): ToolRenderers {
	return { renderCall: () => new Text(`${label}()`, 0, 0), renderResult: () => new Text(`${label} result`, 0, 0) };
}

function harness() {
	const lease = {};
	let live = true;
	let settled = false;
	const listeners = new Set<() => void>();
	const child = {
		getToolDefinition: () => renderers("Child"),
		extensionRunner: { resolveToolRenderers: (_: string, base: () => ToolRenderers | undefined) => base() },
	};
	const source = {
		getSessionId: () => "child-session",
		getEntries: () => [],
		getCwd: () => "/child",
		get chatSession() {
			return live ? child : undefined;
		},
	};
	transcripts.set(lease, source);
	const root = {
		sessionManager: { getCwd: () => "/root" },
		getToolDefinition: () => renderers("Root"),
		extensionRunner: { resolveToolRenderers: (_: string, base: () => ToolRenderers | undefined) => base() },
	} as unknown as AgentSession;
	bindOwnerTaskStore(root, {
		resolveTask: (id: string) =>
			id === "own-task" ? { ok: true, value: lease } : { ok: false, error: { code: "UnknownTask" } },
		getTask: (id: string) =>
			id === "own-task" ? { execution: { kind: settled ? "settled" : "running" } } : undefined,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as OwnerTaskStore);
	const frames: string[][] = [];
	const service = new EngineRenderService((line) => {
		const event = parseInteractiveEngineMessage(line.trim());
		if (event?.type === "engine_custom_frame") frames.push(event.lines);
	});
	service.bindSession(root);
	let requestId = 0;
	const render = async (rendererTaskId: string, toolName = "contact_supervisor") => {
		const before = frames.length;
		service.handleLine(
			JSON.stringify({
				type: "engine_tool_render",
				componentId: "row",
				requestId: ++requestId,
				width: 80,
				toolName,
				toolCallId: "call",
				rendererTaskId,
				args: { secret: "private argument" },
				result: { content: [{ type: "text", text: "private result" }] },
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				imageWidthCells: 60,
			}),
		);
		await vi.waitFor(() => assert.ok(frames.length > before));
		return frames.at(-1)!.map(stripTerminalSequences).join("\n");
	};
	return {
		service,
		render,
		listeners,
		releaseSession: () => {
			live = false;
			for (const listener of [...listeners]) listener();
		},
		finish: () => {
			live = false;
			settled = true;
			for (const listener of [...listeners]) listener();
		},
		close: () => {
			service.dispose();
			transcripts.delete(lease);
		},
	};
}

test("isolated task transcripts resolve renderers from the session that ran the tool (#5350)", async () => {
	const h = harness();
	try {
		assert.match(await h.render("own-task"), /Child\(\)/);
		assert.equal(h.listeners.size, 1);
		h.finish();
		assert.equal(h.listeners.size, 0);
		assert.match(await h.render("own-task"), /Root\(\)/);
	} finally {
		h.close();
	}
});

test("a released child session drops its renderer even while the task remains pending (#5350)", async () => {
	const h = harness();
	try {
		assert.match(await h.render("own-task"), /Child\(\)/);
		h.releaseSession();
		assert.equal(h.listeners.size, 0);
		assert.match(await h.render("own-task"), /Root\(\)/);
	} finally {
		h.close();
	}
});

test("renderer resolution failures expose neither exception text nor terminal controls (#5350)", async () => {
	const frames: string[][] = [];
	const service = new EngineRenderService((line) => {
		const event = parseInteractiveEngineMessage(line.trim());
		if (event?.type === "engine_custom_frame") frames.push(event.lines);
	});
	service.bindSession({
		sessionManager: { getCwd: () => "/root" },
		extensionRunner: {
			resolveToolRenderers: () => {
				throw new Error("private renderer detail\u001b]52;c;c2VjcmV0\u0007");
			},
		},
	} as unknown as AgentSession);
	try {
		service.handleLine(
			JSON.stringify({
				type: "engine_tool_render",
				componentId: "failed",
				requestId: 1,
				width: 80,
				toolName: "custom",
				toolCallId: "failed",
				args: {},
				executionStarted: false,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				imageWidthCells: 60,
			}),
		);
		await vi.waitFor(() => assert.equal(frames.length, 1));
		const raw = frames[0]!.join("\n");
		assert.match(stripTerminalSequences(raw), /✗ Tool renderer failed/);
		assert.doesNotMatch(raw, /private renderer detail|\u001b\]52;/);
	} finally {
		service.dispose();
	}
});

test("RPC-hosted chat widgets inherit the bound session's renderer ports (#5350)", () => {
	const own = renderers("Bound session");
	const message = () => new Text("Bound message", 0, 0);
	const context = createRpcExtensionUIContext({
		output() {},
		pendingExtensionRequests: new Map(),
		getToolDefinition: () => own,
		getCustomMessageRenderer: () => message,
	});
	const settings = context.getChatRenderSettings();
	assert.equal(settings.getToolDefinition("contact_supervisor"), own);
	assert.equal(settings.getCustomMessageRenderer("intercom_message"), message);
});

test("default chat components pass their own renderer resolver into nested tool blocks (#5350)", () => {
	const nested: ToolRenderers = { renderCall: () => new Text("Nested owner", 0, 0) };
	const outer: ToolRenderers = {
		renderCall: (_args, theme, context) =>
			context.getToolDefinition?.("nested")?.renderCall?.({}, theme, context) ?? new Text("Missing resolver", 0, 0),
	};
	const component = renderChatMessageEntry(
		{ kind: "tool", role: "tool", toolName: "outer", toolCallId: "outer", args: {} },
		{ ui: { requestRender() {} }, cwd: "/child", getToolDefinition: (name) => (name === "outer" ? outer : nested) },
	);
	try {
		assert.match(component.render(80).map(stripTerminalSequences).join("\n"), /Nested owner/);
	} finally {
		if ("dispose" in component && typeof component.dispose === "function") component.dispose();
	}
});

test("attached renderer frames repaint the same cached component with local expansion settings (#5350)", () => {
	let paint = () => {};
	let value = "waiting";
	let builds = 0;
	const host = new ChatSessionHost({
		style: themedChatHostStyle(),
		editorTheme: getEditorTheme(),
		getChatRenderSettings: () => ({
			toolOutputExpanded: true,
			createToolComponent: (_entry, context) => {
				assert.ok(context);
				assert.equal(context.expanded, true);
				builds++;
				paint = context.requestRender;
				paint();
				return { render: () => [`Engine(${value})`], invalidate() {} };
			},
		}),
	});
	try {
		host.applyAgentEvent({
			type: "tool_execution_start",
			toolCallId: "nested",
			toolName: "probe",
			args: {},
		} as never);
		assert.match(host.renderBody(80, 20).map(stripTerminalSequences).join("\n"), /Engine\(waiting\)/);
		value = "fresh";
		paint();
		assert.match(host.renderBody(80, 20).map(stripTerminalSequences).join("\n"), /Engine\(fresh\)/);
		assert.equal(builds, 1);
	} finally {
		host.dispose();
	}
});

test("cached and delayed frames cannot cross renderer runtimes or switched sessions (#5350)", () => {
	let sessionId = "first-session";
	const commands: InteractiveEngineCommand[] = [];
	const runtime = () =>
		({
			session: { sessionManager: { getSessionId: () => sessionId } },
			onEngineMessage: () => () => {},
			sendEngineCommand: (command: InteractiveEngineCommand) => commands.push(command),
		}) as unknown as IsolatedInteractiveRuntime;
	const firstRuntime = runtime();
	const row = new RemoteToolExecutionComponent("probe", "ownership-cache", {}, {}, firstRuntime, () => {});
	const other = new RemoteToolExecutionComponent("probe", "ownership-cache", {}, {}, runtime(), () => {});
	try {
		row.render(80);
		const request = commands.at(-1)! as Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>;
		row.receive({
			type: "engine_custom_frame",
			componentId: request.componentId,
			requestId: request.requestId,
			lines: ["private first session"],
		});
		assert.deepEqual(row.render(80), ["private first session"]);
		assert.deepEqual(other.render(80), []);
		row.invalidate();
		row.render(80);
		const late = commands.at(-1)! as Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>;
		sessionId = "second-session";
		row.receive({
			type: "engine_custom_frame",
			componentId: late.componentId,
			requestId: late.requestId,
			lines: ["late private frame"],
		});
		assert.deepEqual(row.render(80), []);
	} finally {
		row.dispose();
		other.dispose();
	}
});

test("task renderer selectors reject malformed values while legacy frames still parse (#5350)", () => {
	const command = {
		type: "engine_tool_render",
		componentId: "row",
		requestId: 1,
		width: 80,
		toolName: "read",
		toolCallId: "call",
		args: {},
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		imageWidthCells: 60,
	};
	assert.ok(parseInteractiveEngineCommand(JSON.stringify(command)));
	for (const rendererTaskId of [false, 1, "", "x".repeat(257), []])
		assert.equal(parseInteractiveEngineCommand(JSON.stringify({ ...command, rendererTaskId })), undefined);
	assert.equal(
		(
			parseInteractiveEngineCommand(JSON.stringify({ ...command, rendererTaskId: "own-task" })) as {
				rendererTaskId: string;
			}
		).rendererTaskId,
		"own-task",
	);
});

test("unowned tasks and unavailable custom renderers never reveal raw tool fields (#5350)", async () => {
	const h = harness();
	try {
		const unauthorized = await h.render("other-task");
		assert.match(unauthorized, /renderer unavailable/i);
		assert.doesNotMatch(unauthorized, /private argument|private result|Root|Child/);
		h.finish();
		const unavailable = await h.render("own-task", "private_custom_action");
		assert.match(unavailable, /renderer unavailable/i);
		assert.doesNotMatch(unavailable, /private argument|private result|Root|Child/);
	} finally {
		h.close();
	}
});
