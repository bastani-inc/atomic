import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolResultMessage } from "@bastani/pi-ai/compat";
import { getModel } from "@bastani/pi-ai/compat";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, it } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompactionBoundary } from "../src/core/compaction/index.js";
import {
	createConversationRegion,
	ROLE_HEADER_RE,
	serializeConversationForCompaction,
	serializeRetainedTranscript,
} from "../src/core/compaction/transcript-serialization.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { renderHistoryTranscript } from "../src/core/tools/history-transcript.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createPlannerStreamFn, plannerRequest } from "./structured-planner-test-helpers.js";
import { createTestResourceLoader } from "./utilities.ts";

useTemporaryAgentDir();

const PREVIOUS_TOOL_RESULT_CAP = 16_000;
const TOOL_RESULT_CAP = 2_000;
const ROW_WIDTH = 100;
const LARGE_RESULT_ROWS = 200;
const MEDIUM_RESULT_ROWS = 50;
const SHORT_RESULT = "short result kept whole";

function previousMarker(removed: number): string {
	return `\n\n[... ${removed} more characters truncated]`;
}

function currentMarker(removed: number): string {
	return `\n\n[... ${removed} more characters truncated; the full output is in this session's history]`;
}

function needle(index: number): string {
	return `needle-4568-tail-${index}`;
}

function rows(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) =>
		`${prefix} row ${index}`.padEnd(ROW_WIDTH - 1, ".").concat("\n"),
	).join("");
}

function resultWithTail(index: number, rowCount: number): string {
	return `${rows(`result ${index}`, rowCount)}${needle(index)}`;
}

function assistantMessage(text: string, timestamp: number, toolCall?: { id: string }): AssistantMessage {
	return {
		role: "assistant",
		content: toolCall
			? [{ type: "toolCall", id: toolCall.id, name: "read", arguments: { path: `file-${toolCall.id}.txt` } }]
			: [{ type: "text", text }],
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
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp,
	};
}

