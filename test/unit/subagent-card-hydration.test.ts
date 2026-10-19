import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ToolDefinition, ToolRenderers } from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { ModelSingleResponse, TaskId, WaitId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import {
	chatEntriesFromAgentMessages,
	renderChatMessageEntry,
} from "../../packages/coding-agent/src/modes/interactive/components/index.js";
import { attachInteractiveEngineResourceExtensionRefresh } from "../../packages/coding-agent/src/modes/interactive/interactive-startup.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineRenderService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-render-service.js";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { RemoteToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive-engine/remote-renderer.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import {
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "../../packages/subagents/src/extension/tool-rendering.js";
import { bindSubagentChildCards } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentParamsLike } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { taskToolResult } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type {
	Details,
	SubagentRunControlChild,
	SubagentRunControlDetails,
} from "../../packages/subagents/src/shared/types.js";
import type { SubagentResultRenderState } from "../../packages/subagents/src/tui/render.js";
import { sleep } from "../helpers/runtime.js";

const HYDRATION_WAIT_MS = 5_000;

const definition: ToolDefinition<typeof SubagentParams, Details, SubagentResultRenderState> = {
	name: "subagent",
	label: "Subagent",
	description: "Subagent hydration fixture",
	parameters: SubagentParams,
	execute: async () => {
		throw new Error("Rendering must not execute the tool");
	},
	renderCall: (args, theme, context) => renderSubagentToolCall(args as SubagentParamsLike, theme, context),
	renderResult: renderSubagentToolResult,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class TranscriptBuilder {
	private calls = 0;
	constructor(
		readonly manager: SessionManager,
		readonly cwd: string,
	) {}

	async call(
		args: SubagentParamsLike | { action: "kill"; id: string },
		result: { content: string; details: Details; isError?: boolean },
	) {
		const id = `call-${++this.calls}`;
		await this.manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "subagent", arguments: args as Record<string, string> }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await this.manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "subagent",
			content: [{ type: "text", text: result.content }],
			details: JSON.parse(JSON.stringify(result.details)),
			isError: result.isError === true,
			timestamp: Date.now(),
		});
	}

	async launch(agent: string, taskId: string) {
		const response: ModelSingleResponse = {
			kind: "admitted",
			observation: {
				kind: "yielded",
				taskId: taskId as TaskId,
				waitId: `wait-${taskId}` as WaitId,
				reason: "explicit",
			},
		};
		const launched = taskToolResult(response);
		await this.call(
			{ agent, task: `task for ${agent}` },
			{
				content: "launched",
				details: { ...launched.details, ownerSessionId: this.manager.getSessionId() },
			},
		);
	}

	async record(record: Omit<SubagentChildRecord, "version" | "owner" | "cwd" | "index" | "agent">) {
		const full: SubagentChildRecord = {
			version: 1,
			index: 0,
			agent: record.runId,
			cwd: this.cwd,
			owner: { kind: "session", sessionId: this.manager.getSessionId() },
			...record,
		};
		await this.manager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, full);
	}

	async runControl(
		action: SubagentRunControlDetails["action"],
		id: string,
		text: string,
		children: SubagentRunControlChild[],
		isError = false,
	) {
		await this.call(
			{ action, id },
			{
				content: text,
				isError,
				details: { mode: "management", results: [], runControl: { action, children } },
			},
		);
	}
}

function child(childId: string, state: SubagentRunControlChild["state"], taskId: string): SubagentRunControlChild {
	const [runId = childId] = childId.split(":");
	return { childId, runId, index: 0, agent: runId, state, taskId };
}

/** Rebuild a saved session the way `/resume` and `atomic --session` do, and render each subagent card. */
function rebuildCards(manager: SessionManager, expanded = false): string[] {
	const entries = chatEntriesFromAgentMessages(manager.buildSessionContext().messages as AgentMessage[]);
	return entries
		.filter((entry) => entry.kind === "tool")
		.map((entry) =>
			stripVTControlCharacters(
				renderChatMessageEntry(entry, {
					ui: { requestRender() {} },
					cwd: process.cwd(),
					toolOutputExpanded: expanded,
					getToolDefinition: (name) => (name === "subagent" ? definition : undefined),
				})
					.render(140)
					.join("\n"),
			)
				.replace(/\s+/g, " ")
				.trim(),
		);
}

async function eventually(read: () => string, expected: RegExp): Promise<string> {
	const deadline = Date.now() + HYDRATION_WAIT_MS;
	let last = read();
	while (!expected.test(last) && Date.now() < deadline) {
		await sleep(10);
		last = read();
	}
	assert.match(last, expected);
	return last;
}

