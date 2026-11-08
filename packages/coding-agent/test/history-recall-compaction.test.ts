import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@bastani/pi-ai/compat";
import { getModel } from "@bastani/pi-ai/compat";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, it } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { RANGE_PLANNER_SYSTEM_PROMPT } from "../src/core/compaction/range-planner.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createPlannerStreamFn } from "./structured-planner-test-helpers.js";
import { createTestResourceLoader } from "./utilities.ts";

useTemporaryAgentDir();

const REMOVED_LINE = "needle-4568 the unique requirement that compaction removes";

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function conversation(): Message[] {
	const filler = Array.from({ length: 24 }, (_, index) => `kept filler line ${index}`).join("\n");
	return [
		{ role: "user", content: `task 0\n${REMOVED_LINE}\n${filler}`, timestamp: 1 },
		assistant("answer 0", 2),
		{ role: "user", content: "task 1", timestamp: 3 },
		assistant("answer 1", 4),
		{ role: "user", content: "task 2", timestamp: 5 },
		assistant("answer 2", 6),
	];
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("history recall after verbatim compaction (#4568)", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function compactedSession(options: { internal: boolean }): Promise<{ session: AgentSession; cwd: string }> {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-history-recall-"));
		tempDirs.push(cwd);
		const faux = createPlannerStreamFn(["2,2\n"]);
		const streamFn: StreamFn = faux.streamFn;
		const manager = await SessionManager.create(cwd, cwd);
		if (options.internal) {
			await manager.markSessionInternal({ runId: "run-4568", stageId: "stage-4568", stageName: "implement" });
		}
		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: { model: getModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "test", tools: [] },
			streamFn,
		});
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			cwd,
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		for (const message of conversation()) await manager.appendMessage(message);
		session.agent.state.messages = manager.buildSessionContext().messages;
		const result = await session.compact({ preserve_recent: 2 });
		assert.ok(!result.compactedText.includes(REMOVED_LINE), "the planner removed the requirement line");
		return { session, cwd };
	}

	function boundaryText(session: AgentSession): string {
		const [first] = convertToLlm(session.sessionManager.buildSessionContext().messages);
		assert.equal(first?.role, "user");
		assert.ok(typeof first?.content !== "string");
		return first.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}

	function recallTools(session: AgentSession, routerCwd: string) {
		const router = createHistoryRouter({
			cwd: routerCwd,
			currentSessionId: session.sessionId,
			sessionStore: () => session.sessionManager.getSessionStore(),
			workflows: () => undefined,
		});
		const ctx = { internalResourceRouter: router, cwd: routerCwd } as InternalResourceContext;
		return {
			search: async (pattern: string, paths: string) =>
				toolText(
					await createSearchToolDefinition(routerCwd).execute(
						"search",
						{ pattern, paths },
						undefined,
						undefined,
						ctx as never,
					),
				),
			read: async (path: string) =>
				toolText(
					await createReadToolDefinition(routerCwd).execute("read", { path }, undefined, undefined, ctx as never),
				),
		};
	}

	async function assertRecallable(session: AgentSession, routerCwd: string): Promise<void> {
		const url = `history://sessions/${session.sessionId}`;
		const boundary = boundaryText(session);
		assert.ok(boundary.includes(`history at ${url}.`), "the boundary names this session's history URL");
		assert.ok(boundary.includes("`search` on that URL"), "the boundary points at search");
		assert.ok(boundary.includes("`read` with `:N-M`"), "the boundary points at read with a line range");
		assert.ok(!boundary.includes(REMOVED_LINE), "the model-facing context no longer holds the removed line");
		assert.equal(boundary.split(url).length - 1, 1, "the recall hint appears once, not in every marker");

		const { search, read } = recallTools(session, routerCwd);
		const found = await search("needle-4568", url);
		const resultLine = found.split("\n").find((row) => row.startsWith(`${url}:`));
		const match = /^:(\d+): /.exec(resultLine?.slice(url.length) ?? "");
		assert.ok(resultLine?.endsWith(REMOVED_LINE), `search returns the removed text in:\n${found}`);
		assert.ok(match, `search finds the removed line in:\n${found}`);
		const line = Number(match[1]);
		const opened = await read(`${url}:${line}-${line}`);
		assert.ok(opened.includes(REMOVED_LINE), `read opens the removed line in:\n${opened}`);
	}

	it("tells the agent where removed lines live and lets it recall them from the current session (#4568)", async () => {
		const { session, cwd } = await compactedSession({ internal: false });
		await assertRecallable(session, cwd);
	});

	it("recalls removed lines from a workflow stage session through its own URL (#4568)", async () => {
		const { session, cwd } = await compactedSession({ internal: true });
		assert.equal(session.sessionManager.getHeader()?.internal, true);
		await assertRecallable(session, cwd);
	});

	it("reaches the current stage session even when the router runs in another directory (#4568)", async () => {
		const { session } = await compactedSession({ internal: true });
		const elsewhere = mkdtempSync(join(tmpdir(), "atomic-history-recall-other-"));
		tempDirs.push(elsewhere);
		await assertRecallable(session, elsewhere);
	});

	it("tells the planner that removed lines stay retrievable and to remove bulky output first (#4568)", () => {
		assert.ok(
			RANGE_PLANNER_SYSTEM_PROMPT.includes(
				"Removed lines stay retrievable from session history, so remove bulky re-readable output (tool results, file dumps, logs) before unique user requirements, decisions, root causes and conclusions.",
			),
		);
	});
});
