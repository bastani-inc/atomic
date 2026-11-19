import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { Container, type TUI } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { exportSessionToHtml } from "../../packages/coding-agent/src/core/export-html/index.js";
import { createToolHtmlRenderer } from "../../packages/coding-agent/src/core/export-html/tool-renderer.js";
import type { ToolDefinition, ToolRenderers } from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	TASK_COMPLETION_MESSAGE_TYPE,
	type TaskCompletionEnvelope,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type {
	ModelSingleResponse,
	OperationId,
	OwnerId,
	Sequence,
	TaskId,
	WaitId,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	hasTaskTranscript,
	loadTaskTranscript,
	noticeTranscriptQuery,
	registerSavedTaskTranscripts,
	type TaskTranscriptQuery,
} from "../../packages/coding-agent/src/core/tasks/saved-transcripts.js";
import { codemodeRenderers } from "../../packages/coding-agent/src/extensions/codemode/renderer.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import {
	chatEntriesFromAgentMessages,
	renderChatMessageEntry,
} from "../../packages/coding-agent/src/modes/interactive/components/index.js";
import {
	completionNoticeFromDetails,
	TaskCompletionMessage,
} from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.ts";
import { attachInteractiveEngineResourceExtensionRefresh } from "../../packages/coding-agent/src/modes/interactive/interactive-startup.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
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
import {
	bindSubagentChildCards,
	savedSubagentTranscripts,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
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

/** How often an expanded card of a running child reads its transcript again (the card state's refresh interval). */
const RUNNING_TRANSCRIPT_REFRESH_MS = 1_000;

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

/** Rebuild a saved session the way `/resume` and `atomic --session` do: one component per subagent card. */
function buildCards(
	manager: SessionManager,
	expanded = false,
	otherTools: (name: string) => ToolRenderers | undefined = () => undefined,
): ReturnType<typeof renderChatMessageEntry>[] {
	const entries = chatEntriesFromAgentMessages(manager.buildSessionContext().messages as AgentMessage[]);
	return entries
		.filter((entry) => entry.kind === "tool")
		.map((entry) =>
			renderChatMessageEntry(entry, {
				ui: { requestRender() {} },
				cwd: process.cwd(),
				toolOutputExpanded: expanded,
				getToolDefinition: (name) => (name === "subagent" ? definition : otherTools(name)),
			}),
		);
}

/** Draw each card as it shows now. */
function paint(cards: readonly ReturnType<typeof renderChatMessageEntry>[]): string[] {
	return cards.map((card) => stripVTControlCharacters(card.render(140).join("\n")).replace(/\s+/g, " ").trim());
}

/** Rebuild a saved session the way `/resume` and `atomic --session` do, and render each subagent card. */
function rebuildCards(manager: SessionManager, expanded = false): string[] {
	return paint(buildCards(manager, expanded));
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
		["hyrun", { state: "running" }, /∀ Agent\(hyrun · task for hyrun\) ⎿ Running/],
		[
			"hypause",
			{ state: "terminal", terminalStatus: "paused" },
			/⏸ Agent\(hypause · task for hypause\) ⎿ Paused · awaiting resume/,
		],
		[
			"hyquit",
			{ state: "terminal", terminalStatus: "quit" },
			/⏸ Agent\(hyquit · task for hyquit\) ⎿ Quit · paused · awaiting resume/,
		],
		[
			"hystagepause",
			{ state: "terminal", terminalStatus: "stage-paused" },
			/⏸ Agent\(hystagepause · task for hystagepause\) ⎿ Paused with its workflow stage · awaiting resume/,
		],
		["hydone", { state: "terminal", terminalStatus: "ok" }, /● Agent\(hydone · task for hydone\) ⎿ Done/],
		["hyfail", { state: "terminal", terminalStatus: "error" }, /✗ Agent\(hyfail · task for hyfail\) ⎿ Failed/],
		["hykill", { state: "terminal", terminalStatus: "killed" }, /◼ Agent\(hykill · task for hykill\) ⎿ Stopped/],
		[
			"hygone",
			{ state: "terminal", terminalStatus: "gone" },
			/✗ Agent\(hygone · task for hygone\) ⎿ Failed · gone after a restart/,
		],
		[
			"hystage",
			{ state: "terminal", terminalStatus: "stage-closed" },
			/✗ Agent\(hystage · task for hystage\) ⎿ Failed · its workflow stage ended/,
		],
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
		assert.doesNotMatch(cards[index]!, /Launched in background/, `${runId} is not a launch-time snapshot`);
	});
	await store.close();
});