test("a rebuilt session hydrates every background launch card from its child records (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const t = new TranscriptBuilder(manager, process.cwd());
	const states: Array<[string, Partial<SubagentChildRecord>, RegExp]> = [
		["hyrun", { state: "running" }, /∀ Running in background/],
		["hypause", { state: "terminal", terminalStatus: "paused" }, /‖ Paused \(resumable\)/],
		["hyquit", { state: "terminal", terminalStatus: "quit" }, /■ Quit \(resumable\)/],
		["hydone", { state: "terminal", terminalStatus: "ok" }, /✓ Completed/],
		["hyfail", { state: "terminal", terminalStatus: "error" }, /✗ Failed/],
		["hykill", { state: "terminal", terminalStatus: "killed" }, /✗ Terminal · killed/],
		["hygone", { state: "terminal", terminalStatus: "gone" }, /✗ Terminal · gone after a restart/],
		["hystage", { state: "terminal", terminalStatus: "stage-closed" }, /✗ Terminal · its workflow stage ended/],
	];
	for (const [runId] of states) {
		await t.launch(runId, `task-${runId}`);
		await t.record({ childId: `${runId}:0`, runId, state: "running", taskId: `task-${runId}` });
	}
	for (const [runId, record] of states)
		if (record.state === "terminal")
			await t.record({ childId: `${runId}:0`, runId, taskId: `task-${runId}`, state: "terminal", ...record });

	bindSubagentChildCards({ sessionManager: manager });
	const cards = rebuildCards(manager);
	assert.equal(cards.length, states.length);
	states.forEach(([runId, , expected], index) => {
		assert.match(cards[index]!, expected, `${runId}: ${cards[index]}`);
		assert.doesNotMatch(cards[index]!, /Launched in background|Stopped/, `${runId} is not a launch-time snapshot`);
	});
	await store.close();
});

test("a resumed child continues in its original card and the run-control calls replay as compact results (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyres", "task-hyres-1");
	await t.record({ childId: "hyres:0", runId: "hyres", state: "running", taskId: "task-hyres-1" });
	await t.runControl("pause", "hyres:0", "Paused hyres", [child("hyres:0", "paused", "task-hyres-1")]);
	await t.record({
		childId: "hyres:0",
		runId: "hyres",
		state: "terminal",
		terminalStatus: "paused",
		taskId: "task-hyres-1",
	});
	await t.call(
		{ action: "kill", id: "hyres:0" },
		{
			content: 'The subagent action "kill" was removed. Use { action: "quit", id } to stop a child gracefully.',
			details: {} as Details,
			isError: true,
		},
	);
	await t.runControl("resume", "hyres:0", "Resumed hyres", [child("hyres:0", "running", "task-hyres-2")]);
	await t.record({ childId: "hyres:0", runId: "hyres", state: "running", taskId: "task-hyres-2" });
	await t.runControl("quit", "hyres:0", "Quit hyres", [child("hyres:0", "quit", "task-hyres-2")]);
	await t.record({
		childId: "hyres:0",
		runId: "hyres",
		state: "terminal",
		terminalStatus: "quit",
		taskId: "task-hyres-2",
	});
	await t.runControl(
		"resume",
		"hyres:9",
		"Unknown subagent 'hyres:9': this session launched no such child.",
		[],
		true,
	);
	await t.runControl("resume", "hyres:0", "Resumed hyres", [child("hyres:0", "running", "task-hyres-3")]);
	await t.record({ childId: "hyres:0", runId: "hyres", state: "running", taskId: "task-hyres-3" });
	await t.record({
		childId: "hyres:0",
		runId: "hyres",
		state: "terminal",
		terminalStatus: "ok",
		taskId: "task-hyres-3",
	});

	bindSubagentChildCards({ sessionManager: manager });
	const [launch, pause, kill, resume, quit, unknown, resumeAgain, ...rest] = rebuildCards(manager, true);
	assert.equal(rest.length, 0);
	assert.match(launch!, /✓ Completed · resumed/);
	assert.match(launch!, /task-hyres-3/, "the original card follows the child's latest task");
	assert.match(pause!, /subagent pause hyres:0 ‖ Paused · hyres/);
	assert.match(kill!, /✗ The subagent action "kill" was removed\. Use \{ action: "quit", id \}/);
	assert.match(resume!, /▶ Resumed · hyres hyres:0 · task-hyres-2 continues in its original launch card/);
	assert.match(quit!, /■ Quit \(resumable\) · hyres/);
	assert.match(unknown!, /✗ Unknown subagent 'hyres:9'/);
	assert.match(resumeAgain!, /▶ Resumed · hyres/);
	const showingChildState = [launch, pause, kill, resume, quit, unknown, resumeAgain].filter((card) =>
		/Completed|Running in background|Launched in background/.test(card!),
	);
	assert.deepEqual(showingChildState, [launch], "only the original card shows the child, once");
	await store.close();
});

