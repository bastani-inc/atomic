/**
 * A detached turn whose calls' results reach the session at different times (#4309): each result is recorded as it
 * arrives, and the turn continues once, when the last of its detachable calls has one.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { isToolDetachmentError } from "../src/index.js";
import {
	detachedResult,
	harnessPool,
	reopenedAfterDetaching,
	toolResultIds,
	untilStarted,
	waitTool,
} from "./helpers/detached-tools.js";
import { getMessageText, type Harness } from "./suite/harness.js";

const pool = harnessPool();
afterEach(() => pool.cleanup());

type ResponseStep = Parameters<Harness["setResponses"]>[0][number];

/** A model reply that notes which tool results, in which order, the request carried. */
function reply(requests: string[][], text: string): ResponseStep {
	return (context) => {
		requests.push(
			context.messages.flatMap((message) =>
				message.role === "toolResult" ? [`${message.toolCallId}: ${getMessageText(message)}`] : [],
			),
		);
		return fauxAssistantMessage(text);
	};
}

/** The saved transcript: the user's turns, the calls each assistant message issued, and the call each result answers. */
function savedTranscript(manager: SessionManager): string[] {
	return manager.buildSessionProjection().messages.flatMap((message) => {
		if (message.role === "system") return [];
		if (message.role === "toolResult") return [`result ${message.toolCallId}`];
		if (message.role !== "assistant") return [message.role];
		const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
		return [calls.length === 0 ? "answer" : `calls ${calls.join(", ")}`];
	});
}

/** A session reopened from its store on a turn that detached two calls, `a-1` and `a-2`. */
async function reopenedOnTwoDetachedCalls() {
	const tool = waitTool();
	const turn = fauxAssistantMessage(
		[
			fauxToolCall("wait_for_ci", { run: "7" }, { id: "a-1" }),
			fauxToolCall("wait_for_ci", { run: "8" }, { id: "a-2" }),
		],
		{ stopReason: "toolUse" },
	);
	const { reopened, store, sessionId } = await reopenedAfterDetaching(pool, [tool.definition], [turn]);
	const requests: string[][] = [];
	reopened.setResponses([reply(requests, "both passed"), reply(requests, "asked again")]);
	return { tool, reopened, store, sessionId, requests };
}

const first = detachedResult("a-1", "first passed");
const second = detachedResult("a-2", "second passed");

describe("results of a detached turn that arrive one at a time (#4309)", () => {
	test("each is recorded as it arrives, and the turn continues once, after the last (#4309)", async () => {
		const { reopened, store, sessionId, requests } = await reopenedOnTwoDetachedCalls();

		await reopened.session.resumeDetachedTurn([first]);

		assert.equal(requests.length, 0, "no model request before the last result");
		assert.deepEqual(toolResultIds(await SessionManager.open(store, sessionId)), ["a-1"]);
		assert.equal(reopened.session.hasPendingDetachedTurn(), true);

		await reopened.session.resumeDetachedTurn([second]);

		assert.deepEqual(requests, [["a-1: first passed", "a-2: second passed"]]);
		assert.deepEqual(savedTranscript(await SessionManager.open(store, sessionId)), [
			"user",
			"calls a-1, a-2",
			"result a-1",
			"result a-2",
			"answer",
		]);
		assert.equal(reopened.session.hasPendingDetachedTurn(), false);
	});

	test("a session reopened between them starts again only the call without a result (#4309)", async () => {
		const { tool, reopened, store, sessionId } = await reopenedOnTwoDetachedCalls();
		await reopened.session.resumeDetachedTurn([first]);

		const next = await pool.harnessWith([tool.definition], await SessionManager.open(store, sessionId));
		const requests: string[][] = [];
		next.setResponses([reply(requests, "both passed"), reply(requests, "asked again")]);
		assert.equal(next.session.hasPendingDetachedTurn(), true);
		const redispatched = next.session.redispatchDetachedToolCalls();
		await untilStarted(tool, 3);

		assert.deepEqual(
			redispatched.map((call) => call.toolCallId),
			["a-2"],
		);
		assert.deepEqual(tool.calls.at(-1), { id: "a-2", args: { run: "8" } });
		tool.finish(2, "second passed");
		await next.session.resumeDetachedTurn([await redispatched[0]!.result]);

		assert.deepEqual(requests, [["a-1: first passed", "a-2: second passed"]]);
		assert.deepEqual(toolResultIds(await SessionManager.open(store, sessionId)), ["a-1", "a-2"]);
	});

	test("a result handed back again with the rest is recorded once (#4309)", async () => {
		const { reopened, store, sessionId, requests } = await reopenedOnTwoDetachedCalls();
		await reopened.session.resumeDetachedTurn([first]);

		await reopened.session.resumeDetachedTurn([detachedResult("a-1", "first passed again"), second]);

		assert.deepEqual(requests, [["a-1: first passed", "a-2: second passed"]]);
		assert.deepEqual(toolResultIds(await SessionManager.open(store, sessionId)), ["a-1", "a-2"]);
		assert.deepEqual(
			reopened.eventsOfType("tool_execution_end").map((event) => event.toolCallId),
			["a-1", "a-2"],
		);
	});

	test("a second resume while the first still records its result is refused as busy, and the turn still continues once (#4309)", async () => {
		const { reopened, sessionId, requests } = await reopenedOnTwoDetachedCalls();

		const recording = reopened.session.resumeDetachedTurn([first]);
		await assert.rejects(reopened.session.resumeDetachedTurn([second]), (error) => {
			assert.ok(isToolDetachmentError(error));
			assert.equal(error.code, "session-busy");
			assert.equal(error.retryable, true);
			assert.deepEqual(error.fields, { sessionId });
			return true;
		});
		await recording;
		assert.equal(requests.length, 0);

		await reopened.session.resumeDetachedTurn([second]);

		assert.deepEqual(requests, [["a-1: first passed", "a-2: second passed"]]);
	});
});

describe("results of a detached turn handed back together (#4309)", () => {
	test("continue the turn once, each result right after its call (#4309)", async () => {
		const { reopened, store, sessionId, requests } = await reopenedOnTwoDetachedCalls();

		await reopened.session.resumeDetachedTurn([first, second]);

		assert.deepEqual(requests, [["a-1: first passed", "a-2: second passed"]]);
		assert.deepEqual(savedTranscript(await SessionManager.open(store, sessionId)), [
			"user",
			"calls a-1, a-2",
			"result a-1",
			"result a-2",
			"answer",
		]);
	});

	test("a result repeated among them is recorded once, and a repeat after the turn continued records nothing (#4309)", async () => {
		const { reopened, store, sessionId, requests } = await reopenedOnTwoDetachedCalls();

		await reopened.session.resumeDetachedTurn([first, first, second]);

		assert.deepEqual(requests, [["a-1: first passed", "a-2: second passed"]]);
		assert.deepEqual(toolResultIds(await SessionManager.open(store, sessionId)), ["a-1", "a-2"]);

		await reopened.session.resumeDetachedTurn([first, second]);

		assert.equal(requests.length, 1);
		assert.deepEqual(savedTranscript(await SessionManager.open(store, sessionId)), [
			"user",
			"calls a-1, a-2",
			"result a-1",
			"result a-2",
			"answer",
		]);
		assert.deepEqual(
			reopened.eventsOfType("tool_execution_end").map((event) => event.toolCallId),
			["a-1", "a-2"],
		);
	});
});
