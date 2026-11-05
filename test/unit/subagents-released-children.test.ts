import assert from "node:assert/strict";
import {
	type AgentRehydrateError,
	AgentWakeDispatcher,
	type DetachedToolCall,
	type DetachedToolResult,
	type ExtensionContext,
} from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SUBAGENT_RELEASED_CHILD_WAKE_EVENT as INTERCOM_RELEASED_CHILD_WAKE_EVENT } from "../../packages/intercom/session-recovery.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import {
	isReleasedChildError,
	type ReleasedChildError,
} from "../../packages/subagents/src/runs/foreground/released-child-errors.js";
import {
	reserveReleasedChildTargets,
	SUBAGENT_HOLD_FAILURE_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	bindReleasedChildWakes,
	SUBAGENT_RELEASED_CHILD_WAKE_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	decideReleasedChildWake,
	forwardDetachedResults,
	handleReleasedChildWakes,
	lateToolResultMessage,
	pendingToolCalls,
	planReleasedChildWake,
	SUBAGENT_RELEASE_AFTER_MS,
	SUBAGENT_STILL_RUNNING_RESULT,
	subagentReleasePolicy,
	subagentWakeKey,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import { SUBAGENT_RESERVE_RESTORING_CHILD_EVENT } from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";

function result(toolCallId: string, text = `${toolCallId} done`, isError = false): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text }], details: undefined },
		isError,
	};
}

function stillRunning(toolCallId: string): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text: SUBAGENT_STILL_RUNNING_RESULT }], details: undefined },
		isError: false,
	};
}

const pending = new Map([
	["ci-1", "wait_for_ci"],
	["ci-2", "wait_for_ci"],
]);

test("results for every pending call alone continue the turn with no prompt (#4326)", () => {
	assert.deepEqual(planReleasedChildWake(pending, [result("ci-2"), result("ci-1")], false), {
		resumeToolResults: [result("ci-2"), result("ci-1")],
		lateMessages: [],
		skipPrompt: true,
	});
});

test("a partial result marks the other pending calls still running and still needs no prompt (#4326)", () => {
	assert.deepEqual(planReleasedChildWake(pending, [result("ci-1")], false), {
		resumeToolResults: [result("ci-1"), stillRunning("ci-2")],
		lateMessages: [],
		skipPrompt: true,
	});
});

test("a message wake answers every pending call first, then prompts (#4326)", () => {
	assert.deepEqual(planReleasedChildWake(pending, [], true), {
		resumeToolResults: [stillRunning("ci-1"), stillRunning("ci-2")],
		lateMessages: [],
		skipPrompt: false,
	});
});

test("results for calls already answered become messages, once each, in arrival order (#4326)", () => {
	const late = result("old-1", "old output", true);
	assert.deepEqual(planReleasedChildWake(new Map(), [late, result("old-2"), late], false), {
		resumeToolResults: [],
		lateMessages: [lateToolResultMessage(late), lateToolResultMessage(result("old-2"))],
		skipPrompt: false,
	});
	assert.equal(
		lateToolResultMessage(late),
		"The wait_for_ci call old-1 that kept running in the background failed:\nold output",
	);
	assert.match(lateToolResultMessage(result("x")), /finished:\nx done$/);
	const empty: DetachedToolResult = { ...result("y"), result: { content: [], details: undefined } };
	assert.match(lateToolResultMessage(empty), /\(no output\)$/);
	const missing = { ...result("w"), result: { details: undefined } } as unknown as DetachedToolResult;
	assert.match(lateToolResultMessage(missing), /\(no output\)$/);
	const parts: DetachedToolResult = {
		...result("v"),
		result: {
			content: [
				{ type: "text", text: "  first" },
				{ type: "text", text: "second  " },
			],
			details: undefined,
		},
	};
	assert.match(lateToolResultMessage(parts), /finished:\nfirst\nsecond$/);
	const image: DetachedToolResult = {
		...result("z"),
		result: { content: [{ type: "image", data: "", mimeType: "image/png" }], details: undefined },
	};
	assert.match(lateToolResultMessage(image), /\[image\]$/);
});

test("with no pending call and nothing else, an empty wake prompts nothing new (#4326)", () => {
	assert.deepEqual(planReleasedChildWake(new Map(), [], false), {
		resumeToolResults: [],
		lateMessages: [],
		skipPrompt: true,
	});
});

