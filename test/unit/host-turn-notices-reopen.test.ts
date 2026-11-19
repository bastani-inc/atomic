import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, getModel } from "@bastani/atomic-ai/compat";
import { Text } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { HOST_NOTICE_TYPE } from "../../packages/coding-agent/src/core/host-notices.ts";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.ts";
import { ChatSessionHost } from "../../packages/coding-agent/src/index.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createHarnessWithExtensions } from "../../packages/coding-agent/test/test-harness.ts";
import { editorTheme, plainStyle } from "./chat-session-host-working-lifecycle-fixture.ts";

const WIDTH = 100;
const RETRY_FAILED = "Error: Retry failed after 1 attempts: overloaded_error";

beforeAll(() => initTheme("dark", false));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A session saved in a temporary directory whose next request fails until its one retry is spent. */
async function failedRetrySession(): Promise<{ harness: Harness; reopen(): Promise<SessionManager> }> {
	const root = mkdtempSync(join(tmpdir(), "host-turn-notices-reopen-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "sessions");
	const manager = await SessionManager.create(root, dir);
	const harness = await createHarness({
		sessionManager: manager,
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
	});
	cleanups.push(() => harness.cleanup());
	const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
	harness.setResponses([overloaded(), overloaded()]);
	return { harness, reopen: () => SessionManager.open(manager.getSessionFile()!, dir, root) };
}

function visibleRows(lines: readonly string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line).trimEnd()).filter((line) => line.trim() !== "");
}

function count(rows: readonly string[], text: string): number {
	return rows.filter((row) => row.includes(text)).length;
}

function mainChat(sessionManager: SessionManager, liveSession?: Harness["session"]): InteractiveMode {
	const settingsManager = SettingsManager.inMemory();
	const session = liveSession ?? {
		settingsManager,
		sessionManager,
		modelRuntime: { findModel: () => undefined, getAllModels: () => [] },
		resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
		extensionRunner: {
			getMarkdownTransformers: () => [],
			getEntryRenderer: () => undefined,
			getMessageRenderer: () => undefined,
		},
		autoCompactionEnabled: false,
		state: { messages: [] },
		isStreaming: false,
		scopedModels: [],
		thinkingLevel: "off",
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getContextUsage: () => undefined,
		abortRetry: () => {},
	};
	const runtimeHost = {
		session,
		services: { agentDir: tmpdir() },
		diagnostics: [],
		modelFallbackMessage: undefined,
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	const terminal = new RecordingTerminal();
	terminal.columns = WIDTH;
	terminal.rows = 40;
	const mode = new InteractiveMode(runtimeHost, { terminal });
	(mode as unknown as { isInitialized: boolean }).isInitialized = true;
	releaseStartupChatOutput(mode);
	cleanups.push(() => mode.stop());
	return mode;
}

function chatRows(mode: InteractiveMode): string[] {
	return visibleRows(mode.chatContainer.render(WIDTH));
}

test("the main chat shows a final retry failure the same way live, rebuilt and after a resume (#5649)", async () => {
	const { harness, reopen } = await failedRetrySession();
	const live = mainChat(harness.sessionManager);
	harness.session.subscribe((event) => void live.handleEvent(event as never));

	await harness.session.prompt("hello");

	const liveRows = chatRows(live);
	assert.equal(count(liveRows, RETRY_FAILED), 1, liveRows.join("\n"));
	live.rebuildChatFromMessages();
	assert.deepEqual(chatRows(live), liveRows, "a chat rebuilt in place keeps the line");

	const resumed = mainChat(await reopen());
	resumed.renderInitialMessages();
	assert.deepEqual(chatRows(resumed), liveRows, "the resumed chat shows what the open chat showed");
});

test("a committed boundary precedes its hard-limit error exactly once in the open chat (#5649)", async () => {
	const harness = await createHarnessWithExtensions({
		contextWindow: 1_000,
		settings: { compaction: { enabled: true, reserveTokens: 200 } },
		responses: [
			{ toolCalls: [{ id: "one", name: "batch", args: {} }], usage: { input: 700, output: 20, totalTokens: 720 } },
		],
		baseToolsOverride: {
			batch: {
				name: "batch",
				label: "Batch",
				description: "Return one batch",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "x".repeat(480) }], details: {} }),
			},
		},
		extensionFactories: [
			(pi) => {
				let compacted = false;
				pi.on("session_before_compact", () => ({ compactedText: "[User]: retained" }));
				pi.on("session_compact", () => {
					compacted = true;
				});
				pi.on("context", (event) =>
					compacted
						? { messages: [...event.messages, { role: "user", content: "expanded ".repeat(2000), timestamp: 1 }] }
						: undefined,
				);
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	await harness.session.bindExtensions({});
	harness.session.setActiveToolsByName(["batch"]);
	harness.agent.convertToLlm = convertToLlm;
	const transform = harness.agent.transformContext;
	harness.agent.transformContext = async (rows, signal) => {
		const messages = await harness.session.extensionRunner.emitContext(rows);
		return transform ? transform(messages, signal) : messages;
	};
	const mode = mainChat(harness.sessionManager, harness.session);
	let rows: string[] = [];
	harness.session.subscribe((event) => {
		void mode.handleEvent(event as never);
		if (event.type === "message_end" && event.message.role === "custom") rows = chatRows(mode);
	});
	await harness.session.prompt(Array.from({ length: 24 }, (_, i) => `context line ${i}`).join("\n"));
	assert.ok(harness.eventsOfType("compaction_end")[0]?.result);
	assert.deepEqual(
		rows.flatMap((line) =>
			line.includes("hard input limit") ? ["error"] : line.includes("Context compacted") ? ["boundary"] : [],
		),
		["boundary", "error"],
	);
});

test("an extension keeps its registered renderer for an older atomic.notice entry (#5649)", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerEntryRenderer<{ text: string }>(
					"atomic.notice",
					(entry) => new Text(`LEGACY CARD: ${entry.data?.text}`, 0, 0),
				);
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	const mode = mainChat(harness.sessionManager, harness.session);
	await harness.sessionManager.appendCustomEntry("atomic.notice", {
		kind: "bookmark",
		level: "warning",
		text: "ext marker",
	});
	mode.renderInitialMessages();
	assert.deepEqual(
		chatRows(mode)
			.filter((line) => line.includes("ext marker"))
			.map((line) => line.trim()),
		["LEGACY CARD: ext marker"],
	);
});