test("opening a fork does not replace the original session's newer child state with the fork's copied history (#3784)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const original = await SessionManager.create(store, process.cwd());
	const t = new TranscriptBuilder(original, process.cwd());
	await t.launch("forkedcard", "task-forkedcard");
	await t.record({ childId: "forkedcard:0", runId: "forkedcard", state: "running", taskId: "task-forkedcard" });
	const fork = await original.forkTo(process.cwd(), store);
	// The child completes in the original session after the fork point.
	await t.record({
		childId: "forkedcard:0",
		runId: "forkedcard",
		state: "terminal",
		terminalStatus: "ok",
		taskId: "task-forkedcard",
	});
	bindSubagentChildCards({ sessionManager: original });
	assert.match(rebuildCards(original)[0]!, /● Agent\(forkedcard · task for forkedcard\) ⎿ Done/);

	bindSubagentChildCards({ sessionManager: fork });
	assert.match(
		rebuildCards(original)[0]!,
		/● Agent\(forkedcard · task for forkedcard\) ⎿ Done/,
		"the original's card keeps its newer state",
	);
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
	assert.match(launch!, /● Agent\(hyres · task for hyres\) ⎿ Done/);
	assert.match(pause!, /Agent\(pause · hyres:0\) ⎿ ⏸ Paused · hyres/);
	assert.match(kill!, /✗ The subagent action "kill" was removed\. Use \{ action: "quit", id \}/);
	assert.match(resume!, /✓ Resumed · hyres hyres:0 · task-hyres-2 continues in its original launch card/);
	assert.match(quit!, /◼ Quit \(resumable\) · hyres/);
	assert.match(unknown!, /✗ Unknown subagent 'hyres:9'/);
	assert.match(resumeAgain!, /✓ Resumed · hyres/);
	const showingChildState = [launch, pause, kill, resume, quit, unknown, resumeAgain].filter((card) =>
		/⎿ (?:Running|Done|Failed|Stopped)\b/u.test(card!),
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
	const cards = buildCards(manager, true);
	const expanded = await eventually(() => paint(cards)[0]!, /Parser audit is half done/);
	assert.match(
		expanded,
		/⏸ Agent\(hytx · task for hytx\) ⎿ Paused · awaiting resume ⎿ Prompt Audit the parser ⎿ Tool calls \(none\) ⎿ Result Parser audit is half done/,
	);
	await store.close();
});

test("an expanded launch card draws the calls in the child's saved transcript expanded, a long codemode script whole (#5525)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	const code = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
	await childSession.appendMessage({ role: "user", content: "Script the audit", timestamp: Date.now() });
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "script", name: "codemode", arguments: { code } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await childSession.appendMessage({
		role: "toolResult",
		toolCallId: "script",
		toolName: "codemode",
		content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
		details: { calls: [] },
		isError: false,
		timestamp: Date.now(),
	});
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyscript", "task-hyscript");
	await t.record({
		childId: "hyscript:0",
		runId: "hyscript",
		state: "terminal",
		terminalStatus: "ok",
		taskId: "task-hyscript",
		childSessionId: childSession.getSessionId(),
	});

	bindSubagentChildCards({ sessionManager: manager });
	const cards = buildCards(manager, true, (name) => (name === "codemode" ? codemodeRenderers : undefined));
	// A large card is drawn a slice per render: the test renders until the end of the script is drawn.
	const expanded = await eventually(() => paint(cards)[0]!, /const v19 = 19; \)/);
	assert.match(expanded, /codemode\( const v0 = 0; .* const v19 = 19; \)/);
	assert.doesNotMatch(expanded, /\+\d+ lines/);
	await store.close();
});

