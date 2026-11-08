import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolResultMessage } from "@bastani/pi-ai/compat";
import { getModel } from "@bastani/pi-ai/compat";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.ts";
import type { BorrowedPlanner, VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/deleted-ranges.js";
import {
	buildRangePlannerPrompt,
	planDeletedLineRanges,
	RANGE_PLANNER_SYSTEM_PROMPT,
} from "../src/core/compaction/range-planner.js";
import { buildStructuredCompactionInput } from "../src/core/compaction/structured-compaction-input.js";
import {
	createConversationRegion,
	createNumberedRegion,
	omitLegacyThinkingSections,
	serializeConversationForCompaction,
	serializeRetainedTranscript,
} from "../src/core/compaction/transcript-serialization.js";
import { serializeConversation } from "../src/core/compaction/utils.ts";
import { convertToLlm, VERBATIM_COMPACTION_PREFIX, verbatimRecallHint } from "../src/core/messages.js";
import type { CompactionEntry, SessionEntry } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createPlannerStreamFn, plannerRequest } from "./structured-planner-test-helpers.js";
import { createFauxStreamFn } from "./test-harness.js";
import { createTestResourceLoader } from "./utilities.ts";

useTemporaryAgentDir();

const PARAMETERS = { query: "continue", compression_ratio: 0.5, preserve_recent: 0 };

function assistant(content: AssistantMessage["content"], timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

function toolResult(toolCallId: string, text: string, timestamp = 1): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function thinking(text: string): AssistantMessage["content"][number] {
	return { type: "thinking", thinking: text, thinkingSignature: "signature" };
}

function withoutThinking(messages: Message[]): Message[] {
	return messages.map((message) =>
		message.role === "assistant"
			? { ...message, content: message.content.filter((block) => block.type !== "thinking") }
			: message,
	);
}

function legacyDetails(promptVersion: number | undefined): VerbatimCompactionDetails {
	const details = {
		strategy: "verbatim-lines" as const,
		parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "task" },
		stats: {
			linesBefore: 40,
			linesDeleted: 20,
			linesKept: 20,
			rangeCount: 1,
			tokensBefore: 100,
			tokensAfter: 50,
			percentReduction: 50,
		},
		rung: "planned" as const,
		...(promptVersion === undefined ? {} : { promptVersion }),
	};
	return details as VerbatimCompactionDetails;
}

const LONG_OUTPUT = Array.from({ length: 1_200 }, (_, index) => `output line ${index} ${"x".repeat(12)}`).join("\n");

/** A conversation whose compactable messages carry thinking, plus a kept tail that also does. */
function thinkingConversation(): Message[] {
	return [
		{ role: "user", content: "task 0\nline a\nline b", timestamp: 1 },
		assistant([
			thinking("COMPACTED-THINKING alpha\n\nbeta"),
			{ type: "text", text: "answer 0\nline c" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
		]),
		toolResult("call-1", Array.from({ length: 12 }, (_, index) => `result ${index}`).join("\n")),
		assistant([thinking("COMPACTED-THINKING thinking-only")]),
		{ role: "user", content: "task 1\nline d", timestamp: 1 },
		assistant([thinking("COMPACTED-THINKING gamma"), { type: "text", text: "answer 1" }, thinking("delta")]),
		assistant([
			thinking("KEPT-THINKING"),
			{ type: "text", text: "running" },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "big.log" } },
		]),
		toolResult("call-2", LONG_OUTPUT),
	];
}