test("the pending calls are the last assistant turn's calls without results (#4326)", async () => {
	const manager = SessionManager.inMemory("/repo");
	assert.deepEqual([...pendingToolCalls(manager)], []);
	await manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
	const assistant = (content: object[], stopReason: string) =>
		({
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 2,
		}) as Parameters<SessionManager["appendMessage"]>[0];
	await manager.appendMessage(
		assistant(
			[
				{ type: "text", text: "waiting" },
				{ type: "toolCall", id: "ci-1", name: "wait_for_ci", arguments: {} },
				{ type: "toolCall", id: "ci-2", name: "deploy", arguments: {} },
			],
			"toolUse",
		),
	);
	assert.deepEqual(
		[...pendingToolCalls(manager)],
		[
			["ci-1", "wait_for_ci"],
			["ci-2", "deploy"],
		],
	);
	await manager.appendMessage({
		role: "toolResult",
		toolCallId: "ci-2",
		toolName: "deploy",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 3,
	});
	assert.deepEqual([...pendingToolCalls(manager)], [["ci-1", "wait_for_ci"]]);
	await manager.appendMessage({ role: "user", content: "moved on", timestamp: 4 });
	assert.deepEqual([...pendingToolCalls(manager)], [], "a later turn moved past the call");
	await manager.appendMessage(assistant([{ type: "text", text: "done" }], "stop"));
	assert.deepEqual([...pendingToolCalls(manager)], [], "a turn that stopped waits on nothing");
});

function record(state: SubagentChildRecord["state"], terminalStatus?: string, held: DetachedToolResult[] = []) {
	return { state, ...(terminalStatus ? { terminalStatus } : {}), heldToolResults: held };
}
const toolWake = (id: string) => ({ id: `tool-result:${id}`, kind: "tool-result" as const, toolResult: result(id) });
const intercomWake = { id: "intercom:1", kind: "intercom" as const };

test("a released child is woken with what it holds and what arrived, prompted only for a message (#4326)", () => {
	assert.deepEqual(
		decideReleasedChildWake(record("terminal", SUBAGENT_CHILD_RELEASED_STATUS, [result("a")]), [toolWake("b")]),
		{
			kind: "wake",
			toolResults: [result("a"), result("b")],
			prompt: false,
		},
	);
	assert.deepEqual(decideReleasedChildWake(record("terminal", SUBAGENT_CHILD_RELEASED_STATUS), [intercomWake]), {
		kind: "wake",
		toolResults: [],
		prompt: true,
	});
	assert.deepEqual(
		decideReleasedChildWake(record("terminal", SUBAGENT_CHILD_RELEASED_STATUS, [result("a")]), [toolWake("a")]),
		{ kind: "wake", toolResults: [result("a")], prompt: false },
		"a result it already holds is not taken twice",
	);
	assert.deepEqual(
		decideReleasedChildWake(record("terminal", SUBAGENT_CHILD_RELEASED_STATUS), [toolWake("c"), intercomWake]),
		{ kind: "wake", toolResults: [result("c")], prompt: true },
		"a message in the batch prompts the child, whatever else arrived with it",
	);
});

test("a paused, quit or live child keeps only the new results for later and ignores messages (#4326)", () => {
	for (const [state, status] of [
		["terminal", "paused"],
		["terminal", "quit"],
		["terminal", "stage-paused"],
		["running", undefined],
	] as const) {
		assert.deepEqual(decideReleasedChildWake(record(state, status, [result("a")]), [toolWake("b"), toolWake("b")]), {
			kind: "hold",
			toolResults: [result("b")],
		});
		assert.deepEqual(decideReleasedChildWake(record(state, status), [intercomWake]), { kind: "ignore" });
		assert.deepEqual(decideReleasedChildWake(record(state, status, [result("a")]), [toolWake("a")]), {
			kind: "ignore",
		});
	}
});

test("an ended child takes nothing, and a settled one is woken by a new result or by results it holds (#4326)", () => {
	for (const status of ["killed", "stage-closed", "gone"])
		assert.deepEqual(decideReleasedChildWake(record("terminal", status), [toolWake("a"), intercomWake]), {
			kind: "ignore",
		});
	assert.deepEqual(decideReleasedChildWake(record("terminal", "ok"), [toolWake("a"), intercomWake]), {
		kind: "wake",
		toolResults: [result("a")],
		prompt: false,
	});
	assert.deepEqual(
		decideReleasedChildWake(record("terminal", "ok", [result("a")]), [{ id: "held-results:t", kind: "tool-result" }]),
		{ kind: "wake", toolResults: [result("a")], prompt: false },
	);
	assert.deepEqual(decideReleasedChildWake(record("terminal", "error"), [intercomWake]), { kind: "ignore" });
	assert.deepEqual(decideReleasedChildWake({ state: "terminal" }, [intercomWake]), { kind: "ignore" });
});