function stageOrSubagentChat(): ChatSessionHost<never> {
	const host = new ChatSessionHost<never>({ style: plainStyle, editorTheme });
	cleanups.push(() => host.dispose());
	return host;
}

test("a stage or subagent chat shows a final retry failure live and again when it is reopened (#5649)", async () => {
	const { harness, reopen } = await failedRetrySession();
	const live = stageOrSubagentChat();
	harness.session.subscribe((event: AgentSessionEvent) => {
		live.applyAgentEvent(event as never);
	});

	await harness.session.prompt("hello");

	const liveRows = visibleRows(live.renderBody(WIDTH, 200));
	assert.equal(count(liveRows, RETRY_FAILED), 1, liveRows.join("\n"));

	const manager = await reopen();
	const reopened = stageOrSubagentChat();
	assert.equal(await reopened.loadSession(manager.getSessionStore(), manager.getSessionId()), true);
	assert.deepEqual(visibleRows(reopened.renderBody(WIDTH, 200)), liveRows);
});

test("an attached chat shows a long compaction failure once (#5649)", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => ({ compactedText: "retained" }));
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt("hello");
	const chat = stageOrSubagentChat();
	harness.session.subscribe((event) => {
		chat.applyAgentEvent(event as never);
	});
	harness.sessionManager.appendCompaction = async () => {
		throw new Error(`Storage failed: ${"失敗".repeat(2000)}`);
	};
	await assert.rejects(harness.session.compact(), /Storage failed/);
	assert.equal(count(visibleRows(chat.renderBody(WIDTH, 200)), "Storage failed"), 1);
});

test("a notice and a source-only shell result both survive a stage redraw, in order (#5649)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "host-notice-shell-"));
	cleanups.push(() => rmSync(cwd, { force: true, recursive: true }));
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: manager,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		settingsManager: SettingsManager.inMemory(),
		initialContextTransform: (rows) => rows.filter((row) => row.role !== "bashExecution"),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
	});
	cleanups.push(() => session.dispose());
	const chat = new ChatSessionHost({ style: plainStyle, editorTheme, getAgentSession: () => session });
	cleanups.push(() => chat.dispose());
	const covered = await manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const result = {
		compactedText: "cleared",
		tokensBefore: 100,
		firstKeptEntryId: null,
		form: "cleared" as const,
		promptVersion: 7 as const,
		parameters: { query: "" },
		stats: {
			linesBefore: 2,
			linesDeleted: 2,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 30,
			percentReduction: 70,
		},
	};
	await manager.appendCompaction("cleared", null, 100, { ...result, strategy: "verbatim-lines" }, undefined, covered);
	await manager.appendCustomEntry(HOST_NOTICE_TYPE, { level: "warning", text: "checkout unavailable" });
	session.refreshContext();
	await session.recordBashResult(
		"echo local",
		{ output: "source-only output", exitCode: 0, cancelled: false, truncated: false },
		{ persist: false, defer: false },
	);
	chat.applyAgentEvent({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false });
	const rows = visibleRows(chat.renderBody(WIDTH, 100));
	assert.deepEqual(
		rows.flatMap((line) =>
			line.includes("checkout unavailable") ? ["notice"] : line.includes("source-only output") ? ["shell"] : [],
		),
		["notice", "shell"],
	);
});