describe("verbatim transcript serialization without thinking (#4544)", () => {
	it("emits the summary serializer's sections and nothing for thinking", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "request" }], timestamp: 1 },
			assistant([
				thinking("private plan"),
				{ type: "text", text: "first" },
				thinking("interleaved"),
				{ type: "text", text: "second" },
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts", limit: 3 } },
			]),
			assistant([thinking("only thinking")]),
			toolResult("tc1", "result\nmore"),
		];
		const serialized = serializeConversationForCompaction(messages);
		expect(serialized).toBe(
			'[User]: request\n\n[Assistant]: first\nsecond\n\n[Assistant tool calls]: read(path="a.ts", limit=3)\n\n[Tool result]: result\nmore',
		);
		expect(serialized).toBe(serializeConversation(messages));
		expect(serializeRetainedTranscript(messages)).toEqual([{ type: "text", text: serialized }]);
	});

	it("keeps line ids, spans and protection identical to the same transcript without thinking", () => {
		const messages: Message[] = [
			...thinkingConversation(),
			{ role: "user", content: "<keepContext>\nprotected\n</keepContext>", timestamp: 1 },
		];
		const region = createConversationRegion(messages, "prior\nsummary");
		const reference = createConversationRegion(withoutThinking(messages), "prior\nsummary");
		expect(region).toEqual(reference);
		expect(region.lines.join("\n")).not.toMatch(/THINKING|delta|\[Assistant thinking\]/);

		const input = buildStructuredCompactionInput(region, PARAMETERS);
		expect(input).toEqual(buildStructuredCompactionInput(reference, PARAMETERS));
		expect(input.messages.slice(0, 7)).toEqual([
			{ id: 1, role: "assistant", lines: ["prior", "summary"] },
			{ id: 2, role: "user", lines: ["[User]: task 0", "line a", "line b", ""] },
			{
				id: 3,
				role: "assistant",
				lines: ["[Assistant]: answer 0", "line c", "", '[Assistant tool calls]: read(path="a.ts")', ""],
			},
			{
				id: 4,
				role: "tool",
				lines: ["[Tool result]: result 0", ...Array.from({ length: 11 }, (_, index) => `result ${index + 1}`), ""],
			},
			{ id: 5, role: "user", lines: ["[User]: task 1", "line d", ""] },
			{ id: 6, role: "assistant", lines: ["[Assistant]: answer 1", ""] },
			{
				id: 7,
				role: "assistant",
				lines: ["[Assistant]: running", "", '[Assistant tool calls]: read(path="big.log")', ""],
			},
		]);
		expect(input.messages.map((message) => message.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(input.protected).toEqual([{ id: 9, start: 1, end: 3 }]);
	});

	it("keeps retained tool output whole and its images in place while omitting thinking", () => {
		const longText = "y".repeat(16_010);
		const chunks = serializeRetainedTranscript([
			assistant([thinking("KEPT-THINKING"), { type: "text", text: "look" }]),
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [
					{ type: "text", text: longText },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 1,
			},
		]);
		expect(chunks).toEqual([
			{ type: "text", text: `[Assistant]: look\n\n[Tool result]: ${longText}\n` },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		]);
	});

	it("recognizes only the summary serializer's headers, and only at the start of a line", () => {
		const region = createNumberedRegion(
			"[User]: quoting\n[Assistant thinking]: quoted\nsee [Assistant]: inline\n[Assistant tool calls]: x()\n[Tool result]: y\n[Assistant]: done",
		);
		expect([...region.headerLineNumbers]).toEqual([1, 4, 5, 6]);
	});
});

