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
import {
	createConversationRegion,
	serializeConversationForCompaction,
	serializeRetainedTranscript,
} from "../src/core/compaction/transcript-serialization.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
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
		assert.ok(plannerLines.includes(currentMarker(resultTexts[0].length - TOOL_RESULT_CAP)));
		assert.ok(!plannerLines.includes(needle(0)), "the planner never saw the cut tail");
		assert.ok(!result.compactedText.includes(needle(0)), "the durable compaction text does not hold the cut tail");

		const [boundary] = convertToLlm(session.sessionManager.buildSessionContext().messages);
		assert.ok(typeof boundary?.content !== "string");
		const boundaryText = boundary.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		assert.ok(boundaryText.includes("the full output is in this session's history]"));
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
