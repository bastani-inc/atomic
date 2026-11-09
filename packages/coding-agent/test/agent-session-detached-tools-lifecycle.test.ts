import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { DetachedToolCall } from "../src/core/agent-session-detached-tools.js";
import type { ToolDefinition } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { isToolDetachmentError } from "../src/core/tool-detachment-errors.js";
import {
	detachedResult,
	fastTool,
	harnessPool,
	persistedManager,
	registeredTool,
	reopenedAfterDetaching,
	settlesWithin,
	toolResultIds,
	transcriptRoles,
	untilStarted,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.js";
import { createHarness, getMessageText } from "./suite/harness.js";

const pool = harnessPool();
afterEach(() => pool.cleanup());
const harnessWith = pool.harnessWith;

/** A faux-provider turn with one scripted tool settles in milliseconds; this only turns a hang into a failure. */
const FAKE_TURN_SETTLE_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toolResultMessages(manager: SessionManager) {
	return manager.buildSessionProjection().messages.filter((message) => message.role === "toolResult");
}

function resultsById(calls: readonly DetachedToolCall[]): Promise<Record<string, Awaited<DetachedToolCall["result"]>>> {
	return Promise.all(calls.map((call) => call.result)).then((results) =>
		Object.fromEntries(results.map((result) => [result.toolCallId, result])),
	);
}

describe("a detachable call that has not detached yet (#4309)", () => {
	test("is aborted with its run", async () => {
		const tool = waitTool({ rejectOnAbort: true });
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("never requested")]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		await harness.session.abort();
		await settlesWithin(turn);

		assert.equal(tool.aborts.length, 1);
		assert.match(tool.aborts[0]!, /abort/i);
		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
	});

	test("is not aborted by its run once it has finished", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		const secondRequest = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			waitForCiTurn("ci-1"),
			async () => {
				secondRequest.resolve();
				await release.promise;
				return fauxAssistantMessage("late answer");
			},
		]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		tool.finish(0, "passed");
		await settlesWithin(secondRequest.promise);
		const aborting = harness.session.abort();
		release.resolve();
		await settlesWithin(Promise.all([aborting, turn]));

		assert.deepEqual(tool.aborts, []);
	});

	test("is not aborted while it runs inline within its threshold", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		await sleep(10);
		assert.deepEqual(tool.aborts, []);
		tool.finish(0, "passed");
		await settlesWithin(turn);

		assert.deepEqual(tool.aborts, []);
	});

	test("leaves no timer behind once it has finished", async () => {
		const THRESHOLD_MS = 123_457;
		const timers = vi.spyOn(globalThis, "setTimeout");
		const cleared = vi.spyOn(globalThis, "clearTimeout");
		try {
			const harness = await harnessWith([fastTool()]);
			harness.session.setToolDetachment({ afterMs: THRESHOLD_MS });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read_status", {}, { id: "status-1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("all green"),
			]);

			await harness.session.prompt("check");

			const armed = timers.mock.calls.flatMap((args, index) =>
				args[1] === THRESHOLD_MS ? [timers.mock.results[index]?.value] : [],
			);
			assert.equal(armed.length, 1);
			assert.ok(
				cleared.mock.calls.some(([handle]) => handle === armed[0]),
				"the call's threshold timer was cleared when the call finished",
			);
		} finally {
			timers.mockRestore();
			cleared.mockRestore();
		}
	});

	test("fails inline when its work fails within the threshold, instead of waiting out the threshold", async () => {
		const failing: ToolDefinition = {
			name: "wait_for_ci",
			label: "Wait for CI",
			description: "Waits for a CI run",
			parameters: Type.Object({ run: Type.String() }),
			detachable: true,
			execute: async () => {
				throw new Error("ci unreachable");
			},
		};
		const { manager } = await persistedManager();
		const harness = await harnessWith([failing], manager);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci is down")]);

		await settlesWithin(harness.session.prompt("watch ci"), FAKE_TURN_SETTLE_MS);

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(transcriptRoles(manager), ["user", "assistant", "toolResult", "assistant"]);
		const [result] = toolResultMessages(manager);
		assert.equal(result?.role === "toolResult" && result.isError, true);
		assert.match(getMessageText(result), /ci unreachable/);
	});
});

