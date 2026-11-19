import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, beforeAll, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { ChatSessionHost } from "../../packages/coding-agent/src/index.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { releaseStartupChatOutput } from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
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