describe("legacy thinking sections in summaries written before prompt version 5 (#4544)", () => {
	it("drops each section from its header to the next role header", () => {
		const legacy = [
			"[Assistant thinking]: opening thought",
			"",
			"[User]: legacy task",
			"keep me",
			"",
			"[Assistant thinking]: first",
			"",
			"still thinking",
			"",
			"[Assistant thinking]: second section",
			"",
			"[Assistant]: legacy answer",
			"",
			'[Assistant tool calls]: read(path="a.ts")',
			"",
			"[Tool result]: legacy result",
		].join("\n");
		expect(omitLegacyThinkingSections(legacy)).toBe(
			[
				"[User]: legacy task",
				"keep me",
				"",
				"[Assistant]: legacy answer",
				"",
				'[Assistant tool calls]: read(path="a.ts")',
				"",
				"[Tool result]: legacy result",
			].join("\n"),
		);
	});

	it("stops at a filtered marker, because the next header may have been deleted with it", () => {
		const legacy =
			"[User]: task\n\n[Assistant thinking]: cut\nmore\n(filtered 4 lines)\nafter marker\n\n[Tool result]: r";
		expect(omitLegacyThinkingSections(legacy)).toBe(
			"[User]: task\n\n(filtered 4 lines)\nafter marker\n\n[Tool result]: r",
		);
	});

	it("removes the separator before a section that ends the text", () => {
		expect(omitLegacyThinkingSections("[User]: task\n\n[Assistant thinking]: last\n\nwords")).toBe("[User]: task");
		expect(omitLegacyThinkingSections("[User]: task\n(filtered 2 lines)\n[Assistant thinking]: last")).toBe(
			"[User]: task\n(filtered 2 lines)",
		);
		expect(omitLegacyThinkingSections("[Assistant thinking]: everything\nhere")).toBe("");
	});

	it("leaves text without legacy sections unchanged", () => {
		const text = "[User]: task\n\n\n[Assistant]: answer\n(filtered 3 lines)\n";
		expect(omitLegacyThinkingSections(text)).toBe(text);
		const headerless = "body left after an earlier deletion\n\n[User]: next";
		expect(omitLegacyThinkingSections(headerless)).toBe(headerless);
	});
});

describe("planner validation of message-local deletion ranges without thinking (#4544)", () => {
	it("maps valid records onto non-thinking lines and drops records that only fit the thinking grammar", async () => {
		const region = createConversationRegion([
			{ role: "user", content: "objective\nkeep", timestamp: 1 },
			assistant([thinking("T1 only")]),
			assistant([
				thinking("T2 line\nT2 more"),
				{ type: "text", text: "visible\nmore" },
				{ type: "toolCall", id: "tc", name: "read", arguments: { path: "x" } },
			]),
			toolResult("tc", "r1\nr2"),
			{ role: "user", content: "<keepContext>\nprotected\n</keepContext>", timestamp: 1 },
		]);
		expect(region.lines).toEqual([
			"[User]: objective",
			"keep",
			"",
			"[Assistant]: visible",
			"more",
			"",
			'[Assistant tool calls]: read(path="x")',
			"",
			"[Tool result]: r1",
			"r2",
			"",
			"[User]: <keepContext>",
			"protected",
			"</keepContext>",
		]);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const planner: BorrowedPlanner = { model, budget: { maxTokens: undefined, reasoning: undefined }, auth: {} };
		const faux = createFauxStreamFn([{ text: "2:1,2\n5:1,1\n2:1,9\n4:1,3\n3:2,2\n" }]);
		const outcome = await planDeletedLineRanges(region, PARAMETERS, planner, 7, { streamFn: faux.streamFn });

		expect(outcome).toEqual({
			kind: "ranked",
			ranges: [
				{ start: 4, end: 5 },
				{ start: 10, end: 10 },
			],
		});
		const prompt = JSON.stringify(faux.state.contexts[0]);
		expect(prompt).not.toMatch(/T1 only|T2 line|T2 more|Assistant thinking/);
		if (outcome.kind !== "ranked") throw new Error(`expected ranked, got ${outcome.kind}`);
		expect(reconstructCompactedTranscript(region, validateDeletedRanges(outcome.ranges, region)).text).toBe(
			[
				"[User]: objective",
				"keep",
				"",
				"(filtered 2 lines)",
				"",
				'[Assistant tool calls]: read(path="x")',
				"",
				"[Tool result]: r1",
				"(filtered 1 lines)",
				"",
				"[User]: <keepContext>",
				"protected",
				"</keepContext>",
			].join("\n"),
		);
	});

	it("asks the planner to weigh assistant text, not thinking", () => {
		const region = createConversationRegion([{ role: "user", content: "objective", timestamp: 1 }]);
		const prompt = buildRangePlannerPrompt(region, PARAMETERS);
		expect(RANGE_PLANNER_SYSTEM_PROMPT).not.toMatch(/thinking/i);
		expect(prompt).not.toMatch(/thinking/i);
		expect(RANGE_PLANNER_SYSTEM_PROMPT).toContain(
			"Assistant text carries decisions, constraints, plans, root causes, and conclusions",
		);
		expect(RANGE_PLANNER_SYSTEM_PROMPT).toContain("before sacrificing unique assistant rationale or conclusions.");
		for (const guidance of [
			"duplicate/re-read/superseded bodies, boilerplate narration, and formatting-only lines.",
			"- Assistant text is working memory, not disposable commentary.",
			"Delete redundant, speculative, or superseded lines within the same message.",
			"- Assistant progress reports can repeat facts already retained elsewhere.",
			"Check assistant text for useful facts before finalizing deletions;",
		])
			expect(prompt).toContain(guidance);
	});
});