describe("what a detached call hands back (#4309)", () => {
	test("a call whose work fails after it detached hands back an error result", async () => {
		const ci = waitTool();
		const deploy = waitTool({ name: "wait_for_deploy" });
		const harness = await harnessWith([ci.definition, deploy.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
					fauxToolCall("wait_for_deploy", { run: "7" }, { id: "deploy-1" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await harness.session.prompt("ship it");
		const calls = harness.session.takeDetachedToolCalls();

		ci.fail(0, new Error("ci crashed"));
		deploy.fail(0, "plain failure");

		assert.deepEqual(await resultsById(calls), {
			"ci-1": {
				toolCallId: "ci-1",
				toolName: "wait_for_ci",
				result: { content: [{ type: "text", text: "ci crashed" }], details: undefined },
				isError: true,
			},
			"deploy-1": {
				toolCallId: "deploy-1",
				toolName: "wait_for_deploy",
				result: { content: [{ type: "text", text: "plain failure" }], details: undefined },
				isError: true,
			},
		});
	});

	test("a call whose work reports its own failure keeps it", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await harness.session.prompt("watch ci");
		const [call] = harness.session.takeDetachedToolCalls();

		tool.finishWith(0, { content: [{ type: "text", text: "3 tests failed" }], details: undefined, isError: true });

		assert.deepEqual(await call!.result, {
			toolCallId: "ci-1",
			toolName: "wait_for_ci",
			result: { content: [{ type: "text", text: "3 tests failed" }], details: undefined, isError: true },
			isError: true,
		});
	});

	test("the recorded result keeps what the call reported, and a failure stays a failure", async () => {
		const ci = waitTool();
		const deploy = waitTool({ name: "wait_for_deploy" });
		const turn = fauxAssistantMessage(
			[
				fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
				fauxToolCall("wait_for_deploy", { run: "7" }, { id: "deploy-1" }),
			],
			{ stopReason: "toolUse" },
		);
		const { reopened } = await reopenedAfterDetaching(pool, [ci.definition, deploy.definition], [turn]);
		const usage = {
			input: 11,
			output: 22,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 33,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const withoutContent = { ...detachedResult("deploy-1", "", { toolName: "wait_for_deploy", isError: true }) };
		(withoutContent.result as { content?: unknown }).content = undefined;
		reopened.setResponses([fauxAssistantMessage("noted")]);

		await reopened.session.resumeDetachedTurn([
			detachedResult("ci-1", "passed", { usage, details: { run: "7" } }),
			withoutContent,
		]);

		const [ciMessage, deployMessage] = toolResultMessages(reopened.sessionManager);
		assert.ok(ciMessage?.role === "toolResult" && deployMessage?.role === "toolResult");
		assert.deepEqual(ciMessage.usage, usage);
		assert.deepEqual(ciMessage.details, { run: "7" });
		assert.equal(ciMessage.isError, false);
		assert.equal("usage" in deployMessage, false);
		assert.deepEqual(deployMessage.content, []);
		assert.equal(deployMessage.isError, true);
	});
});

describe("a detached call's placeholder (#4309)", () => {
	test("reaches no subscriber, extension handler or transcript, while the batch's other result does", async () => {
		const resultsSeenByExtension: string[] = [];
		const turnEndsSeenByExtension: string[][] = [];
		const ci = waitTool();
		const harness = await harnessWith([ci.definition, fastTool()], undefined, [
			(pi) => {
				pi.on("tool_result", (event) => {
					resultsSeenByExtension.push(event.toolCallId);
				});
				pi.on("turn_end", (event) => {
					turnEndsSeenByExtension.push(event.toolResults.map((result) => result.toolCallId));
				});
			},
		]);
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

		const idsOf = (messages: readonly { readonly role: string; readonly toolCallId?: string }[]) =>
			messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.deepEqual(resultsSeenByExtension, ["status-1"]);
		assert.deepEqual(turnEndsSeenByExtension, [["status-1"]]);
		assert.deepEqual(
			harness.eventsOfType("turn_end").map((event) => event.toolResults.map((result) => result.toolCallId)),
			[["status-1"]],
		);
		assert.deepEqual(
			harness.eventsOfType("tool_execution_end").map((event) => event.toolCallId),
			["status-1"],
		);
		for (const type of ["message_start", "message_end"] as const)
			assert.deepEqual(idsOf(harness.eventsOfType(type).map((event) => event.message)), ["status-1"]);
		const [agentEnd] = harness.eventsOfType("agent_end");
		assert.deepEqual(idsOf(agentEnd?.messages ?? []), ["status-1"]);
		assert.ok(agentEnd?.messages.some((message) => message.role === "assistant"));
		assert.deepEqual(idsOf(harness.session.messages), ["status-1"]);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["status-1"]);
	});

	test("the call's turn still ends the run when a queued follow-up waits", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 150 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("must wait for the result")]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		await harness.session.followUp("and check lint");
		await settlesWithin(turn);

		assert.equal(harness.getPendingResponseCount(), 1);
		assert.deepEqual(transcriptRoles(harness.sessionManager), ["user", "assistant"]);
		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
	});

	test("a call that is still held does not hide a later run's events", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("anything else?")]);
		await harness.session.prompt("watch ci");

		await harness.session.prompt("what else is there to do?");

		assert.equal(harness.eventsOfType("agent_start").length, 2);
		assert.equal(harness.eventsOfType("agent_end").length, 2);
		const answers = harness
			.eventsOfType("message_end")
			.flatMap((event) => (event.message.role === "assistant" ? [getMessageText(event.message)] : []));
		assert.deepEqual(answers.at(-1), "anything else?");
	});
});

