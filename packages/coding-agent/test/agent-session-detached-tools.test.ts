import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { DetachedToolCall } from "../src/core/agent-session-detached-tools.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { isToolDetachmentError, MAX_TOOL_DETACHMENT_AFTER_MS, ToolDetachmentError } from "../src/index.js";
import {
	fastTool,
	harnessPool,
	persistedManager,
	toolResultIds,
	transcriptRoles,
	waitTool,
} from "./helpers/detached-tools.js";
import { getMessageText } from "./suite/harness.js";

const pool = harnessPool();
afterEach(() => pool.cleanup());
const harnessWith = pool.harnessWith;

describe("detachable tool calls (#4309)", () => {
	test("a call that finishes before the threshold runs inline", async () => {
		const harness = await harnessWith([fastTool()]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read_status", {}, { id: "status-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("all green"),
		]);

		await harness.session.prompt("check");

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(transcriptRoles(harness.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(getMessageText(harness.session.messages.at(-1)), "all green");
	});

	test("without a policy a long call runs inline", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ci passed"),
		]);

		const turn = harness.session.prompt("watch ci");
		while (tool.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
		tool.finish(0, "passed");
		await turn;

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["ci-1"]);
	});

	test("a call past the threshold detaches: the call is saved, no result is, and the run ends", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("never requested"),
		]);

		await harness.session.prompt("watch ci");

		const detached = harness.session.takeDetachedToolCalls();
		assert.deepEqual(
			detached.map((call) => [call.toolCallId, call.toolName]),
			[["ci-1", "wait_for_ci"]],
		);
		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(transcriptRoles(harness.sessionManager), ["user", "assistant"]);
		assert.equal(harness.session.messages.at(-1)?.role, "assistant");
		assert.equal(harness.getPendingResponseCount(), 1);
		assert.deepEqual(
			harness.eventsOfType("tool_execution_end").map((event) => event.toolCallId),
			[],
		);
		assert.deepEqual(
			harness.eventsOfType("turn_end").flatMap((event) => event.toolResults),
			[],
		);
		tool.finish(0, "passed");
		const result = await detached[0]!.result;
		assert.deepEqual(result, {
			toolCallId: "ci-1",
			toolName: "wait_for_ci",
			result: { content: [{ type: "text", text: "passed" }], details: undefined },
			isError: false,
		});
	});

	test("sibling results of a detached batch are saved and the run still ends", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition, fastTool()]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
					fauxToolCall("read_status", {}, { id: "status-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("never requested"),
		]);

		await harness.session.prompt("watch ci");

		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["status-1"]);
		assert.equal(harness.getPendingResponseCount(), 1);
	});

	test("a reopened session records the result as its call's result and continues the same turn", async () => {
		const tool = waitTool();
		const { manager, store } = await persistedManager();
		const first = await harnessWith([tool.definition], manager);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		await first.session.prompt("watch ci");
		const [call] = first.session.takeDetachedToolCalls();
		const sessionId = manager.getSessionId();
		tool.finish(0, "passed");
		const result = await call!.result;

		const reopened = await harnessWith([tool.definition], await SessionManager.open(store, sessionId));
		reopened.setResponses([fauxAssistantMessage("ci passed, merging")]);
		await reopened.session.resumeDetachedTurn([result, result]);

		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1"]);
		assert.equal(getMessageText(reopened.session.messages.at(-1)), "ci passed, merging");
		assert.deepEqual(
			reopened.eventsOfType("tool_execution_end").map((event) => [event.toolCallId, event.isError]),
			[["ci-1", false]],
		);
		await reopened.session.resumeDetachedTurn([result]);
		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1"]);
	});

	test("a reopened session starts its pending detachable calls again with their ids and arguments", async () => {
		const tool = waitTool();
		const { manager, store } = await persistedManager();
		const first = await harnessWith([tool.definition], manager);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		await first.session.prompt("watch ci");
		first.session.takeDetachedToolCalls();

		const reopened = await harnessWith([tool.definition], await SessionManager.open(store, manager.getSessionId()));
		const redispatched: DetachedToolCall[] = reopened.session.redispatchDetachedToolCalls();
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(
			redispatched.map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.deepEqual(tool.calls, [
			{ id: "ci-1", args: { run: "7" } },
			{ id: "ci-1", args: { run: "7" } },
		]);
		redispatched[0]!.abort("stage quit");
		assert.deepEqual(tool.aborts, ["stage quit"]);
		tool.finish(1, "passed");
		reopened.setResponses([fauxAssistantMessage("done")]);
		await reopened.session.resumeDetachedTurn([await redispatched[0]!.result]);
		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1"]);
		assert.deepEqual(reopened.session.redispatchDetachedToolCalls(), []);
	});

	async function sessionStoppedAfterResult(
		turn: Parameters<typeof fauxAssistantMessage>[0] = [fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })],
	): Promise<{
		readonly store: MemorySessionStore;
		readonly sessionId: string;
	}> {
		const tool = waitTool();
		const { manager, store } = await persistedManager();
		const first = await harnessWith([tool.definition], manager);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([fauxAssistantMessage(turn, { stopReason: "toolUse" })]);
		await first.session.prompt("watch ci");
		first.session.takeDetachedToolCalls();
		// The process saved the call's result and stopped before the model answered.
		const stopped = await SessionManager.open(store, manager.getSessionId());
		await stopped.appendMessage({
			role: "toolResult",
			toolCallId: "ci-1",
			toolName: "wait_for_ci",
			content: [{ type: "text", text: "passed" }],
			isError: false,
			timestamp: Date.now(),
		});
		return { store, sessionId: manager.getSessionId() };
	}

	test("a reopened session whose transcript ends on its detached call's result continues that turn without a new user message", async () => {
		const { store, sessionId } = await sessionStoppedAfterResult();
		const tool = waitTool();
		const reopened = await harnessWith([tool.definition], await SessionManager.open(store, sessionId));
		assert.equal(reopened.session.hasPendingDetachedTurn(), true);
		assert.deepEqual(reopened.session.redispatchDetachedToolCalls(), []);
		reopened.setResponses([fauxAssistantMessage("ci passed, merging")]);
		await reopened.session.resumeDetachedTurn([]);

		assert.deepEqual(tool.calls, []);
		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(getMessageText(reopened.session.messages.at(-1)), "ci passed, merging");
		assert.equal(reopened.session.hasPendingDetachedTurn(), false);
		await reopened.session.resumeDetachedTurn([]);
		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
	});

	test("a turn that wrote text and thinking before its detached call continues once that call has its result", async () => {
		const { store, sessionId } = await sessionStoppedAfterResult([
			fauxThinking("the build decides"),
			fauxText("checking the build"),
			fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
		]);
		const reopened = await harnessWith([waitTool().definition], await SessionManager.open(store, sessionId));
		reopened.setResponses([fauxAssistantMessage("ci passed, merging")]);

		await reopened.session.resumeDetachedTurn([]);

		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(getMessageText(reopened.session.messages.at(-1)), "ci passed, merging");
	});

	test("a transcript that ends on answered calls of tools that cannot detach is not a detached turn", async () => {
		const { store, sessionId } = await sessionStoppedAfterResult();
		const reopened = await harnessWith(
			[waitTool({ detachable: false }).definition],
			await SessionManager.open(store, sessionId),
		);
		reopened.setResponses([fauxAssistantMessage("unexpected")]);
		assert.equal(reopened.session.hasPendingDetachedTurn(), false);
		await reopened.session.resumeDetachedTurn([]);
		assert.equal(reopened.getPendingResponseCount(), 1);
		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant", "toolResult"]);
	});

	test("a transcript still waiting on a detached call does not continue without its result", async () => {
		const tool = waitTool();
		const { manager, store } = await persistedManager();
		const first = await harnessWith([tool.definition], manager);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		await first.session.prompt("watch ci");
		first.session.takeDetachedToolCalls();

		const reopened = await harnessWith([tool.definition], await SessionManager.open(store, manager.getSessionId()));
		reopened.setResponses([fauxAssistantMessage("unexpected")]);
		assert.equal(reopened.session.hasPendingDetachedTurn(), true);
		await reopened.session.resumeDetachedTurn([]);
		assert.equal(reopened.getPendingResponseCount(), 1);
		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant"]);
	});

	test("a call that is not detachable never detaches", async () => {
		const tool = waitTool({ detachable: false });
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ci passed"),
		]);

		const turn = harness.session.prompt("watch ci");
		while (tool.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setTimeout(resolve, 5));
		tool.finish(0, "passed");
		await turn;

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["ci-1"]);
	});
});