test("wake keys name the owner and the child; namespaces are per owner (#4326)", () => {
	assert.equal(subagentWakeNamespace("owner-1"), "subagents/owner-1");
	assert.equal(subagentWakeKey("owner-1", "run:0"), "subagents/owner-1:run:0");
	assert.deepEqual(subagentReleasePolicy(), { afterMs: SUBAGENT_RELEASE_AFTER_MS });
	assert.equal(SUBAGENT_RELEASE_AFTER_MS, 60_000);
	assert.equal(subagentReleasePolicy(5).afterMs, 5);
});

function detachedCall(toolResult: DetachedToolResult): DetachedToolCall {
	return {
		toolCallId: toolResult.toolCallId,
		toolName: toolResult.toolName,
		result: Promise.resolve(toolResult),
		abort() {},
	};
}

test("each detached call's result is delivered once as a tool-result wake; a failed delivery is counted (#4326)", async () => {
	const dispatcher = new AgentWakeDispatcher();
	const delivered: string[][] = [];
	dispatcher.handle(subagentWakeNamespace("owner"), async (key, wakes) => {
		delivered.push([key, ...wakes.map((wake) => `${wake.kind}:${wake.id}:${wake.toolResult?.toolCallId}`)]);
	});
	forwardDetachedResults(dispatcher, subagentWakeKey("owner", "run:0"), [detachedCall(result("ci-1"))]);
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(delivered, [["subagents/owner:run:0", "tool-result:tool-result:ci-1:ci-1"]]);

	const failures: AgentRehydrateError[] = [];
	const orphaned = new AgentWakeDispatcher({ onUnobservedFailure: (error) => failures.push(error) });
	forwardDetachedResults(orphaned, "subagents/gone:run:0", [detachedCall(result("ci-9"))]);
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.code, "no-wake-handler");
	assert.equal(orphaned.stats().unobservedFailures, 1);
});

interface FakeEvents {
	readonly emitted: Array<{ channel: string; data: object }>;
	readonly listeners: Map<string, (data: unknown) => void>;
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

function fakeEvents(authorize: boolean): FakeEvents {
	const events: FakeEvents = {
		emitted: [],
		listeners: new Map(),
		on(channel, handler) {
			events.listeners.set(channel, handler);
			return () => events.listeners.delete(channel);
		},
		emit(channel, data) {
			events.emitted.push({ channel, data: data as object });
			if (channel === SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT && authorize)
				(data as { completion?: Promise<object> }).completion = Promise.resolve({
					capability: "cap-1",
					supervisorSessionId: "owner",
					childName: (data as { childName: string }).childName,
				});
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT)
				(data as { completion?: Promise<void> }).completion = Promise.resolve();
			const listener = events.listeners.get(channel);
			listener?.(data);
		},
	};
	return events;
}

test("a released child's name and ids are reserved for waking in one request, and nothing is kept in this process (#4326)", async () => {
	const events = fakeEvents(false);
	await reserveReleasedChildTargets(
		{ intercomEvents: events, intercomSessionName: "child-1", intercomGroup: "lane" },
		"session-1",
		"intercom-id-1",
	);
	const requests = events.emitted.filter((entry) => entry.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT);
	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.ok(request);
	assert.deepEqual((request.data as { children: unknown[] }).children, [
		{ childName: "child-1", group: "lane", aliases: ["session-1", "intercom-id-1"], wake: true },
	]);

	const silent = fakeEvents(false);
	const failures = silent.emitted.filter((entry) => entry.channel === SUBAGENT_HOLD_FAILURE_EVENT).length;
	await reserveReleasedChildTargets({ intercomEvents: silent }, "session-2", undefined);
	await reserveReleasedChildTargets({ intercomSessionName: "child-2" }, "session-2", undefined);
	assert.equal(silent.emitted.length, 0, "a child with no Intercom name or bus has nothing to keep addressable");
	assert.equal(silent.emitted.filter((entry) => entry.channel === SUBAGENT_HOLD_FAILURE_EVENT).length, failures);
});