describe("the registered detachable tool (#4309)", () => {
	test("runs a call nested in another tool inline, whether or not the turn has any call", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		const wrapped = registeredTool(harness, "wait_for_ci");

		// Nothing in the session issued this call: it is not the model's call to detach.
		const beforeAnyTurn = wrapped.execute("nested-0", { run: "1" }, undefined, undefined);
		await untilStarted(tool);
		await sleep(30);
		tool.finish(0, "nested result");
		assert.deepEqual((await settlesWithin(beforeAnyTurn)).content, [{ type: "text", text: "nested result" }]);

		harness.setResponses([waitForCiTurn("ci-1")]);
		await harness.session.prompt("watch ci");
		harness.session.takeDetachedToolCalls();

		// The turn issued only `ci-1`.
		const nested = wrapped.execute("nested-1", { run: "2" }, undefined, undefined);
		await untilStarted(tool, 3);
		await sleep(30);
		tool.finish(2, "other nested result");
		const result = await settlesWithin(nested);
		assert.deepEqual(result.content, [{ type: "text", text: "other nested result" }]);
		assert.notEqual(result.terminate, true);
		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
	});

	test("answers a detaching call with a placeholder that ends the turn, even without a signal", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await harness.session.prompt("watch ci");
		harness.session.takeDetachedToolCalls();

		const placeholder = await settlesWithin(
			registeredTool(harness, "wait_for_ci").execute("ci-1", { run: "7" }, undefined, undefined),
		);

		assert.equal(placeholder.terminate, true);
		const [text] = placeholder.content;
		assert.equal(text?.type, "text");
		assert.ok(text?.type === "text" && text.text.length > 0);
		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.deepEqual(tool.aborts, []);
	});

	test("refuses a call whose signal was already aborted before its work starts, as every scheduled call is", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await harness.session.prompt("watch ci");
		for (const call of harness.session.takeDetachedToolCalls()) call.abort("test over");

		await assert.rejects(
			settlesWithin(
				registeredTool(harness, "wait_for_ci").execute(
					"ci-2",
					{ run: "7" },
					AbortSignal.abort("stage quit"),
					undefined,
				),
			),
			/Operation aborted/,
		);

		assert.deepEqual(
			tool.calls.map((call) => call.id),
			["ci-1"],
		);
		assert.deepEqual(tool.aborts, ["test over"]);
	});
});