test("an expanded launch card shows the child's own saved transcript (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	await childSession.appendMessage({ role: "user", content: "Audit the parser", timestamp: Date.now() });
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Parser audit is half done" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "aborted",
		timestamp: Date.now(),
	});
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hytx", "task-hytx");
	await t.record({
		childId: "hytx:0",
		runId: "hytx",
		state: "terminal",
		terminalStatus: "paused",
		taskId: "task-hytx",
		childSessionId: childSession.getSessionId(),
	});

	bindSubagentChildCards({ sessionManager: manager });
	assert.doesNotMatch(rebuildCards(manager, false)[0]!, /Audit the parser/, "collapsed cards stay compact");
	const expanded = await eventually(() => rebuildCards(manager, true)[0]!, /Parser audit is half done/);
	assert.match(expanded, /‖ Paused \(resumable\)[\s\S]*│ › Audit the parser │ Parser audit is half done/);
	await store.close();
});

test("a workflow stage transcript hydrates its launch cards from the stage session's records (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const parent = await SessionManager.create(store, process.cwd());
	const stage = await SessionManager.create(store, process.cwd());
	const t = new TranscriptBuilder(stage, process.cwd());
	await t.launch("hystg", "task-hystg");
	await t.record({ childId: "hystg:0", runId: "hystg", state: "running", taskId: "task-hystg" });
	await t.record({
		childId: "hystg:0",
		runId: "hystg",
		state: "terminal",
		terminalStatus: "stage-closed",
		taskId: "task-hystg",
	});
	bindSubagentChildCards({ sessionManager: parent });

	const identity = (text: string): string => text;
	const host = new ChatSessionHost({
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		},
		getChatRenderSettings: () => ({
			getToolDefinition: (name: string) => (name === "subagent" ? definition : undefined),
		}),
	});
	try {
		assert.equal(await host.loadSession(store, stage.getSessionId()), true);
		const body = () => stripVTControlCharacters(host.renderBody(140, 200).join("\n")).replace(/\s+/g, " ");
		const text = await eventually(body, /✗ Terminal · its workflow stage ended/);
		assert.doesNotMatch(text, /Launched in background/);
	} finally {
		host.dispose();
		await store.close();
	}
});

test("atomic --session hydrates launch cards once the isolated engine loads the subagent renderer (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyiso", "task-hyiso");
	await t.record({ childId: "hyiso:0", runId: "hyiso", state: "running", taskId: "task-hyiso" });
	await t.record({
		childId: "hyiso:0",
		runId: "hyiso",
		state: "terminal",
		terminalStatus: "paused",
		taskId: "task-hyiso",
	});
	bindSubagentChildCards({ sessionManager: manager });

	const host = isolatedEngineHost(manager, undefined);
	const body = () => stripVTControlCharacters(host.chat.render(140).join("\n")).replace(/\s+/g, " ");
	try {
		await eventually(body, /"agent": "hyiso"/);
		host.loadSubagentRenderer();
		const text = await eventually(body, /‖ Paused \(resumable\)/);
		assert.doesNotMatch(text, /Launched in background|"agent": "hyiso"/);
	} finally {
		host.dispose();
		await store.close();
	}
});

test("atomic --session shows the child's saved transcript in an expanded launch card without another redraw (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	await childSession.appendMessage({ role: "user", content: "Index the changelog", timestamp: Date.now() });
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Changelog index is partway done" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "aborted",
		timestamp: Date.now(),
	});
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyisotx", "task-hyisotx");
	await t.record({
		childId: "hyisotx:0",
		runId: "hyisotx",
		state: "terminal",
		terminalStatus: "paused",
		taskId: "task-hyisotx",
		childSessionId: childSession.getSessionId(),
	});
	bindSubagentChildCards({ sessionManager: manager });

	const host = isolatedEngineHost(manager, definition as ToolRenderers);
	try {
		await eventually(host.painted, /‖ Paused \(resumable\)/);
		for (const card of host.cards) card.setExpanded(true);
		const expanded = await eventually(host.painted, /Changelog index is partway done/);
		assert.match(expanded, /‖ Paused \(resumable\)[\s\S]*│ › Index the changelog │ Changelog index is partway done/);
	} finally {
		host.dispose();
		await store.close();
	}
});