test("a failed reservation hands its broker error to the owner (#4326)", async () => {
	const events = fakeEvents(false);
	const cause = new Error("broker gone");
	let received: { childNames: readonly string[]; error: Error; handled?: boolean } | undefined;
	events.emit = (channel, data) => {
		if (channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT)
			(data as { completion?: Promise<void> }).completion = Promise.reject(cause);
		if (channel === SUBAGENT_HOLD_FAILURE_EVENT) {
			received = data as typeof received;
			if (received) received.handled = true;
		}
	};
	await reserveReleasedChildTargets({ intercomEvents: events, intercomSessionName: "child-3" }, undefined, undefined);
	assert.deepEqual(received?.childNames, ["child-3"]);
	assert.equal(received?.error, cause);
});

function owner() {
	const sessionManager = SessionManager.inMemory("/repo");
	const ctx = { sessionManager } as unknown as ExtensionContext;
	return { sessionManager, ctx, ownerSessionId: sessionManager.getSessionId() };
}

function childRecord(ownerSessionId: string, overrides: Partial<SubagentChildRecord> = {}): SubagentChildRecord {
	return {
		version: 1,
		childId: "run:0",
		runId: "run",
		index: 0,
		agent: "worker",
		state: "terminal",
		terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
		cwd: "/repo",
		owner: { kind: "session", sessionId: ownerSessionId },
		intercomTarget: "child-1",
		...overrides,
	};
}

test("the owner's handler wakes, holds or ignores by the child's latest record, and a missing record fails typed (#4326)", async () => {
	const { sessionManager, ctx, ownerSessionId } = owner();
	await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, childRecord(ownerSessionId));
	await sessionManager.appendCustomEntry(
		SUBAGENT_CHILD_RECORD_TYPE,
		childRecord(ownerSessionId, { childId: "run:1", index: 1, terminalStatus: "paused" }),
	);
	const dispatcher = new AgentWakeDispatcher();
	const woken: Array<[string, readonly DetachedToolResult[], boolean]> = [];
	const held: Array<[string, readonly DetachedToolResult[]]> = [];
	const stop = handleReleasedChildWakes(
		ctx,
		{
			wake: async (child, decision) => {
				woken.push([child.childId, decision.toolResults, decision.prompt]);
			},
			hold: async (child, results) => {
				held.push([child.childId, results]);
			},
		},
		dispatcher,
	);

	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:0"), toolWake("ci-1"));
	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:1"), toolWake("ci-2"));
	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:1"), intercomWake);
	assert.deepEqual(woken, [["run:0", [result("ci-1")], false]]);
	assert.deepEqual(held, [["run:1", [result("ci-2")]]]);
	await assert.rejects(
		dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:9"), intercomWake),
		(error: AgentRehydrateError) => {
			assert.equal(error.code, "wake-failed");
			const cause = error.cause as Error;
			assert.ok(isReleasedChildError(cause));
			assert.deepEqual([cause.code, cause.fields], ["child-record-missing", { ownerSessionId, childId: "run:9" }]);
			return true;
		},
	);
	stop();
	assert.equal(dispatcher.stats().handlers, 0);
});

test("a wake that fails hands every result of its batch and a typed failure to the owner before it fails, and still fails with its own error (#4326)", async () => {
	const { sessionManager, ctx, ownerSessionId } = owner();
	await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, childRecord(ownerSessionId));
	const dispatcher = new AgentWakeDispatcher();
	const failures: Array<[string, readonly DetachedToolResult[], ReleasedChildError]> = [];
	const boom = new Error("the store is closed");
	const stop = handleReleasedChildWakes(
		ctx,
		{
			wake: async () => {
				throw boom;
			},
			hold: async () => {},
			fail: async (child, results, failure) => {
				failures.push([child.childId, results, failure]);
			},
		},
		dispatcher,
	);
	await assert.rejects(
		dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:0"), toolWake("ci-1")),
		(error: AgentRehydrateError) => error.code === "wake-failed" && error.cause === boom,
	);
	assert.equal(failures.length, 1);
	const [childId, results, failure] = failures[0] ?? [];
	assert.equal(childId, "run:0");
	assert.deepEqual(results, [result("ci-1")]);
	assert.ok(failure && isReleasedChildError(failure));
	assert.deepEqual(
		[failure.code, failure.retryable, failure.fields],
		["wake-failed", true, { childId: "run:0", reason: "the store is closed" }],
	);
	assert.equal(failure.cause, boom);
	stop();
});