describe("a detachable call after another call of its batch (#4309)", () => {
	test("detaches although an earlier call of the batch has already recorded its result", async () => {
		const ci = waitTool();
		const sequential: ToolDefinition = { ...fastTool(), name: "read_in_order", executionMode: "sequential" };
		const harness = await harnessWith([ci.definition, sequential]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read_in_order", {}, { id: "status-1" }),
					fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("never requested"),
		]);

		await settlesWithin(harness.session.prompt("check, then watch ci"), FAKE_TURN_SETTLE_MS);

		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["status-1"]);
		assert.equal(harness.getPendingResponseCount(), 1);
	});
});

describe("the detachment policy (#4309)", () => {
	test("a call within the threshold runs inline although it takes a while", async () => {
		const tool = waitTool();
		const { manager } = await persistedManager();
		const harness = await harnessWith([tool.definition], manager);
		harness.session.setToolDetachment({ afterMs: 5_000 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		await sleep(40);
		tool.finish(0, "passed");
		await settlesWithin(turn);

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(transcriptRoles(manager), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(getMessageText(toolResultMessages(manager)[0]), "passed");
	});

	test("clearing the policy runs long calls inline again", async () => {
		const tool = waitTool();
		const { manager } = await persistedManager();
		const harness = await harnessWith([tool.definition], manager);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.session.setToolDetachment(undefined);
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		await sleep(20);
		tool.finish(0, "passed");
		await settlesWithin(turn);

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(transcriptRoles(manager), ["user", "assistant", "toolResult", "assistant"]);
	});

	test("a call with no policy at all runs inline and reports its real result", async () => {
		const tool = waitTool();
		const { manager } = await persistedManager();
		const harness = await harnessWith([tool.definition], manager);
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);

		const turn = harness.session.prompt("watch ci");
		await untilStarted(tool);
		tool.finish(0, "passed");
		await settlesWithin(turn);

		const [result] = toolResultMessages(manager);
		assert.equal(result?.role === "toolResult" && result.isError, false);
		assert.equal(getMessageText(result), "passed");
	});

	test("setting the policy again keeps what was detached", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await harness.session.prompt("watch ci");

		harness.session.setToolDetachment({ afterMs: 5 });

		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
	});

	test("setting the policy on a reopened session keeps how its tools start", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);

		reopened.session.setToolDetachment({ afterMs: 0 });
		const [call] = reopened.session.redispatchDetachedToolCalls();
		await untilStarted(tool, 2);
		tool.finish(1, "passed");

		assert.deepEqual(tool.calls, [
			{ id: "ci-1", args: { run: "7" } },
			{ id: "ci-1", args: { run: "7" } },
		]);
		assert.equal((await call!.result).isError, false);
	});

	test("rebinding extensions keeps the policy", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.setResponses([waitForCiTurn("ci-1")]);

		await settlesWithin(harness.session.prompt("watch ci"), FAKE_TURN_SETTLE_MS);

		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
	});

	test("a session without detachable tools has nothing detached, pending or to start", async () => {
		const harness = await harnessWith([]);

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(harness.session.redispatchDetachedToolCalls(), []);
		assert.equal(harness.session.hasPendingDetachedTurn(), false);
		await harness.session.resumeDetachedTurn([]);
		assert.deepEqual(transcriptRoles(harness.sessionManager), []);
	});
});