test("atomic --session redraws a resumed child's original card in place when its record changes (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyisores", "task-hyisores-1");
	await t.record({
		childId: "hyisores:0",
		runId: "hyisores",
		state: "terminal",
		terminalStatus: "paused",
		taskId: "task-hyisores-1",
	});
	bindSubagentChildCards({ sessionManager: manager });

	const host = isolatedEngineHost(manager, definition as ToolRenderers);
	try {
		await eventually(host.painted, /‖ Paused \(resumable\)/);
		createSubagentChildRecordSink(
			{
				appendEntry: async (type, data) => {
					await manager.appendCustomEntry(type, data);
				},
			},
			{ sessionManager: manager },
		).record({
			runId: "hyisores",
			index: 0,
			agent: "hyisores",
			cwd: process.cwd(),
			state: "running",
			taskId: "task-hyisores-2",
		});
		const resumed = await eventually(host.painted, /∀ Running in background · resumed/);
		assert.doesNotMatch(resumed, /Paused/);
		assert.equal(host.cards.length, 1);
	} finally {
		host.dispose();
		await store.close();
	}
});

test("/resume redraws a resumed child's original card in place when its record changes (#3760)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyresume", "task-hyresume-1");
	await t.record({
		childId: "hyresume:0",
		runId: "hyresume",
		state: "terminal",
		terminalStatus: "paused",
		taskId: "task-hyresume-1",
	});
	bindSubagentChildCards({ sessionManager: manager });

	let painted = "";
	const [entry] = chatEntriesFromAgentMessages(manager.buildSessionContext().messages as AgentMessage[]).filter(
		(entry) => entry.kind === "tool",
	);
	const card = renderChatMessageEntry(entry!, {
		ui: {
			requestRender() {
				painted = stripVTControlCharacters(card.render(140).join("\n")).replace(/\s+/g, " ");
			},
		},
		cwd: process.cwd(),
		toolOutputExpanded: false,
		getToolDefinition: (name) => (name === "subagent" ? definition : undefined),
	});
	assert.match(stripVTControlCharacters(card.render(140).join("\n")), /‖ Paused \(resumable\)/);
	createSubagentChildRecordSink(
		{
			appendEntry: async (type, data) => {
				await manager.appendCustomEntry(type, data);
			},
		},
		{ sessionManager: manager },
	).record({
		runId: "hyresume",
		index: 0,
		agent: "hyresume",
		cwd: process.cwd(),
		state: "running",
		taskId: "task-hyresume-2",
	});
	assert.match(painted, /∀ Running in background · resumed/);
	await store.close();
});

/**
 * A host transcript of remote subagent cards drawn by a real engine render service, the way `atomic --session`
 * shows a restored session. `painted` is the last frame the host drew, and the host draws only when a card
 * requests it, as the terminal UI does.
 */
function isolatedEngineHost(manager: SessionManager, subagentRenderer: ToolRenderers | undefined) {
	const runner = (subagent: ToolRenderers | undefined) => ({
		resolveToolRenderers: (name: string, base: () => ToolRenderers | undefined) =>
			name === "subagent" ? subagent : base(),
	});
	const engineSession = {
		extensionRunner: runner(subagentRenderer),
		getToolDefinition: () => undefined,
		sessionManager: manager,
	};
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line.trim());
		if (message) for (const listener of [...listeners]) listener(message);
	});
	service.bindSession(engineSession as unknown as AgentSession);
	let resourcesLoaded = () => {};
	const runtime = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype), {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		sendEngineCommand: (command: InteractiveEngineCommand) =>
			service.handleLine(serializeInteractiveEngineFrame(command).trim()),
		onResourceExtensionsChanged: (listener: () => void) => {
			resourcesLoaded = listener;
			return () => {};
		},
	}) as IsolatedInteractiveRuntime;
	const chat = new Container();
	let painted = "";
	let paintQueued = false;
	const requestRender = () => {
		if (paintQueued) return;
		paintQueued = true;
		setTimeout(() => {
			paintQueued = false;
			painted = stripVTControlCharacters(chat.render(140).join("\n")).replace(/\s+/g, " ");
		}, 0);
	};
	attachInteractiveEngineResourceExtensionRefresh({
		runtimeHost: runtime,
		chatContainer: chat,
		resourceDisclosureContainer: new Container(),
		ui: { requestRender } as unknown as TUI,
	} as unknown as Parameters<typeof attachInteractiveEngineResourceExtensionRefresh>[0]);
	const cards: RemoteToolExecutionComponent[] = [];
	for (const entry of chatEntriesFromAgentMessages(manager.buildSessionContext().messages as AgentMessage[])) {
		if (entry.kind !== "tool") continue;
		const card = new RemoteToolExecutionComponent(
			entry.toolName,
			entry.toolCallId,
			entry.args,
			{},
			runtime,
			requestRender,
		);
		if (entry.result) card.updateResult(entry.result, entry.isPartial ?? false);
		chat.addChild(card);
		cards.push(card);
	}
	return {
		chat,
		cards,
		painted: () => painted,
		loadSubagentRenderer() {
			engineSession.extensionRunner = runner(definition as ToolRenderers);
			resourcesLoaded();
		},
		dispose: () => service.dispose(),
	};
}