test("a broker notice for a released child becomes an intercom wake on its key (#4326)", async () => {
	const { sessionManager, ctx, ownerSessionId } = owner();
	await sessionManager.appendCustomEntry(
		SUBAGENT_CHILD_RECORD_TYPE,
		childRecord(ownerSessionId, { terminalStatus: "paused" }),
	);
	await sessionManager.appendCustomEntry(
		SUBAGENT_CHILD_RECORD_TYPE,
		childRecord(ownerSessionId, { childId: "run:2", index: 2, intercomTarget: undefined }),
	);
	const events = fakeEvents(true);
	const dispatcher = new AgentWakeDispatcher();
	const stop = bindReleasedChildWakes({} as SubagentChildRestoreDeps, ctx, events, dispatcher);
	const listener = events.listeners.get(SUBAGENT_RELEASED_CHILD_WAKE_EVENT);
	assert.ok(listener);
	listener({ childName: "someone-else" });
	listener({ nope: true });
	listener(null);
	assert.equal(dispatcher.stats().keys, 0);
	listener({ childName: "child-1" });
	assert.equal(dispatcher.stats().keys, 1, "the notice is queued on the child's key");
	for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(dispatcher.stats().keys, 0, "a paused child ignores the message wake");
	stop();
	assert.equal(events.listeners.has(SUBAGENT_RELEASED_CHILD_WAKE_EVENT), false);
	assert.equal(dispatcher.stats().handlers, 0);
});

test("a reload's next extension generation takes the owner's wakes over without a conflict (#4326)", async () => {
	const { sessionManager, ctx, ownerSessionId } = owner();
	await sessionManager.appendCustomEntry(
		SUBAGENT_CHILD_RECORD_TYPE,
		childRecord(ownerSessionId, { terminalStatus: "paused" }),
	);
	const dispatcher = new AgentWakeDispatcher();
	const deps = {} as SubagentChildRestoreDeps;
	const previous = fakeEvents(true);
	const next = fakeEvents(true);
	const stopPrevious = bindReleasedChildWakes(deps, ctx, previous, dispatcher);
	const stopNext = bindReleasedChildWakes(deps, ctx, next, dispatcher);
	assert.equal(dispatcher.stats().handlers, 1);
	stopPrevious();
	assert.equal(previous.listeners.has(SUBAGENT_RELEASED_CHILD_WAKE_EVENT), false, "the previous generation let go");
	assert.equal(dispatcher.stats().handlers, 1, "the previous generation's shutdown leaves the new handler in place");
	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:0"), intercomWake);
	stopNext();
	assert.equal(dispatcher.stats().handlers, 0);
	assert.equal(next.listeners.has(SUBAGENT_RELEASED_CHILD_WAKE_EVENT), false);
});

test("a broker notice whose wake fails is counted as an unobserved failure, not swallowed (#4326)", async () => {
	const { sessionManager, ctx, ownerSessionId } = owner();
	await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, childRecord(ownerSessionId));
	const events = fakeEvents(true);
	const dispatcher = new AgentWakeDispatcher();
	const restoreFailure = new Error("no agents to restore from");
	const deps = {
		discoverAgents: () => {
			throw restoreFailure;
		},
	} as unknown as SubagentChildRestoreDeps;
	const stop = bindReleasedChildWakes(deps, ctx, events, dispatcher);
	events.listeners.get(SUBAGENT_RELEASED_CHILD_WAKE_EVENT)?.({ childName: "child-1" });
	for (let turn = 0; turn < 10 && dispatcher.stats().unobservedFailures === 0; turn++)
		await new Promise((resolve) => setImmediate(resolve));
	assert.equal(dispatcher.stats().unobservedFailures, 1);
	assert.equal(dispatcher.lastFailure?.code, "wake-failed");
	stop();
});

test("Intercom and Subagents name the released-child wake event alike (#4326)", () => {
	assert.equal(INTERCOM_RELEASED_CHILD_WAKE_EVENT, SUBAGENT_RELEASED_CHILD_WAKE_EVENT);
	assert.equal(SUBAGENT_RELEASED_CHILD_WAKE_EVENT, "subagent:released-child-wake");
});