/** The pre-rendered tool rows of an exported page, as text, by tool call id. */
function exportedToolRows(html: string): Map<string, { call: string; collapsed: string; expanded: string }> {
	const encoded = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
	const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
		renderedTools?: Record<string, { callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string }>;
	};
	const text = (value: string | undefined) =>
		(value ?? "")
			.replace(/<\/div>/g, " ")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/g, " ")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#039;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/\s+/g, " ")
			.trim();
	return new Map(
		Object.entries(data.renderedTools ?? {}).map(([id, rendered]) => [
			id,
			{
				call: text(rendered.callHtml),
				collapsed: text(rendered.resultHtmlCollapsed),
				expanded: text(rendered.resultHtmlExpanded),
			},
		]),
	);
}

test("an HTML export draws a finished background child's saved tool calls in its card, read before the page is written (#5525)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	const code = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
	await childSession.appendMessage({ role: "user", content: "Script the audit", timestamp: Date.now() });
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "script", name: "codemode", arguments: { code } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await childSession.appendMessage({
		role: "toolResult",
		toolCallId: "script",
		toolName: "codemode",
		content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
		details: { calls: [] },
		isError: false,
		timestamp: Date.now(),
	});
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyexport", "task-hyexport");
	await t.record({
		childId: "hyexport:0",
		runId: "hyexport",
		state: "terminal",
		terminalStatus: "ok",
		taskId: "task-hyexport",
		childSessionId: childSession.getSessionId(),
	});
	bindSubagentChildCards({ sessionManager: manager });
	const dir = mkdtempSync(join(tmpdir(), "atomic-card-export-"));
	try {
		const output = await exportSessionToHtml(manager, undefined, {
			outputPath: join(dir, "export.html"),
			toolRenderer: createToolHtmlRenderer({
				getToolRenderers: (name) =>
					name === "subagent" ? definition : name === "codemode" ? codemodeRenderers : undefined,
				theme,
				cwd: process.cwd(),
			}),
		});
		const card = exportedToolRows(readFileSync(output, "utf8")).get("call-1");
		assert.ok(card, "the card is pre-rendered");
		assert.match(card.expanded, /Tool calls ● codemode\( const v0 = 0; .* const v19 = 19; \)/, card.expanded);
		assert.doesNotMatch(card.expanded, /\(none\)/, card.expanded);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await store.close();
	}
});

/** A saved session whose finished background child ran a script, as a parent and the child's own session. */
async function finishedScriptChild(runId: string, taskId: string) {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	const code = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
	await childSession.appendMessage({ role: "user", content: `Script the ${runId} audit`, timestamp: Date.now() });
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "script", name: "codemode", arguments: { code } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await childSession.appendMessage({
		role: "toolResult",
		toolCallId: "script",
		toolName: "codemode",
		content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
		details: { calls: [] },
		isError: false,
		timestamp: Date.now(),
	});
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch(runId, taskId);
	await t.record({
		childId: `${runId}:0`,
		runId,
		state: "terminal",
		terminalStatus: "ok",
		taskId,
		task: `task for ${runId}`,
		childSessionId: childSession.getSessionId(),
	});
	return { store, manager };
}