describe("which transcripts are waiting on a detached call (#4309)", () => {
	test("a user message after the call means the turn moved on", async () => {
		const tool = waitTool();
		const {
			reopened: unused,
			store,
			sessionId,
		} = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		void unused;
		const writer = await SessionManager.open(store, sessionId);
		await writer.appendMessage({ role: "user", content: "never mind the build", timestamp: Date.now() });
		const reopened = await harnessWith([tool.definition], await SessionManager.open(store, sessionId));

		assert.equal(reopened.session.hasPendingDetachedTurn(), false);
		assert.deepEqual(reopened.session.redispatchDetachedToolCalls(), []);
		// The call's turn is behind the transcript (#4580): its result is dropped, not refused.
		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(toolResultIds(reopened.sessionManager), []);
	});

	test("calls of a tool the session does not have are not pending", async () => {
		const tool = waitTool();
		const { store, sessionId } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		const reopened = await harnessWith([], await SessionManager.open(store, sessionId));

		assert.equal(reopened.session.hasPendingDetachedTurn(), false);
		assert.deepEqual(reopened.session.redispatchDetachedToolCalls(), []);
	});

	test("a tool registered again without detachable is no longer detachable in that session", async () => {
		const tool = waitTool();
		const { store, sessionId } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		let register: ((definition: ToolDefinition) => void) | undefined;
		const reopened = await harnessWith([], await SessionManager.open(store, sessionId), [
			(pi) => {
				register = (definition) => pi.registerTool(definition);
				pi.registerTool(tool.definition);
			},
		]);
		assert.equal(reopened.session.hasPendingDetachedTurn(), true);

		const { detachable: _detachable, ...inline } = tool.definition;
		register?.(inline);

		assert.equal(reopened.session.hasPendingDetachedTurn(), false);
		assert.deepEqual(reopened.session.redispatchDetachedToolCalls(), []);
	});

	test("a call restarted for a reopened session is not reported as interrupted meanwhile", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(
			pool,
			[tool.definition],
			[
				fauxAssistantMessage(
					[fauxText("checking the build"), fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })],
					{
						stopReason: "toolUse",
					},
				),
			],
		);
		const roles = () => reopened.session.messages.map((message) => message.role);

		reopened.session.refreshContext();
		assert.deepEqual(roles(), ["system", "user", "assistant", "toolResult"]);

		reopened.session.redispatchDetachedToolCalls();
		reopened.session.refreshContext();
		assert.deepEqual(roles(), ["system", "user", "assistant"]);
	});
});