test("repeated storage failures keep only a window of notice bodies without losing their history (#5649)", async () => {
	const root = mkdtempSync(join(tmpdir(), "host-notice-window-"));
	cleanups.push(() => rmSync(root, { force: true, recursive: true }));
	const manager = await SessionManager.create(root, join(root, "sessions"));
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => ({ compactedText: "retained" }));
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt("hello");
	const model = manager.buildSessionContext().messages;
	let attempt = 0;
	manager.appendCompaction = async () => {
		throw new Error(`Storage failure ${++attempt}: ${"x".repeat(5000)}`);
	};
	const chat = stageOrSubagentChat();
	harness.session.subscribe((event) => {
		chat.applyAgentEvent(event as never);
	});
	for (let i = 0; i < 40; ++i) {
		await assert.rejects(harness.session.compact(), /Storage failure/);
		harness.events.length = 0;
	}
	await manager.branch(manager.getLeafId()!);
	assert.deepEqual(manager.buildSessionContext().messages, model);
	const resident = manager
		.getEntries()
		.flatMap((e) =>
			e.type === "custom" &&
			e.customType === HOST_NOTICE_TYPE &&
			typeof (e.data as { text?: unknown })?.text === "string"
				? [(e.data as { text: string }).text]
				: [],
		);
	const reopened = stageOrSubagentChat();
	assert.equal(await reopened.loadSession(manager.getSessionStore(), manager.getSessionId()), true);
	const router = createHistoryRouter({
		cwd: root,
		sessionStore: () => manager.getSessionStore(),
		workflows: () => undefined,
	});
	for (const host of [chat, reopened]) {
		host.renderBody(160, 2);
		const outcomes = host
			.entries()
			.flatMap((entry) =>
				entry.kind === "custom" && entry.message.customType === HOST_NOTICE_TYPE ? [entry.message] : [],
			);
		assert.equal(outcomes.length, 40, "each outcome still has its own row");
		const location = (outcomes[0]!.details as { location: string }).location;
		const stored = await router.read!(location);
		assert.ok(typeof stored === "string");
		assert.match(stored, /Storage failure 1: x{500}/, "the oldest outcome reads back in full on demand");
		const bodies = visibleRows(host.renderBody(160, 100)).filter((s) => s.includes("Storage failure"));
		assert.ok(
			bodies.some((s) => s.includes("Storage failure 40:")),
			"the most recent outcome remains visible",
		);
		const retained = host
			.entries()
			.filter(
				(entry) =>
					entry.kind === "custom" &&
					entry.message.customType === HOST_NOTICE_TYPE &&
					String(entry.message.content).includes("Storage failure"),
			);
		assert.ok(retained.length <= 2, `${retained.length} full notice bodies in the chat`);
	}
	assert.equal(resident.length, 40);
	assert.ok(
		resident.filter((text) => text !== "Compaction failed").reduce((total, s) => total + Buffer.byteLength(s), 0) <=
			384,
		"all variable manager previews share one byte budget",
	);
	const history: string[] = [];
	await manager.forEachStoredEntry(1, (entry) => {
		if (entry.type === "custom" && entry.customType === HOST_NOTICE_TYPE)
			history.push((entry.data as { text: string }).text);
	});
	assert.deepEqual(
		history.map((s) => Number(/Storage failure (\d+)/.exec(s)?.[1])),
		Array.from({ length: 40 }, (_, i) => i + 1),
	);
});

test("a main chat redrawn while the line is still being saved keeps it once (#5649)", async () => {
	const { harness } = await failedRetrySession();
	const manager = harness.sessionManager;
	const append = manager.appendCustomEntry.bind(manager);
	const saving = Promise.withResolvers<void>();
	manager.appendCustomEntry = (async (customType: string, data?: unknown) => {
		await saving.promise;
		return append(customType, data);
	}) as typeof manager.appendCustomEntry;
	const live = mainChat(manager, harness.session);
	const shown = Promise.withResolvers<void>();
	harness.session.subscribe((event) => {
		void live.handleEvent(event as never);
		if (event.type === "message_end" && event.message.role === "custom") shown.resolve();
	});

	const prompt = harness.session.prompt("hello");
	await shown.promise;
	const liveRows = chatRows(live);
	assert.equal(count(liveRows, RETRY_FAILED), 1, liveRows.join("\n"));
	live.rebuildChatFromMessages();
	assert.deepEqual(chatRows(live), liveRows, "redrawn while the line is being saved");
	saving.resolve();
	await prompt;
	live.rebuildChatFromMessages();
	assert.deepEqual(chatRows(live), liveRows, "redrawn once it is saved");
});