/** The finished-task notice the parent's chat saved for the child, as an earlier process wrote it. */
function savedNotice(runId: string, taskId: string, launchId: string | undefined) {
	const envelope = {
		completionId: `completion-${taskId}-earlier-process`,
		ownerId: "owner-1-0" as OwnerId,
		taskId: taskId as TaskId,
		terminalSequence: "9" as Sequence,
		result: {
			kind: "completed" as const,
			output: { ownerId: "owner-1-0", taskId, artifactId: `output:${taskId}`, byteCount: "4", omittedRanges: [] },
		},
		display: false as const,
		taskKind: "agent" as const,
	} as unknown as TaskCompletionEnvelope;
	const notification = taskCompletionNotice(
		envelope,
		{
			kind: "agent",
			title: `task for ${runId}`,
			agentName: runId,
			model: undefined,
			thinking: undefined,
			...(launchId === undefined ? {} : { launchOperationId: launchId as OperationId }),
		},
		"Audit done.",
	);
	return {
		role: "custom",
		customType: TASK_COMPLETION_MESSAGE_TYPE,
		content: `Subagent ${runId} completed`,
		details: { ...envelope, notification },
		display: true,
		timestamp: Date.now(),
	};
}

/** The engine's drawing of an expanded notice, rendered again until `expected` shows or the wait runs out. */
async function engineNotice(manager: SessionManager, message: object, expected: RegExp): Promise<string> {
	const frames: string[] = [];
	const service = new EngineRenderService((line) => {
		const parsed = parseInteractiveEngineMessage(line.trim());
		if (parsed?.type === "engine_custom_frame") frames.push(stripVTControlCharacters(parsed.lines.join("\n")));
	});
	service.bindSession({
		extensionRunner: {
			getMessageRenderer: () => undefined,
			resolveToolRenderers: (name: string) => (name === "codemode" ? codemodeRenderers : undefined),
		},
		getToolDefinition: () => undefined,
		sessionManager: manager,
	} as unknown as AgentSession);
	let requestId = 0;
	const render = () =>
		service.handleLine(
			serializeInteractiveEngineFrame({
				type: "engine_message_render",
				componentId: "notice",
				requestId: ++requestId,
				width: 140,
				message: message as never,
				expanded: true,
				outputPad: 1,
			}).trim(),
		);
	try {
		return await eventually(() => {
			render();
			return (frames.at(-1) ?? "").replace(/\s+/g, " ");
		}, expected);
	} finally {
		service.dispose();
	}
}

test("after a restart, a finished subagent's notice shows the child's saved prompt and tool calls, as its launch card does (#5525)", async () => {
	initTheme("dark");
	const { store, manager } = await finishedScriptChild("hynotice", "task-1-0-1");
	const unregister = registerSavedTaskTranscripts(savedSubagentTranscripts(manager));
	try {
		bindSubagentChildCards({ sessionManager: manager });
		// No task of this process runs as task-1-0-1: the notice reads the child's own session, named by its record.
		const shown = await engineNotice(
			manager,
			savedNotice("hynotice", "task-1-0-1", "hynotice:0"),
			/const v19 = 19; \)/,
		);
		assert.match(
			shown,
			/Prompt Script the hynotice audit .*Tool calls ● codemode\( const v0 = 0; .* const v19 = 19; \) .*Result Audit done\./,
		);

		// A later process ran another child under the same task id: the notice names its own child, so it still shows it.
		const t = new TranscriptBuilder(manager, process.cwd());
		await t.record({
			childId: "hyother:0",
			runId: "hyother",
			state: "terminal",
			terminalStatus: "ok",
			taskId: "task-1-0-1",
		});
		bindSubagentChildCards({ sessionManager: manager });
		const named = await engineNotice(
			manager,
			savedNotice("hynotice", "task-1-0-1", "hynotice:0"),
			/const v19 = 19; \)/,
		);
		assert.match(named, /Prompt Script the hynotice audit/);
	} finally {
		unregister();
		await store.close();
	}
});