describe("verbatim compaction round trip without thinking (#4544)", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createSession(streamFn: StreamFn): Promise<AgentSession> {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-verbatim-thinking-"));
		tempDirs.push(cwd);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const manager = await SessionManager.create(cwd, cwd);
		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: { model, systemPrompt: "test", tools: [] },
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
		return session;
	}

	async function append(session: AgentSession, messages: Message[]): Promise<string[]> {
		const ids: string[] = [];
		for (const message of messages) ids.push(await session.sessionManager.appendMessage(message));
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		return ids;
	}

	function boundaryText(session: AgentSession): string {
		const [first] = convertToLlm(session.sessionManager.buildSessionContext().messages);
		if (first?.role !== "user" || typeof first.content === "string") throw new Error("expected a boundary message");
		return first.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}

	it("plans, persists, reopens and replays without thinking while later turns keep theirs", async () => {
		const faux = createPlannerStreamFn(["2,2\n"]);
		const session = await createSession(faux.streamFn);
		const ids = await append(session, thinkingConversation());

		const result = await session.compact({ preserve_recent: 2 });
		expect(result.promptVersion).toBe(6);
		expect(result.rung).toBe("planned");
		expect(result.firstKeptEntryId).toBe(ids[6]);
		expect(faux.state.callCount).toBe(1);
		const context = faux.state.contexts[0];
		expect(JSON.stringify(context)).not.toMatch(/THINKING|Assistant thinking/);
		const request = plannerRequest(context);
		expect(request.messages.map((message) => message.lines[0])).toEqual([
			"[User]: task 0",
			"[Assistant]: answer 0",
			"[Tool result]: result 0",
			"[User]: task 1",
			"[Assistant]: answer 1",
		]);

		const expectedSummary = [
			"[User]: task 0",
			"(filtered 1 lines)",
			"line b",
			"",
			"[Assistant]: answer 0",
			"line c",
			"",
			'[Assistant tool calls]: read(path="a.ts")',
			"",
			"[Tool result]: result 0",
			...Array.from({ length: 11 }, (_, index) => `result ${index + 1}`),
			"",
			"[User]: task 1",
			"line d",
			"",
			"[Assistant]: answer 1",
		].join("\n");
		expect(result.compactedText).toBe(expectedSummary);

		const expectedBoundary = `${VERBATIM_COMPACTION_PREFIX}${verbatimRecallHint(session.sessionId)}${expectedSummary}\n\n[Assistant]: running\n\n[Assistant tool calls]: read(path="big.log")\n\n[Tool result]: ${LONG_OUTPUT}`;
		expect(boundaryText(session)).toBe(expectedBoundary);

		const keptAssistant = session.sessionManager.getEntry(ids[6]);
		expect(keptAssistant?.type === "message" && keptAssistant.message.role === "assistant").toBe(true);
		if (keptAssistant?.type === "message" && keptAssistant.message.role === "assistant") {
			expect(keptAssistant.message.content[0]).toEqual(thinking("KEPT-THINKING"));
		}

		await append(session, [
			{ role: "user", content: "next request", timestamp: 2 },
			assistant([thinking("POST-THINKING"), { type: "text", text: "post answer" }], 2),
		]);
		const replayed = session.sessionManager.buildSessionContext().messages;
		expect(replayed.at(-1)).toMatchObject({
			role: "assistant",
			content: [thinking("POST-THINKING"), { type: "text", text: "post answer" }],
		});

		const reopened = await SessionManager.open(session.sessionManager.getSessionFile()!);
		expect(convertToLlm(reopened.buildSessionContext().messages)).toEqual(convertToLlm(replayed));
	});

	it("drops thinking from a pre-version-5 boundary when compacting again, and still reads it", async () => {
		const faux = createPlannerStreamFn(["3,3\n"]);
		const session = await createSession(faux.streamFn);
		await append(session, [{ role: "user", content: "compacted earlier", timestamp: 1 }]);
		const legacySummary = [
			"[User]: legacy task",
			"",
			"[Assistant thinking]: LEGACY-THINKING one",
			"",
			"LEGACY-THINKING two",
			"",
			"[Assistant]: legacy answer",
			"",
			"[Assistant thinking]: LEGACY-THINKING cut",
			"(filtered 4 lines)",
			"after marker",
		].join("\n");
		await session.sessionManager.appendCompaction(legacySummary, null, 100, legacyDetails(4));
		expect(boundaryText(session)).toBe(
			`${VERBATIM_COMPACTION_PREFIX}${verbatimRecallHint(session.sessionId)}${legacySummary}`,
		);

		await append(session, [
			{
				role: "user",
				content: Array.from({ length: 20 }, (_, index) => `new line ${index}`).join("\n"),
				timestamp: 2,
			},
			assistant([thinking("NEW-THINKING"), { type: "text", text: "new answer" }], 2),
		]);
		const result = await session.compact({ preserve_recent: 0 });

		const request = plannerRequest(faux.state.contexts[0]);
		expect(request.messages[0]).toEqual({
			id: 1,
			role: "assistant",
			lines: ["[User]: legacy task", "", "[Assistant]: legacy answer", "", "(filtered 4 lines)", "after marker"],
		});
		expect(JSON.stringify(faux.state.contexts[0])).not.toMatch(/THINKING|Assistant thinking/);
		expect(result.compactedText).toBe(
			[
				"[User]: legacy task",
				"",
				"(filtered 1 lines)",
				"",
				"(filtered 4 lines)",
				"after marker",
				"[User]: new line 0",
				...Array.from({ length: 19 }, (_, index) => `new line ${index + 1}`),
				"",
				"[Assistant]: new answer",
			].join("\n"),
		);
		const boundary = session.sessionManager
			.getEntries()
			.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(boundary?.details).toMatchObject({ promptVersion: 6 });
	});
});

