import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, Usage } from "@bastani/atomic-ai/compat";
import { Container, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import { getSessionStats } from "../src/core/agent-session-export.ts";
import type { SessionStats } from "../src/core/agent-session-types.js";
import type { VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { UsageMeterComponent } from "../src/modes/interactive/components/footer.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import "../src/modes/interactive/interactive-slash-commands.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { EngineSessionStats } from "../src/modes/interactive-engine/engine-session-stats.js";
import { stripAnsi } from "./helpers/visible-text.js";

beforeAll(() => {
	initTheme(undefined, false);
	setKeybindings(new KeybindingsManager());
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: input * 3e-6,
			output: output * 15e-6,
			cacheRead: cacheRead * 0.3e-6,
			cacheWrite: cacheWrite * 3.75e-6,
			total,
		},
	};
}

function assistant(provider: string, model: string, used: Usage, responseModel?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `${provider}/${model}` }],
		api: "anthropic-messages",
		provider,
		model,
		...(responseModel ? { responseModel } : {}),
		usage: used,
		stopReason: "stop",
		timestamp: 1_000,
	};
}

const clear: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 7,
	parameters: { query: "" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 10,
		tokensAfter: 5,
		percentReduction: 50,
	},
	form: "cleared",
};

/**
 * A session whose cost is spread over models, tool results, a cache warm-up, a summary and an abandoned branch, most of
 * it before a clear: a prompt-cache miss and most of the cost are outside the window a resume keeps.
 */
async function writeSession(manager: SessionManager): Promise<string> {
	await manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
	await manager.appendMessage(assistant("anthropic", "claude-a", usage(1_000, 100, 0, 30_000, 0.33)));
	await manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "subagent",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 2,
		usage: usage(400, 40, 0, 0, 0.07),
	} as ToolResultMessage);
	await manager.appendUsage("cache_warm", "anthropic", "claude-a", usage(10, 1, 30_000, 0, 0.01));
	// 30,000 cached tokens re-billed: a miss in the history before the clear.
	const fork = await manager.appendMessage(
		assistant("anthropic", "claude-a", usage(50_000, 200, 0, 0, 0.33), "claude-a-20261101"),
	);
	await manager.appendMessage({ role: "user", content: "abandoned", timestamp: 3 });
	await manager.appendMessage(assistant("openai", "gpt-x", usage(2_000, 300, 1_000, 0, 0.33)));
	await manager.branch(fork);
	const kept = await manager.appendMessage({ role: "user", content: "kept", timestamp: 4 });
	await manager.appendMessage(assistant("openai", "gpt-y", usage(3_000, 50, 0, 0, 0.33)));
	await manager.appendCompaction("cleared", kept, 10, clear, usage(500, 20, 0, 0, 0.05));
	await manager.appendMessage({ role: "user", content: "after the clear", timestamp: 5 });
	await manager.appendMessage(assistant("anthropic", "claude-a", usage(100, 10, 3_000, 0, 0.33)));
	return manager.getSessionId();
}

const opens = ["import", "resume", "continue", "live clear"] as const;