test("an older notice keeps its saved result whether one or several children used its number (#5525)", async () => {
	initTheme("dark");
	const { store, manager } = await finishedScriptChild("hyolder", "task-1-0-7");
	const older = savedNotice("hyolder", "task-1-0-7", undefined);
	await manager.appendCustomMessageEntry(older.customType, older.content, true, older.details);
	const unregister = registerSavedTaskTranscripts(savedSubagentTranscripts(manager));
	try {
		bindSubagentChildCards({ sessionManager: manager });
		const task = noticeTranscriptQuery(older.details.taskId, older.details.notification, manager.getSessionId());
		assert.equal(await loadTaskTranscript(undefined, task), undefined);
		const shown = await engineNotice(manager, older, /Audit done\./);
		assert.doesNotMatch(shown, /Prompt|Tool calls|codemode\(/);

		// A later process ran another child under the same task id: the notice cannot tell which one it is about.
		const t = new TranscriptBuilder(manager, process.cwd());
		await t.record({
			childId: "hyolder2:0",
			runId: "hyolder2",
			state: "terminal",
			terminalStatus: "ok",
			taskId: "task-1-0-7",
		});
		bindSubagentChildCards({ sessionManager: manager });
		assert.equal(await loadTaskTranscript(undefined, task), undefined);
		assert.equal(await engineNotice(manager, older, /Audit done\./), shown);
	} finally {
		unregister();
		await store.close();
	}
});

test("a legacy notice cannot read a different saved child's prompt through a reused task id (#5531)", async () => {
	const taskId = "task-reused-legacy";
	const { store, manager } = await finishedScriptChild("shapes-reader", taskId);
	const saved = savedNotice("shapes-reader", taskId, undefined);
	await manager.appendCustomMessageEntry(saved.customType, saved.content, true, saved.details);
	const unregister = registerSavedTaskTranscripts(savedSubagentTranscripts(manager));
	try {
		bindSubagentChildCards({ sessionManager: manager });
		const matching = { taskId, launchId: "shapes-reader:0" };
		assert.equal(hasTaskTranscript(undefined, { ...matching, ownerSessionId: manager.getSessionId() }), true);
		assert.equal(
			hasTaskTranscript(undefined, { ...matching, ownerSessionId: "another-owner" }),
			false,
			"another owner's records cannot supply the prompt",
		);
		for (const [agentName, subject] of [
			["shapes-reader", "task for shapes-reader"],
			["worker", "restart 0"],
			["worker", "task for shapes-reader"],
			["shapes-reader", "restart 0"],
		]) {
			const notification = saved.details.notification;
			const query = noticeTranscriptQuery(
				taskId,
				{ ...notification, agentName, line: { ...notification.line!, subject } },
				manager.getSessionId(),
			);
			assert.equal(hasTaskTranscript(undefined, query), false, "only the original notice preview is available");
			assert.equal(await loadTaskTranscript(undefined, query), undefined, "no other child's prompt or calls");
		}
	} finally {
		unregister();
		await store.close();
	}
});

// Two 0.9.89 processes wrote these notices to the same parent. Only the first launched a child.
// The fixture omits unrelated entries and replaces absolute paths; both completion envelopes are unchanged.
const legacyFixtures = new URL("../fixtures/task-completion-0.9.89/", import.meta.url);

test("a restarted SDK task with the same number, agent and title does not show the earlier child's file read (#5531)", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "atomic-old-notices-"));
	try {
		cpSync(legacyFixtures, dir, { recursive: true });
		const manager = await SessionManager.open(join(dir, "parent.jsonl"), dir, dir);
		bindSubagentChildCards({ sessionManager: manager });
		const unregister = registerSavedTaskTranscripts(savedSubagentTranscripts(manager));
		try {
			const notices = manager
				.getEntries()
				.filter((e) => e.type === "custom_message" && e.customType === "task-completion");
			assert.equal(notices.length, 2);
			const second = notices[1]!;
			assert.ok(second.type === "custom_message");
			const parsed = completionNoticeFromDetails(second.details);
			assert.ok(parsed);
			const task = noticeTranscriptQuery(parsed.taskId, parsed, manager.getSessionId());
			assert.equal(await loadTaskTranscript(undefined, task), undefined);
			const shown = await engineNotice(
				manager,
				{ ...second, role: "custom", timestamp: Date.parse(second.timestamp) },
				/Square task finished separately/,
			);
			assert.equal(shown.trim(), "✗ reviewer failed ⎿ Square task finished separately");
		} finally {
			unregister();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repainting 512 folded SDK notices after an unrelated append copies no parent history (#5531)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const writer = await SessionManager.create(store, process.cwd());
	// Repeat the SDK-only envelope from the 0.9.89 recording, with a different task number for each notice.
	const sdkLine = readFileSync(new URL("parent.jsonl", legacyFixtures), "utf8").trimEnd().split("\n").at(-1)!;
	for (let i = 0; i < 512; i++) {
		const entry = JSON.parse(sdkLine.replaceAll("task-1-0-0", `task-1-0-${i}`));
		await writer.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
	}
	const manager = await SessionManager.open(store, writer.getSessionId(), process.cwd());
	bindSubagentChildCards({ sessionManager: manager });
	const unregister = registerSavedTaskTranscripts(savedSubagentTranscripts(manager));
	try {
		const cards = manager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom_message") return [];
			const notice = completionNoticeFromDetails(entry.details);
			assert.ok(notice);
			return new TaskCompletionMessage(notice, false, {
				hasTranscript: (id, shown) =>
					hasTaskTranscript(undefined, noticeTranscriptQuery(id, shown, manager.getSessionId())),
			});
		});
		assert.equal(cards.length, 512);
		const copies = vi.spyOn(manager, "getEntries");
		const paint = () => cards.map((card) => card.render(100));
		const rows = paint();
		const coldCopies = copies.mock.calls.length;
		await manager.appendCustomEntry("unrelated", {});
		copies.mockClear();
		assert.deepEqual(paint(), rows);
		assert.equal(copies.mock.calls.length, 0, "repaint after unrelated append");
		assert.equal(coldCopies, 0, "first paint");
	} finally {
		unregister();
		await store.close();
	}
});

