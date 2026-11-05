import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { describe, test } from "vitest";
import {
	resultsAnsweringTranscript,
	storedTranscript,
	unansweredToolCallIds,
} from "../../packages/workflows/src/runs/foreground/stage-runner-reopen.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";

type Message = StageSessionRuntime["messages"][number];

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

/** An assistant message whose content holds a text block and a call of the fake tool for each id. */
function assistant(...callIds: string[]): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "checking" },
			...callIds.map((id) => ({ type: "toolCall" as const, id, name: "wait_for_ci", arguments: {} })),
		],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: USAGE,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolCallId: string): Message {
	return { role: "toolResult", toolCallId, toolName: "wait_for_ci", content: [], isError: false, timestamp: 3 };
}

function recorded(toolCallId: string, text = `${toolCallId} passed`): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		isError: false,
		result: { content: [{ type: "text", text }], details: undefined },
	};
}

function ids(results: readonly DetachedToolResult[] | undefined): string[] | undefined {
	return results?.map((result) => result.toolCallId);
}

describe("the recorded results that answer a transcript's unanswered calls (#4309)", () => {
	test("every unanswered call of the last assistant message is answered, in call order, whatever order the results were recorded in (#4309)", () => {
		const messages = [user("go"), assistant("call-1", "call-2", "call-3")];
		assert.deepEqual(
			ids(resultsAnsweringTranscript([recorded("call-3"), recorded("call-1"), recorded("call-2")], messages)),
			["call-1", "call-2", "call-3"],
		);
		// A result for a call the transcript never made is not used.
		assert.deepEqual(
			ids(
				resultsAnsweringTranscript(
					[recorded("other"), recorded("call-1"), recorded("call-2"), recorded("call-3")],
					messages,
				),
			),
			["call-1", "call-2", "call-3"],
		);
	});

	test("a call with no recorded result leaves the whole turn to run its calls again (#4309)", () => {
		const messages = [user("go"), assistant("call-1", "call-2")];
		assert.equal(resultsAnsweringTranscript([recorded("call-1")], messages), undefined);
		assert.equal(resultsAnsweringTranscript([], messages), undefined);
	});

	test("a call a later tool result already answered needs no recorded result (#4309)", () => {
		const messages = [user("go"), assistant("call-1", "call-2"), toolResult("call-1")];
		assert.deepEqual(ids(resultsAnsweringTranscript([recorded("call-2")], messages)), ["call-2"]);
		assert.deepEqual(
			ids(resultsAnsweringTranscript([], [user("go"), assistant("call-1"), toolResult("call-1")])),
			[],
		);
	});

	test("only the last assistant message counts, found past the messages that follow it (#4309)", () => {
		const messages = [
			user("first"),
			assistant("old-call"),
			toolResult("old-call"),
			user("second"),
			assistant("new-call"),
			user("steering"),
		];
		assert.deepEqual(ids(resultsAnsweringTranscript([recorded("new-call")], messages)), ["new-call"]);
		assert.equal(resultsAnsweringTranscript([recorded("old-call")], messages), undefined);
	});

	test("a tool result that precedes the assistant message answers nothing it asks (#4309)", () => {
		const messages = [toolResult("call-1"), assistant("call-1")];
		assert.deepEqual(ids(resultsAnsweringTranscript([recorded("call-1")], messages)), ["call-1"]);
		assert.equal(resultsAnsweringTranscript([], messages), undefined);
	});

	test("an assistant message that is the whole transcript is read, and a transcript with none has nothing to answer (#4309)", () => {
		assert.deepEqual(ids(resultsAnsweringTranscript([recorded("call-1")], [assistant("call-1")])), ["call-1"]);
		assert.deepEqual(ids(resultsAnsweringTranscript([recorded("call-1")], [user("go"), toolResult("call-1")])), []);
		assert.deepEqual(ids(resultsAnsweringTranscript([recorded("call-1")], [])), []);
		assert.deepEqual(ids(resultsAnsweringTranscript([recorded("call-1")], [assistant()])), []);
	});

	test("the later of two results recorded for one call is the one used (#4309)", () => {
		const [result] = resultsAnsweringTranscript(
			[recorded("call-1", "first"), recorded("call-1", "second")],
			[assistant("call-1")],
		) ?? [undefined];
		assert.equal(result?.result.content[0]?.type === "text" ? result.result.content[0].text : undefined, "second");
	});
});

describe("the calls a transcript's last assistant message left without a result (#4309)", () => {
	test("they are listed in call order, and a call a later tool result answers is not (#4309)", () => {
		assert.deepEqual(unansweredToolCallIds([user("go"), assistant("call-2", "call-1", "call-3")]), [
			"call-2",
			"call-1",
			"call-3",
		]);
		assert.deepEqual(unansweredToolCallIds([user("go"), assistant("call-1", "call-2"), toolResult("call-2")]), [
			"call-1",
		]);
		assert.deepEqual(unansweredToolCallIds([assistant("call-1")]), ["call-1"]);
		assert.deepEqual(
			unansweredToolCallIds([user("go"), assistant("old"), toolResult("old"), assistant("new"), user("more")]),
			["new"],
		);
		assert.deepEqual(unansweredToolCallIds([toolResult("call-1"), assistant("call-1")]), ["call-1"]);
	});

	test("a transcript with no assistant message, or one that made no calls, has none (#4309)", () => {
		assert.deepEqual(unansweredToolCallIds([]), []);
		assert.deepEqual(unansweredToolCallIds([user("go"), toolResult("call-1")]), []);
		assert.deepEqual(unansweredToolCallIds([user("go"), assistant()]), []);
	});
});

describe("the transcript a stage reads its unanswered calls from (#4309)", () => {
	test("a runtime that is not an agent session reports its own messages (#4309)", () => {
		const messages = [user("go"), assistant("call-1")];
		assert.equal(storedTranscript({ messages } as unknown as StageSessionRuntime), messages);
	});

	test("an agent session is read from what its session manager holds, not from the context its model sees (#4309)", () => {
		const stored = [user("go"), assistant("call-1")];
		const seenByModel = [user("go"), assistant("call-1"), toolResult("call-1")];
		const agentSession = {
			state: {},
			modelRuntime: {},
			getContextUsage: () => undefined,
			messages: seenByModel,
			sessionManager: { buildSessionProjection: () => ({ messages: stored }) },
		};
		assert.equal(storedTranscript(agentSession as unknown as StageSessionRuntime), stored);
		// A runtime that lacks any one of the agent session's members is not read as one.
		for (const missing of ["state", "modelRuntime", "getContextUsage", "sessionManager"] as const) {
			const partial = { ...agentSession, [missing]: undefined };
			assert.equal(storedTranscript(partial as unknown as StageSessionRuntime), seenByModel, missing);
		}
	});
});