function toolResult(id: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

interface Fixture {
	messages: Message[];
	resultTexts: string[];
}

function fixture(): Fixture {
	const resultTexts = [
		resultWithTail(0, LARGE_RESULT_ROWS),
		resultWithTail(1, LARGE_RESULT_ROWS),
		resultWithTail(2, MEDIUM_RESULT_ROWS),
		SHORT_RESULT,
		resultWithTail(4, LARGE_RESULT_ROWS),
		resultWithTail(5, LARGE_RESULT_ROWS),
	];
	const messages: Message[] = [
		{ role: "user", content: "task 0\ninvestigate the failing build\nfiller", timestamp: 1 },
	];
	resultTexts.forEach((text, index) => {
		const id = `call-${index}`;
		messages.push(assistantMessage("", 2 + index * 2, { id }), toolResult(id, text, 3 + index * 2));
	});
	messages.push(
		assistantMessage("summary of findings", 100),
		{ role: "user", content: "task 1", timestamp: 101 },
		assistantMessage("answer 1", 102),
		{ role: "user", content: "task 2", timestamp: 103 },
		assistantMessage("answer 2", 104),
	);
	return { messages, resultTexts };
}

function sizeWithPreviousCap(retainedText: string, resultTexts: string[]): number {
	return resultTexts.reduce((size, text) => {
		if (text.length <= PREVIOUS_TOOL_RESULT_CAP) return size;
		const removed = text.length - PREVIOUS_TOOL_RESULT_CAP;
		return size - removed + previousMarker(removed).length;
	}, retainedText.length);
}

function sizeWithCurrentCap(retainedText: string, resultTexts: string[]): number {
	return resultTexts.reduce((size, text) => {
		if (text.length <= TOOL_RESULT_CAP) return size;
		const removed = text.length - TOOL_RESULT_CAP;
		return size - removed + currentMarker(removed).length;
	}, retainedText.length);
}

function textOf(chunks: ReturnType<typeof serializeRetainedTranscript>): string {
	return chunks.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join("");
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("planner input size with a 2,000 character tool-result cap (#4568)", () => {
	it("counts the planner input before and after the cap against the retained transcript (#4568)", () => {
		const { messages, resultTexts } = fixture();
		const retainedText = textOf(serializeRetainedTranscript(messages));
		const beforeChars = sizeWithPreviousCap(retainedText, resultTexts);
		const planner = serializeConversationForCompaction(messages);
		const region = createConversationRegion(messages);

		assert.equal(planner.length, sizeWithCurrentCap(retainedText, resultTexts));
		assert.equal(region.lines.join("\n"), planner, "the planner region is the capped serialization");
		assert.equal(
			region.tokenEstimate,
			Math.ceil(region.lines.join("\n").length / 4),
			"the planner region token estimate counts the capped text",
		);

		const largeResults = resultTexts.filter((text) => text.length > PREVIOUS_TOOL_RESULT_CAP);
		assert.equal(largeResults.length, 4, "the fixture has four results over the previous cap");
		assert.ok(
			beforeChars - planner.length > largeResults.length * (PREVIOUS_TOOL_RESULT_CAP - TOOL_RESULT_CAP) - 1_000,
			"each result over the previous cap sheds about 14,000 characters",
		);
		assert.ok(planner.length < beforeChars / 2, "the capped planner input is under half of the previous size");
		assert.ok(retainedText.length > beforeChars, "the full transcript is larger than the previously capped one");
	});

	it("keeps exactly the first 2,000 characters of each oversized result and marks the rest (#4568)", () => {
		const { messages, resultTexts } = fixture();
		const planner = serializeConversationForCompaction(messages);
		for (const text of resultTexts) {
			if (text.length > TOOL_RESULT_CAP) {
				const section = `${text.slice(0, TOOL_RESULT_CAP)}${currentMarker(text.length - TOOL_RESULT_CAP)}`;
				assert.ok(planner.includes(`[Tool result]: ${section}`), "oversized result is cut to the cap plus marker");
				assert.ok(!planner.includes(text.slice(0, TOOL_RESULT_CAP + 1)), "nothing past the cap survives");
			} else {
				assert.ok(planner.includes(`[Tool result]: ${text}`), "a result under the cap is untouched");
			}
		}
		for (const index of [0, 1, 2, 4, 5]) {
			assert.ok(!planner.includes(needle(index)), `${needle(index)} lies past the cap`);
		}
		assert.ok(planner.includes(SHORT_RESULT));
	});

	it("keeps full tool output in the retained transcript (#4568)", () => {
		const { messages, resultTexts } = fixture();
		const retainedText = textOf(serializeRetainedTranscript(messages));
		for (const text of resultTexts)
			assert.ok(retainedText.includes(text), "retained transcript holds the full result");
		assert.ok(!retainedText.includes("more characters truncated"));
	});
});

describe("truncated tool output stays retrievable through history recall (#4568)", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("finds and reads the cut tail of a large tool result from this session's history (#4568)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-tool-output-cut-"));
		tempDirs.push(cwd);
		const faux = createPlannerStreamFn(["1,1\n"]);
		const streamFn: StreamFn = faux.streamFn;
		const manager = await SessionManager.create(cwd, cwd);
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

		const { messages, resultTexts } = fixture();
		for (const message of messages) await manager.appendMessage(message);
		session.agent.state.messages = manager.buildSessionContext().messages;
		const result = await session.compact({ preserve_recent: 2 });

		const plannerInput = plannerRequest(faux.state.contexts[0]);
		const plannerLines = plannerInput.messages.flatMap((message) => message.lines).join("\n");
		assert.ok(
			plannerLines.includes(
				`\n\n[... ${resultTexts[0].length - TOOL_RESULT_CAP} more characters truncated; full output: read history://sessions/${session.sessionId}:`,
			),
		);
		assert.ok(!plannerLines.includes(needle(0)), "the planner never saw the cut tail");
		assert.ok(!result.compactedText.includes(needle(0)), "the durable compaction text does not hold the cut tail");

		const [boundary] = convertToLlm(session.sessionManager.buildSessionContext().messages);
		assert.ok(typeof boundary?.content !== "string");
		const boundaryText = boundary.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		assert.ok(boundaryText.includes(`full output: read history://sessions/${session.sessionId}:`));
		assert.ok(!boundaryText.includes(needle(0)));

		const url = `history://sessions/${session.sessionId}`;
		assert.ok(boundaryText.includes(`history at ${url}.`), "the boundary names the history URL to recall from");
		const router = createHistoryRouter({
			cwd,
			currentSessionId: session.sessionId,
			sessionStore: () => session.sessionManager.getSessionStore(),
			workflows: () => undefined,
		});
		const ctx = { internalResourceRouter: router, cwd } as InternalResourceContext;
		const found = toolText(
			await createSearchToolDefinition(cwd).execute(
				"search",
				{ pattern: needle(0), paths: url },
				undefined,
				undefined,
				ctx as never,
			),
		);
		const resultLine = found.split("\n").find((row) => row.startsWith(`${url}:`));
		const match = /^:(\d+): /.exec(resultLine?.slice(url.length) ?? "");
		assert.ok(match, `search finds the cut tail in:\n${found}`);
		const line = Number(match[1]);
		const opened = toolText(
			await createReadToolDefinition(cwd).execute(
				"read",
				{ path: `${url}:${line}-${line}` },
				undefined,
				undefined,
				ctx as never,
			),
		);
		assert.ok(opened.includes(needle(0)), `read opens the cut tail in:\n${opened}`);
	});
});