test("a later child with even the same number, agent and title cannot supply an earlier completion's prompt (#5531)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const taskId = "task-1-0-0";
	const earlier = savedNotice("worker", taskId, undefined);
	earlier.details.notification.status = "failed";
	earlier.details.notification.preview = "restart done";
	earlier.details.notification.line = { status: "failure", label: "Agent", outcome: "failed", subject: "restart 0" };
	await manager.appendCustomMessageEntry(earlier.customType, earlier.content, true, earlier.details);
	const child = await SessionManager.create(store, process.cwd());
	await child.appendMessage({ role: "user", content: "TASK B: Count the triangles", timestamp: Date.now() });
	await new TranscriptBuilder(manager, process.cwd()).record({
		childId: "later:0",
		runId: "worker",
		taskId,
		task: "restart 0",
		state: "terminal",
		terminalStatus: "released",
		childSessionId: child.getSessionId(),
	});
	bindSubagentChildCards({ sessionManager: manager });
	const unregister = registerSavedTaskTranscripts(savedSubagentTranscripts(manager));
	try {
		const parsed = completionNoticeFromDetails(earlier.details);
		assert.ok(parsed);
		const query = noticeTranscriptQuery(taskId, parsed, manager.getSessionId());
		assert.equal(
			await loadTaskTranscript(undefined, query),
			undefined,
			"the only matching child ran after this saved completion",
		);
		const shown = await engineNotice(manager, earlier, /restart done/);
		assert.match(shown, /worker failed.*restart done/i);
		assert.doesNotMatch(shown, /Prompt|TASK B|Tool calls/);
		// A later completion with the same labels still has no saved launch identity.
		const later = { ...earlier, details: { ...earlier.details, completionId: `later-${taskId}` } };
		await manager.appendCustomMessageEntry(later.customType, later.content, true, later.details);
		assert.equal(await engineNotice(manager, later, /restart done/), shown);
	} finally {
		unregister();
		await store.close();
	}
});