describe("ToolDetachmentError (#4309)", () => {
	test("rejects an invalid policy before changing anything", async () => {
		const harness = await harnessWith([fastTool()]);
		const sessionId = harness.sessionManager.getSessionId();

		let thrown: Error | undefined;
		try {
			harness.session.setToolDetachment({ afterMs: Number.NaN });
		} catch (error) {
			thrown = error as Error;
		}

		assert.ok(thrown instanceof ToolDetachmentError);
		assert.ok(isToolDetachmentError(thrown));
		assert.equal(thrown.code, "invalid-policy");
		assert.equal(thrown.retryable, false);
		assert.deepEqual(thrown.fields, { sessionId, field: "afterMs", value: "NaN" });
		assert.equal(
			thrown.message,
			`Invalid tool detachment policy for session ${sessionId}: afterMs is NaN (invalid-policy). Pass a policy whose afterMs is a finite number of milliseconds from 0 to 2147483647, or undefined.`,
		);
		assert.throws(() => harness.session.setToolDetachment({ afterMs: -1 }), { code: "invalid-policy" });
	});

	test("accepts afterMs up to the largest timer delay and rejects one past it, which a timer would clamp to 1 ms (#4309)", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		const sessionId = harness.sessionManager.getSessionId();
		harness.session.setToolDetachment({ afterMs: MAX_TOOL_DETACHMENT_AFTER_MS });

		assert.throws(
			() => harness.session.setToolDetachment({ afterMs: MAX_TOOL_DETACHMENT_AFTER_MS + 1 }),
			(error: Error) => {
				assert.ok(isToolDetachmentError(error));
				assert.equal(error.code, "invalid-policy");
				assert.deepEqual(error.fields, { sessionId, field: "afterMs", value: "2147483648" });
				return true;
			},
		);
		// The rejected policy changed nothing: a call still waits out the largest threshold inline.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ci passed"),
		]);
		const turn = harness.session.prompt("watch ci");
		while (tool.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		tool.finish(0, "passed");
		await turn;
		assert.deepEqual(toolResultIds(harness.sessionManager), ["ci-1"]);
	});

	test("refuses a result for a call the transcript is not waiting on", async () => {
		const harness = await harnessWith([fastTool()]);
		const sessionId = harness.sessionManager.getSessionId();

		await assert.rejects(
			harness.session.resumeDetachedTurn([
				{
					toolCallId: "elsewhere",
					toolName: "wait_for_ci",
					result: { content: [], details: undefined },
					isError: false,
				},
			]),
			(error: Error) =>
				isToolDetachmentError(error) &&
				error.code === "unknown-tool-call" &&
				error.retryable === false &&
				error.fields.toolCallId === "elsewhere" &&
				error.fields.sessionId === sessionId,
		);
		assert.deepEqual(transcriptRoles(harness.sessionManager), []);
	});

	test("refuses to resume while the session is still running", async () => {
		const tool = waitTool({ detachable: false });
		const harness = await harnessWith([tool.definition]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ci passed"),
		]);
		const turn = harness.session.prompt("watch ci");
		while (tool.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));

		await assert.rejects(harness.session.resumeDetachedTurn([]), (error: Error) => {
			assert.ok(isToolDetachmentError(error));
			assert.equal(error.code, "session-busy");
			assert.equal(error.retryable, true);
			return true;
		});
		tool.finish(0, "passed");
		await turn;
	});

	test("recognizes a structural copy from another realm", () => {
		const copy = { name: "ToolDetachmentError", code: "session-busy", message: "copied" };
		assert.equal(isToolDetachmentError(copy), true);
		assert.equal(isToolDetachmentError({ ...copy, code: "other" }), false);
		assert.equal(isToolDetachmentError({ ...copy, name: "Error" }), false);
		assert.equal(isToolDetachmentError("ToolDetachmentError"), false);
		assert.equal(isToolDetachmentError(null), false);
	});
});
