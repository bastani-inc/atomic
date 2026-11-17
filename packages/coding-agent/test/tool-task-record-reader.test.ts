import assert from "node:assert/strict";
import { stripTerminalSequences, Text } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { setCallbackActivityReporter } from "../src/core/callback-activity.js";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { TaskId, TaskRecord } from "../src/core/tasks/contracts.js";
import { bindOwnerTaskStore, type OwnerTaskStore } from "../src/core/tasks/owner-store.js";
import { renderChatMessageEntry } from "../src/modes/interactive/components/chat-message-renderer.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostOpts } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { EngineRenderService } from "../src/modes/interactive-engine/engine-render-service.js";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../src/modes/interactive-engine/protocol.js";

beforeAll(() => initTheme("dark", false));
afterEach(() => setCallbackActivityReporter(undefined));

function sessionWithTask(title: string): object {
	const session = {};
	const record = { title } as unknown as TaskRecord;
	bindOwnerTaskStore(session, {
		getTask: (id: TaskId) => (id === "task-1" ? record : undefined),
	} as unknown as OwnerTaskStore);
	return session;
}

const probe: ToolDefinition = {
	name: "probe",
	label: "Probe",
	description: "probe",
	parameters: Type.Object({}),
	execute: async () => ({ content: [], details: {} }),
	renderCall: (_args, _theme, context) =>
		new Text(`Probe(${context.getTaskRecord?.("task-1" as TaskId)?.title ?? "no task"})`, 0, 0),
};

function rows(lines: readonly string[]): string {
	return lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
}

test("a subagent or stage view gives tool renderers its own session's task records (#5350)", () => {
	const chatSession = sessionWithTask("child task");
	const options: ChatSessionHostOpts = {
		style: {
			dim: String,
			text: String,
			textMuted: String,
			accent: String,
			accentBold: String,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: String,
			selectList: {
				selectedPrefix: String,
				selectedText: String,
				description: String,
				scrollInfo: String,
				noMatch: String,
			},
		},
		requestRender: () => {},
		getCwd: () => "/workspace",
		getChatBoxSession: () => chatSession as ReturnType<NonNullable<ChatSessionHostOpts["getChatBoxSession"]>>,
		getChatRenderSettings: () => ({ getToolDefinition: (name) => (name === "probe" ? probe : undefined) }),
	};
	const host = new ChatSessionHost(options);
	try {
		host.applyAgentEvent({ type: "tool_execution_start", toolCallId: "p", toolName: "probe", args: {} } as never);
		assert.match(rows(host.renderBody(80, 20)), /Probe\(child task\)/);
	} finally {
		host.dispose();
	}
});

test("the main chat gives live and replayed tool renderers the session's task records (#5350)", async () => {
	const session = sessionWithTask("main task");
	const chatContainer = {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const mode = {
		isInitialized: true,
		programStatus: { handleEvent: vi.fn() },
		footer: { invalidate: vi.fn() },
		chatContainer,
		pendingTools: new Map(),
		toolOutputExpanded: false,
		outputPad: 1,
		session,
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => 80 },
		sessionManager: { getCwd: () => "/workspace" },
		getRegisteredToolDefinition: (name: string) => (name === "probe" ? probe : undefined),
		ui: { requestRender: vi.fn() },
		maybeShowInstallChangeWarning: vi.fn(),
	};
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: object,
		event: object,
	) => Promise<void>;
	await handleEvent.call(mode, { type: "tool_execution_start", toolCallId: "p", toolName: "probe", args: {} });
	const live = mode.pendingTools.get("p") as { render(width: number): string[] };
	assert.match(rows(live.render(80)), /Probe\(main task\)/);
	const options = Reflect.get(InteractiveMode.prototype, "chatMessageRenderOptions") as (this: object) => {
		getTaskRecord?: (taskId: TaskId) => TaskRecord | undefined;
	};
	const getTaskRecord = options.call({
		...mode,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "",
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
		settingsManager: { ...mode.settingsManager, getLatexRenderingEnabled: () => true },
	}).getTaskRecord;
	const replayed = renderChatMessageEntry(
		{ role: "tool", kind: "tool", toolName: "probe", toolCallId: "p", args: {}, isPartial: true },
		{ ui: mode.ui, cwd: "/workspace", getToolDefinition: mode.getRegisteredToolDefinition, getTaskRecord },
	);
	assert.match(rows(replayed.render(80)), /Probe\(main task\)/);
});

test("the isolated engine renders tool rows against its bound session's task records (#5350)", async () => {
	const session = sessionWithTask("engine task");
	const frames: string[][] = [];
	setCallbackActivityReporter({ started() {}, finished() {} });
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line.trim());
		if (message?.type === "engine_custom_frame") frames.push(message.lines);
	});
	Object.assign(session, {
		extensionRunner: { resolveToolRenderers: () => probe },
		getToolDefinition: () => probe,
		sessionManager: { getCwd: () => "/workspace" },
	});
	service.bindSession(session as AgentSession);
	try {
		service.handleLine(
			serializeInteractiveEngineFrame({
				type: "engine_tool_render",
				componentId: "row",
				requestId: 1,
				width: 80,
				toolName: "probe",
				toolCallId: "p",
				args: {},
				executionStarted: true,
				argsComplete: true,
				isPartial: true,
				expanded: false,
				showImages: false,
				imageWidthCells: 60,
				outputPad: 1,
			}).trim(),
		);
		const deadline = Date.now() + 10_000;
		while (frames.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.match(rows(frames[0] ?? []), /Probe\(engine task\)/);
	} finally {
		service.dispose();
	}
});