test("a notice whose task id this process reuses for another task reads the notice's own child, not the running task (#5525)", async () => {
	const loads: TaskTranscriptQuery[] = [];
	const stop = registerSavedTaskTranscripts({
		has: () => true,
		load: async (task) => {
			loads.push(task);
			return { entries: [] };
		},
	});
	try {
		const store = {
			resolveTask: () => ({ ok: true, value: {} }),
			getTask: () => ({ launchOperationId: "second:0", agentName: "second", title: "Second task" }),
		} as unknown as OwnerTaskStore;
		assert.equal(hasTaskTranscript(store, { taskId: "task-reused-7", launchId: "first:0" }), true);
		assert.deepEqual(await loadTaskTranscript(store, { taskId: "task-reused-7", launchId: "first:0" }), {
			entries: [],
		});
		// Even a source offering a transcript for every task cannot enrich an unidentified notice.
		const older = savedNotice("second", "task-reused-7", undefined).details.notification;
		const query = noticeTranscriptQuery(older.taskId, older);
		assert.equal(hasTaskTranscript(store, query), false);
		assert.equal(await loadTaskTranscript(store, query), undefined);
		assert.deepEqual(loads, [{ taskId: "task-reused-7", launchId: "first:0" }]);
	} finally {
		stop();
	}
});

test("an expanded card of a running child shows messages it saves after the card first read its transcript (#3760 run control)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const childSession = await SessionManager.create(store, process.cwd());
	await childSession.appendMessage({ role: "user", content: "Audit the lexer", timestamp: Date.now() });
	const t = new TranscriptBuilder(manager, process.cwd());
	await t.launch("hyrun", "task-hyrun");
	await t.record({
		childId: "hyrun:0",
		runId: "hyrun",
		state: "running",
		taskId: "task-hyrun",
		childSessionId: childSession.getSessionId(),
	});

	bindSubagentChildCards({ sessionManager: manager });
	const cards = buildCards(manager, true);
	await eventually(() => paint(cards)[0]!, /Audit the lexer/);
	await sleep(RUNNING_TRANSCRIPT_REFRESH_MS + 100);
	assert.match(
		paint(cards)[0]!,
		/Prompt Audit the lexer/,
		"a card keeps what it read while it reads the transcript again",
	);
	await childSession.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Lexer audit found two bugs" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const expanded = await eventually(() => paint(cards)[0]!, /Lexer audit found two bugs/);
	assert.match(expanded, /Prompt Audit the lexer ⎿ Tool calls \(none\) ⎿ Result Lexer audit found two bugs/);
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
		const text = await eventually(body, /✗ Agent\(hystg · task for hystg\) ⎿ Failed · its workflow stage ended/);
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
		await eventually(body, /subagent\(agent=hyiso · task=task for hyiso\)/);
		host.loadSubagentRenderer();
		const text = await eventually(body, /⏸ Agent\(hyiso · task for hyiso\) ⎿ Paused · awaiting resume/);
		assert.equal(text.match(/⏸ Agent\(hyiso · task for hyiso\)/g)?.length, 1);
		assert.doesNotMatch(text, /Launched in background|subagent\(agent=/);
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
		await eventually(host.painted, /⏸ Agent\(hyisotx · task for hyisotx\) ⎿ Paused · awaiting resume/);
		for (const card of host.cards) card.setExpanded(true);
		const expanded = await eventually(host.painted, /Changelog index is partway done/);
		assert.match(
			expanded,
			/⏸ Agent\(hyisotx · task for hyisotx\) ⎿ Paused · awaiting resume ⎿ Prompt Index the changelog ⎿ Tool calls \(none\) ⎿ Result Changelog index is partway done/,
		);
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
		await eventually(host.painted, /⏸ Agent\(hyisores · task for hyisores\) ⎿ Paused · awaiting resume/);
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
		const resumed = await eventually(host.painted, /∀ Agent\(hyisores · task for hyisores\) ⎿ Running/);
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
	assert.match(
		stripVTControlCharacters(card.render(140).join("\n")),
		/⏸ Agent\(hyresume · task for hyresume\)\s+⎿\s+Paused · awaiting resume/,
	);
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
	assert.match(painted, /∀ Agent\(hyresume · task for hyresume\) ⎿ Running/);
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
		onGenerationEnded: () => () => {},
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