describe("resuming a detached turn (#4309)", () => {
	test("tells subscribers about the result the way a live call does, then the model's answer", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		reopened.setResponses([fauxAssistantMessage("ci passed")]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		const seen = reopened.events.flatMap((event) => {
			if (event.type === "tool_execution_end") return [`tool_execution_end:${event.toolCallId}`];
			if (event.type === "message_start" || event.type === "message_end")
				return [`${event.type}:${event.message.role}`];
			return [];
		});
		assert.deepEqual(seen, [
			"tool_execution_end:ci-1",
			"message_start:toolResult",
			"message_end:toolResult",
			"message_start:assistant",
			"message_end:assistant",
		]);
	});

	test("does not continue a batch until every call of it has its result", async () => {
		const ci = waitTool();
		const contexts: { id: string; text: string; isError: boolean }[][] = [];
		const turn = fauxAssistantMessage(
			[
				fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
				fauxToolCall("read_status", {}, { id: "status-1" }),
			],
			{ stopReason: "toolUse" },
		);
		const { reopened } = await reopenedAfterDetaching(pool, [ci.definition, fastTool()], [turn]);
		reopened.setResponses([
			(context) => {
				contexts.push(
					context.messages.flatMap((message) =>
						message.role === "toolResult"
							? [{ id: message.toolCallId, text: getMessageText(message), isError: message.isError }]
							: [],
					),
				);
				return fauxAssistantMessage("ci passed");
			},
		]);
		assert.equal(reopened.session.hasPendingDetachedTurn(), true);

		await reopened.session.resumeDetachedTurn([]);

		assert.equal(reopened.getPendingResponseCount(), 1);
		assert.deepEqual(toolResultIds(reopened.sessionManager), ["status-1"]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.equal(reopened.getPendingResponseCount(), 0);
		assert.deepEqual(contexts, [
			[
				{ id: "status-1", text: "green", isError: false },
				{ id: "ci-1", text: "passed", isError: false },
			],
		]);
		assert.deepEqual(transcriptRoles(reopened.sessionManager), [
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	test("sends the model every result of a batch as the call reported it, never as interrupted", async () => {
		const ci = waitTool();
		const deploy = waitTool({ name: "wait_for_deploy" });
		const contexts: { id: string; text: string; isError: boolean }[][] = [];
		const turn = fauxAssistantMessage(
			[
				fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
				fauxToolCall("wait_for_deploy", { run: "7" }, { id: "deploy-1" }),
			],
			{ stopReason: "toolUse" },
		);
		const { reopened } = await reopenedAfterDetaching(pool, [ci.definition, deploy.definition], [turn]);
		reopened.setResponses([
			(context) => {
				contexts.push(
					context.messages.flatMap((message) =>
						message.role === "toolResult"
							? [{ id: message.toolCallId, text: getMessageText(message), isError: message.isError }]
							: [],
					),
				);
				return fauxAssistantMessage("shipped");
			},
		]);

		await reopened.session.resumeDetachedTurn([
			detachedResult("ci-1", "ci passed"),
			detachedResult("deploy-1", "deployed", { toolName: "wait_for_deploy" }),
		]);

		assert.deepEqual(contexts, [
			[
				{ id: "ci-1", text: "ci passed", isError: false },
				{ id: "deploy-1", text: "deployed", isError: false },
			],
		]);
		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1", "deploy-1"]);
	});

	test("never sends the model a reopened stage's pending call as interrupted once its result is delivered (#4589)", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		const toolResultTexts = (messages: readonly { role: string }[]): string[] =>
			messages.flatMap((message) => (message.role === "toolResult" ? [getMessageText(message as never)] : []));
		const requests: string[][] = [];
		reopened.setResponses([
			(context) => {
				requests.push(toolResultTexts(context.messages));
				return fauxAssistantMessage("ci passed");
			},
		]);

		await reopened.session.startPendingRecovery("workflow_stage_resume");
		reopened.session.refreshContext();
		assert.deepEqual(toolResultTexts(reopened.session.messages), [], "the pending call is not closed while it waits");

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual(requests, [["passed"]]);
		assert.deepEqual(toolResultTexts(reopened.session.messages), ["passed"]);
	});

	test("refuses a second resume that starts while the first has not begun streaming", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		reopened.setResponses([fauxAssistantMessage("ci passed")]);
		const result = detachedResult("ci-1", "passed");

		const first = reopened.session.resumeDetachedTurn([result]);
		const second = reopened.session.resumeDetachedTurn([result]);

		await assert.rejects(second, (error: Error) => {
			assert.ok(isToolDetachmentError(error));
			assert.equal(error.code, "session-busy");
			assert.equal(error.retryable, true);
			assert.equal(error.fields.sessionId, reopened.sessionManager.getSessionId());
			return true;
		});
		await first;
		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1"]);
		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
	});

	test("refuses to resume while a run the session did not count is streaming", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		const requested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		reopened.setResponses([
			async () => {
				requested.resolve();
				await release.promise;
				return fauxAssistantMessage("direct answer");
			},
		]);

		const direct = reopened.session.agent.prompt("a question that bypasses the session");
		await settlesWithin(requested.promise);

		await assert.rejects(
			reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]),
			(error: Error) => isToolDetachmentError(error) && error.code === "session-busy",
		);
		release.resolve();
		await direct;
	});

	test("refuses to resume a session that was closed, with the closed-session error, and records nothing (#4309)", async () => {
		const tool = waitTool();
		const { reopened, store, sessionId } = await reopenedAfterDetaching(
			pool,
			[tool.definition],
			[waitForCiTurn("ci-1")],
		);
		await reopened.session.dispose();

		await assert.rejects(reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]), (error: Error) => {
			assert.ok(isToolDetachmentError(error));
			assert.equal(error.code, "session-closed");
			assert.equal(error.retryable, false);
			assert.deepEqual(error.fields, { sessionId });
			return true;
		});
		assert.deepEqual(toolResultIds(await SessionManager.open(store, sessionId)), []);
		// The results stay with the caller: a session reopened from the store takes them.
		const next = await harnessWith([tool.definition], await SessionManager.open(store, sessionId));
		next.setResponses([fauxAssistantMessage("ci passed")]);
		await next.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(toolResultIds(next.sessionManager), ["ci-1"]);
	});

	test("input sent while the continued turn starts queues behind it", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		reopened.setResponses([fauxAssistantMessage("ci passed"), fauxAssistantMessage("lint is clean")]);

		const resumed = reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		await reopened.session.prompt("and check lint", { streamingBehavior: "followUp" });
		await resumed;
		await vi.waitFor(() => assert.equal(reopened.getPendingResponseCount(), 0));

		assert.deepEqual(transcriptRoles(reopened.sessionManager), [
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"user",
			"assistant",
		]);
	});
});