const FULL_OUTPUT_MARKER = /more characters truncated; full output: read (history:\/\/sessions\/[^\s:\]]+:\d+-\d+)\]/g;
const FALLBACK_MARKER = "more characters truncated; the full output is in this session's history]";

interface StoreBackend {
	readonly name: string;
	open(dir: string): Promise<{ store: SessionStore; close(): Promise<void> }>;
}

const STORE_BACKENDS: readonly StoreBackend[] = [
	{
		name: "JsonlSessionStore",
		open: async (dir) => {
			const store = await JsonlSessionStore.open(join(dir, "jsonl"));
			return { store, close: () => store.close() };
		},
	},
	{
		name: "SqlSessionStore",
		open: async (dir) => {
			const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
			const store = await SqlSessionStore.open(database);
			return {
				store,
				close: async () => {
					await store.close();
					await database.close();
				},
			};
		},
	},
];

function plannerText(context: Parameters<typeof plannerRequest>[0]): string {
	return plannerRequest(context)
		.messages.flatMap((message) => message.lines)
		.join("\n");
}

function markerUrls(text: string): string[] {
	return [...text.matchAll(FULL_OUTPUT_MARKER)].map((match) => match[1]);
}

describe("truncation markers locate the full output in session history (#4568)", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	const closers: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const close of closers.splice(0)) await close();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function sessionOver(
		manager: SessionManager,
		cwd: string,
		faux: ReturnType<typeof createPlannerStreamFn>,
	): Promise<AgentSession> {
		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: { model: getModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "test", tools: [] },
			streamFn: faux.streamFn,
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
		return session;
	}

	async function append(session: AgentSession, messages: Message[]): Promise<void> {
		for (const message of messages) await session.sessionManager.appendMessage(message);
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
	}

	function reader(session: AgentSession, cwd: string): (url: string) => Promise<string> {
		const router = createHistoryRouter({
			cwd,
			currentSessionId: session.sessionId,
			sessionStore: () => session.sessionManager.getSessionStore(),
			workflows: () => undefined,
		});
		const ctx = { internalResourceRouter: router, cwd } as InternalResourceContext;
		return async (url) =>
			toolText(
				await createReadToolDefinition(cwd).execute("read", { path: url }, undefined, undefined, ctx as never),
			);
	}

	interface Oversized {
		readonly index: number;
		readonly text: string;
	}

	function oversizedResults(resultTexts: string[]): Oversized[] {
		return resultTexts.flatMap((text, index) => (text.length > TOOL_RESULT_CAP ? [{ index, text }] : []));
	}

	async function expectEveryResultReadsBack(
		session: AgentSession,
		cwd: string,
		urls: string[],
		results: Oversized[],
	): Promise<void> {
		assert.equal(urls.length, results.length, `one marker per oversized result in ${urls.join(", ")}`);
		const read = reader(session, cwd);
		for (const [position, { index, text }] of results.entries()) {
			const opened = await read(urls[position]);
			assert.ok(opened.includes(text), `${urls[position]} opens the whole of result ${index}`);
			const exact = await read(`${urls[position]}:raw`);
			const [heading, ...body] = exact.split("\n");
			assert.match(heading, / tool result read$/, `${urls[position]} starts at the result's own heading`);
			assert.equal(body.join("\n"), text, `${urls[position]} ends at the last line of result ${index}`);
			for (const other of results)
				if (other.index !== index)
					assert.ok(!opened.includes(needle(other.index)), `${urls[position]} holds only result ${index}`);
		}
	}

	function toolTurn(index: number, timestamp: number): { messages: Message[]; result: Oversized } {
		const id = `turn-${index}`;
		const text = resultWithTail(index, LARGE_RESULT_ROWS);
		return {
			messages: [assistantMessage("", timestamp, { id }), toolResult(id, text, timestamp + 1)],
			result: { index, text },
		};
	}

	describe.each(STORE_BACKENDS)("$name", (backend) => {
		async function openSession(options: { workflowStage: boolean }) {
			const cwd = mkdtempSync(join(tmpdir(), "atomic-tool-output-locator-"));
			tempDirs.push(cwd);
			const { store, close } = await backend.open(cwd);
			closers.push(close);
			const manager = await SessionManager.create(store, cwd);
			if (options.workflowStage)
				await manager.markSessionInternal({ runId: "run-4568", stageId: "stage-4568", stageName: "implement" });
			const faux = createPlannerStreamFn(["1,1\n"]);
			return { cwd, faux, session: await sessionOver(manager, cwd, faux) };
		}

		it("reads the full output through the range in each marker (#4568)", async () => {
			const { cwd, faux, session } = await openSession({ workflowStage: false });
			const { messages, resultTexts } = fixture();
			await append(session, messages);
			await session.compact({ preserve_recent: 2 });

			const urls = markerUrls(plannerText(faux.state.contexts[0]));
			await expectEveryResultReadsBack(session, cwd, urls, oversizedResults(resultTexts));
		});

		it("reads the full output of a workflow stage session, whose header has an extra line (#4568)", async () => {
			const { cwd, faux, session } = await openSession({ workflowStage: true });
			assert.equal(session.sessionManager.getHeader()?.workflow?.stageName, "implement");
			const { messages, resultTexts } = fixture();
			await append(session, messages);
			await session.compact({ preserve_recent: 2 });

			const urls = markerUrls(plannerText(faux.state.contexts[0]));
			await expectEveryResultReadsBack(session, cwd, urls, oversizedResults(resultTexts));
		});

		it("keeps every range correct after an earlier compaction in the same session (#4568)", async () => {
			const { cwd, faux, session } = await openSession({ workflowStage: false });
			const [first, second, third] = [toolTurn(10, 2), toolTurn(11, 7), toolTurn(12, 12)];
			await append(session, [
				{ role: "user", content: "task 0\nfirst task\nfiller", timestamp: 1 },
				...first.messages,
				assistantMessage("first findings", 5),
				{ role: "user", content: "task 1", timestamp: 6 },
				...second.messages,
				assistantMessage("second findings", 10),
			]);
			await session.compact({ preserve_recent: 3 });
			const firstUrls = markerUrls(plannerText(faux.state.contexts[0]));
			await expectEveryResultReadsBack(session, cwd, firstUrls, [first.result]);

			await append(session, [
				{ role: "user", content: "task 2", timestamp: 11 },
				...third.messages,
				assistantMessage("third findings", 15),
				{ role: "user", content: "task 3", timestamp: 16 },
				assistantMessage("answer 3", 17),
			]);
			await session.compact({ preserve_recent: 2 });
			const secondUrls = markerUrls(plannerText(faux.state.contexts[1]));
			await expectEveryResultReadsBack(session, cwd, secondUrls, [first.result, second.result, third.result]);
			assert.ok(secondUrls.includes(firstUrls[0]), "the earlier marker survives into the next planner input");
		});
	});

	function persistedFallbackFixtureEntries(): Promise<{ manager: SessionManager; ids: Map<number, string> }> {
		return (async () => {
			const manager = SessionManager.inMemory();
			const ids = new Map<number, string>();
			await manager.appendMessage({ role: "user", content: "task 0\nfirst\nfiller", timestamp: 1 });
			for (const index of [20, 21]) {
				const [call, result] = toolTurn(index, 2 + index).messages;
				await manager.appendMessage(call);
				ids.set(index, await manager.appendMessage(result));
			}
			for (let turn = 0; turn < 3; turn++) {
				await manager.appendMessage({ role: "user", content: `task ${turn + 1}`, timestamp: 100 + turn * 2 });
				await manager.appendMessage(assistantMessage(`answer ${turn + 1}`, 101 + turn * 2));
			}
			return { manager, ids };
		})();
	}

	function regionOf(manager: SessionManager, history?: Parameters<typeof prepareCompactionBoundary>[3]): string {
		const preparation = prepareCompactionBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, {}, history);
		assert.ok(preparation, "the fixture has a compactable region");
		return preparation.region.lines.join("\n");
	}

	function historyOf(manager: SessionManager) {
		const { entryRanges } = renderHistoryTranscript(manager.getHeader()!, manager.getEntries(), true);
		return { history: { sessionId: manager.getSessionId(), entryRanges } };
	}

	it("uses the fallback marker when no session history is known (#4568)", async () => {
		const { manager } = await persistedFallbackFixtureEntries();
		const region = regionOf(manager);
		assert.equal(region.split(FALLBACK_MARKER).length - 1, 2);
		assert.deepEqual(markerUrls(region), []);
	});

	it("uses the fallback marker for an entry the history does not hold (#4568)", async () => {
		const { manager, ids } = await persistedFallbackFixtureEntries();
		const { history } = historyOf(manager);
		const entryRanges = new Map(history.entryRanges);
		entryRanges.delete(ids.get(20)!);
		const region = regionOf(manager, { history: { ...history, entryRanges } });
		assert.equal(region.split(FALLBACK_MARKER).length - 1, 1, "only the unknown entry falls back");
		assert.equal(markerUrls(region).length, 1);
	});

	it("uses the fallback marker for a result whose model-facing content was edited (#4568)", async () => {
		const { manager, ids } = await persistedFallbackFixtureEntries();
		await manager.appendContextEdit(ids.get(20)!, { content: [{ type: "text", text: "edited ".repeat(1000) }] });
		const region = regionOf(manager, historyOf(manager));
		assert.equal(region.split(FALLBACK_MARKER).length - 1, 1, "the edited result falls back");
		assert.deepEqual(markerUrls(region), [
			`history://sessions/${manager.getSessionId()}:${historyOf(manager).history.entryRanges.get(ids.get(21)!)!.start}-${historyOf(manager).history.entryRanges.get(ids.get(21)!)!.end}`,
		]);
	});

	it("uses the fallback marker in an in-memory session with no history to read (#4568)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-tool-output-memory-"));
		tempDirs.push(cwd);
		const faux = createPlannerStreamFn(["1,1\n"]);
		const session = await sessionOver(SessionManager.inMemory(cwd), cwd, faux);
		await append(session, fixture().messages);
		await session.compact({ preserve_recent: 2 });
		const planner = plannerText(faux.state.contexts[0]);
		assert.equal(planner.split(FALLBACK_MARKER).length - 1, 5);
		assert.deepEqual(markerUrls(planner), []);
	});

	it("keeps a marker with a location inert when a later compaction reads it as ordinary text (#4568)", async () => {
		const { manager } = await persistedFallbackFixtureEntries();
		const first = regionOf(manager, historyOf(manager));
		const url = markerUrls(first)[0];
		assert.ok(url);
		const second = createConversationRegion([], first);
		assert.equal(second.lines.join("\n"), first);
		assert.equal(second.priorMarkerNs.size, 0, "a location marker is not a filtered-lines marker");
		assert.equal(second.protectedLineNumbers, undefined, "a location marker protects nothing");
		assert.equal(
			second.headerLineNumbers.size,
			first.split("\n").filter((line) => ROLE_HEADER_RE.test(line)).length,
			"the marker line is not a role header",
		);
	});
});