describe("boundary preparation across prompt versions (#4544)", () => {
	function entries(summary: string, details: VerbatimCompactionDetails): SessionEntry[] {
		const lines = Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n");
		return [
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				summary,
				firstKeptEntryId: null,
				tokensBefore: 100,
				details,
			},
			{
				type: "message",
				id: "m1",
				parentId: "c1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: lines, timestamp: 1 },
			},
		];
	}

	const quoted = "[User]: quoting a transcript\n[Assistant thinking]: quoted payload\nend";

	it("keeps a current boundary's quoted legacy header verbatim", () => {
		const preparation = prepareCompactionBoundary(entries(quoted, legacyDetails(5)), DEFAULT_COMPACTION_SETTINGS, {
			preserve_recent: 0,
		});
		expect(preparation?.region.lines.slice(0, 3)).toEqual(quoted.split("\n"));
	});

	it("treats a boundary from an older or unrecorded prompt version as the legacy grammar", () => {
		for (const version of [4, 1, undefined]) {
			const preparation = prepareCompactionBoundary(
				entries(quoted, legacyDetails(version)),
				DEFAULT_COMPACTION_SETTINGS,
				{ preserve_recent: 0 },
			);
			expect(preparation?.region.lines.slice(0, 2)).toEqual(["[User]: quoting a transcript", "[User]: line 0"]);
		}
	});
});