describe("resuming around other calls of the batch (#4309)", () => {
	test("records the detached result of a batch whose other call never got one, and continues", async () => {
		const ci = waitTool();
		const plain: ToolDefinition = { ...fastTool(), name: "read_plain", detachable: false };
		const { manager, store } = await persistedManager();
		await manager.appendMessage({ role: "user", content: "check, then watch ci", timestamp: Date.now() });
		await manager.appendMessage(
			fauxAssistantMessage(
				[
					fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
					fauxToolCall("read_plain", {}, { id: "plain-1" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		const reopened = await harnessWith(
			[ci.definition, plain],
			await SessionManager.open(store, manager.getSessionId()),
		);
		reopened.setResponses([fauxAssistantMessage("ci passed")]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual(toolResultIds(reopened.sessionManager), ["ci-1"]);
		assert.deepEqual(transcriptRoles(reopened.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
	});

	test("a subscriber that refreshes the context while results are recorded sees the calls still to come as pending", async () => {
		const ci = waitTool();
		const deploy = waitTool({ name: "wait_for_deploy" });
		const turn = fauxAssistantMessage(
			[
				fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
				fauxToolCall("wait_for_deploy", { run: "7" }, { id: "deploy-1" }),
			],
			{ stopReason: "toolUse" },
		);
		const { reopened } = await reopenedAfterDetaching(pool, [ci.definition, deploy.definition], [turn]);
		reopened.setResponses([fauxAssistantMessage("shipped")]);
		const seen: string[][] = [];
		reopened.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return;
			if (event.message.toolCallId !== "ci-1") return;
			reopened.session.refreshContext();
			seen.push(
				reopened.session.messages.flatMap((message) =>
					message.role === "toolResult" ? [`${message.toolCallId}: ${getMessageText(message)}`] : [],
				),
			);
		});

		await reopened.session.resumeDetachedTurn([
			detachedResult("ci-1", "ci passed"),
			detachedResult("deploy-1", "deployed", { toolName: "wait_for_deploy" }),
		]);

		assert.deepEqual(seen, [["ci-1: ci passed"]]);
	});
});

describe("a turn the host ends (#4309)", () => {
	test("leaves queued input queued, as a detached turn does", async () => {
		const harness = await createHarness({ finishTurn: async () => ({ action: "end" }) });
		try {
			harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("must wait")]);
			await harness.session.followUp("and then?");

			await settlesWithin(harness.session.prompt("start"));

			assert.equal(harness.getPendingResponseCount(), 1);
			assert.deepEqual(transcriptRoles(harness.sessionManager), ["user", "assistant"]);
		} finally {
			await harness.cleanup();
		}
	});
});

describe("results handed back to the session that detached the call (#4309)", () => {
	test("record the result and leave nothing detached", async () => {
		const tool = waitTool();
		const harness = await harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);
		await harness.session.prompt("watch ci");

		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(transcriptRoles(harness.sessionManager), ["user", "assistant", "toolResult", "assistant"]);
		assert.deepEqual(
			harness.eventsOfType("tool_execution_end").map((event) => event.toolCallId),
			["ci-1"],
		);
	});
});