const stores: Record<string, (directory: string) => Promise<SessionStore>> = {
	memory: async () => new MemorySessionStore(),
	jsonl: (directory) =>
		JsonlSessionStore.open(join(directory, "target"), { exactDirectory: true, scanExisting: false }),
	sql: async (directory) => {
		const database = await openNodeSqliteDatabase(join(directory, "target.sqlite"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(() => database.close());
		return store;
	},
};

/** The session's manager after an import, a resume or --continue, or the writer's own after its clear: the current
 * context window. */
async function openWindow(how: (typeof opens)[number], store: SessionStore, directory: string) {
	if (how === "import") {
		const source = await JsonlSessionStore.open(join(directory, "source"), {
			exactDirectory: true,
			scanExisting: false,
		});
		cleanups.push(() => source.close());
		const writer = await SessionManager.create(source, directory);
		await writeSession(writer);
		return SessionManager.importFromJsonl(writer.getSessionFile()!, directory, store);
	}
	const writer = await SessionManager.create(store, directory);
	const id = await writeSession(writer);
	if (how === "live clear") return writer;
	return how === "resume" ? SessionManager.open(store, id) : SessionManager.continueRecent(store, directory);
}

type Host = "in-process" | "isolated";

/** The session as /session sees it: the interactive host's session over `manager`, and, on the isolated host, the
 * engine's stats, which describe the same stored session. */
async function sessionOver(manager: SessionManager, host: Host, engine?: SessionStats) {
	const session = {
		sessionManager: manager,
		sessionFile: manager.getSessionFile(),
		sessionId: manager.getSessionId(),
		sessionName: undefined,
		isStreaming: false,
		state: { model: undefined },
		model: undefined,
		modelRuntime: { getModel: () => undefined, isUsingOAuth: () => false },
		getContextUsage: () => undefined,
		getSessionStats(): SessionStats {
			return getSessionStats.call(session as never);
		},
	};
	if (host === "isolated") {
		const stats = new EngineSessionStats({
			getGeneration: () => 1,
			requestInternal: async <T>() => (engine ?? session.getSessionStats()) as T,
		});
		stats.track(session as never);
		stats.refresh();
		await vi.waitFor(() => assert.ok(stats.current));
	}
	return session;
}

/** Run /session and return the block it adds, and the block once nothing more arrives in it. */
function runSessionCommand(session: Awaited<ReturnType<typeof sessionOver>>) {
	const chatContainer = new Container();
	const returned = InteractiveModeBase.prototype.handleSessionCommand.call({
		session,
		sessionManager: session.sessionManager,
		chatContainer,
		ui: { requestRender() {} },
	} as never);
	return { returned, text: () => stripAnsi(chatContainer.render(160).join("\n")) };
}

describe.each(Object.keys(stores))("/session on a %s store", (kind) => {
	for (const how of opens)
		for (const host of ["in-process", "isolated"] as const)
			test(`after ${how === "live clear" ? "a clear in the open session" : how} on the ${host} host lists the whole session's per-model cost, cache hit rate and wasted cache cost (#5554)`, async () => {
				const directory = mkdtempSync(join(tmpdir(), "atomic-session-info-"));
				cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
				const store = await stores[kind]!(directory);
				cleanups.push(() => store.close());
				const window = await openWindow(how, store, directory);
				const held = window.getEntries().length;
				assert.equal(window.hasFullHistory(), false);

				// What /session showed when it loaded every entry first (0.9.90).
				const whole = await SessionManager.open(store, window.getSessionId(), undefined, { history: "full" });
				assert.equal(whole.hasFullHistory(), true);
				const engine = getSessionStats.call({
					sessionManager: whole,
					sessionFile: window.getSessionFile(),
					sessionId: window.getSessionId(),
					getContextUsage: () => undefined,
				} as never);
				const expected = runSessionCommand(await sessionOver(whole, host, engine)).text();
				assert.match(expected, /openai\/gpt-x: \$0\.3300/);
				assert.match(expected, /Wasted Cache Cost: \$\S+ \(1 miss\)/);
				if (host === "in-process") assert.match(expected, /Cache Hit Rate: /);

				const shown = runSessionCommand(await sessionOver(window, host, engine));
				// The command returns at once; reading the older history never holds up the input line.
				assert.equal(shown.returned, undefined);
				assert.match(shown.text(), /Total: 1\.7800/);
				await vi.waitFor(() => assert.equal(shown.text(), expected));
				// Nothing read for it stays in the manager.
				assert.equal(window.hasFullHistory(), false);
				assert.equal(window.getEntries().length, held);

				if (host === "isolated") return;
				// The session's totals, which RPC get_session_stats returns, and the footer already added the store's totals
				// of the history before the window.
				const [windowStats, wholeStats] = [window, whole].map((manager) =>
					getSessionStats.call({
						sessionManager: manager,
						sessionFile: window.getSessionFile(),
						sessionId: window.getSessionId(),
						getContextUsage: () => undefined,
					} as never),
				);
				assert.deepEqual({ ...windowStats, cost: 0 }, { ...wholeStats, cost: 0 });
				assert.ok(Math.abs(windowStats!.cost - wholeStats!.cost) < 1e-9);
				const footer = async (manager: SessionManager) =>
					stripAnsi(new UsageMeterComponent((await sessionOver(manager, host)) as never).render(160)[0] ?? "");
				assert.equal(await footer(window), await footer(whole));
				assert.match(await footer(window), /\$1\.770/);
			});
});

test("/session keeps its totals and says why when the earlier history cannot be read (#5554)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-session-info-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const store = new MemorySessionStore();
	cleanups.push(() => store.close());
	const window = await openWindow("resume", store, directory);
	// Another process deletes the session while it is open here.
	await store.delete(window.getSessionId());

	const shown = runSessionCommand(await sessionOver(window, "in-process"));
	await vi.waitFor(() => assert.match(shown.text(), /Could not read the earlier history for the per-model cost/));
	assert.match(shown.text(), /Total: 1\.7800/);
	assert.doesNotMatch(shown.text(), /anthropic\/claude-a:|Wasted Cache Cost|Cache Hit Rate/);
});
