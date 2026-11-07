import assert from "node:assert/strict";
import { type AgentWake, AgentWakeDispatcher, type ExtensionContext } from "@bastani/atomic";
import { beforeEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";
import {
	bindReleasedChildWakes,
	SUBAGENT_RELEASED_CHILD_WAKE_EVENT,
} from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import { subagentWakeKey } from "../../packages/subagents/src/runs/foreground/released-children.js";
import { subagentChildRecordOf } from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type {
	SubagentChildRestoreDeps,
	SubagentChildRestoreOutcome,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { drained } from "../helpers/wake-completion.js";

const restoreState = vi.hoisted(() => ({
	calls: [] as Array<{ childId: string; prompt: string | undefined; promptless: boolean | undefined }>,
	outcome: undefined as SubagentChildRestoreOutcome | undefined,
}));

vi.mock("../../packages/subagents/src/runs/foreground/subagent-child-restore.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../packages/subagents/src/runs/foreground/subagent-child-restore.js")>();
	return {
		...original,
		restoreSubagentChild: async (
			_deps: SubagentChildRestoreDeps,
			_ctx: ExtensionContext,
			childId: string,
			resume: { prompt?: string; promptless?: boolean },
		): Promise<SubagentChildRestoreOutcome> => {
			restoreState.calls.push({ childId, prompt: resume.prompt, promptless: resume.promptless });
			if (restoreState.outcome === undefined) throw new Error("no restore outcome set");
			return restoreState.outcome;
		},
	};
});

beforeEach(() => {
	restoreState.calls.length = 0;
	restoreState.outcome = undefined;
});

interface Emitted {
	readonly channel: string;
	readonly data: object;
}

function bus() {
	const emitted: Emitted[] = [];
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		emitted,
		listeners,
		on(channel: string, handler: (data: unknown) => void) {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () => listeners.delete(channel);
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data: data as object });
		},
	};
}

function record(ownerSessionId: string, overrides: Partial<SubagentChildRecord> = {}): SubagentChildRecord {
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
		intercomTarget: "named-child",
		childSessionId: "child-session",
		...overrides,
	};
}

async function ownerWith(records: Array<Partial<SubagentChildRecord>>, host?: object) {
	const sessionManager = SessionManager.inMemory("/repo");
	const ownerSessionId = sessionManager.getSessionId();
	for (const overrides of records)
		await sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, record(ownerSessionId, overrides));
	const ctx = { sessionManager, ...(host ? { getAgentTaskHost: () => host } : {}) } as unknown as ExtensionContext;
	return { ctx, ownerSessionId };
}

const intercomWake: AgentWake = { id: "wake-1", kind: "intercom" };
const deps = {} as SubagentChildRestoreDeps;

function restored(taskId: string): SubagentChildRestoreOutcome {
	return { kind: "restored", record: record("x"), taskId, intercomLive: true };
}

test("binding indexes the owner's records so its released children are reserved at once (#4326)", async () => {
	const { ctx, ownerSessionId } = await ownerWith([{}, { childId: "run:1", index: 1, intercomTarget: "second" }]);
	const events = bus();
	const stop = bindReleasedChildWakes(deps, ctx, events, new AgentWakeDispatcher());
	assert.equal(subagentChildRecordOf(ownerSessionId, "run:1")?.intercomTarget, "second");
	const reserve = events.emitted.find((entry) => entry.channel === SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT);
	assert.ok(reserve);
	assert.equal((reserve.data as { children: unknown[] }).children.length, 2);
	stop();
});

test("a broker notice delivers an intercom wake with a fresh id for the named child's key (#4326)", async () => {
	const { ctx, ownerSessionId } = await ownerWith([{}]);
	const delivered: Array<{ key: string; wake: AgentWake }> = [];
	class Spy extends AgentWakeDispatcher {
		override deliver(key: string, wake: AgentWake) {
			delivered.push({ key, wake });
			return super.deliver(key, wake);
		}
	}
	restoreState.outcome = { kind: "terminal", record: record(ownerSessionId) };
	const events = bus();
	const dispatcher = new Spy();
	const stop = bindReleasedChildWakes(deps, ctx, events, dispatcher);
	const listener = events.listeners.get(SUBAGENT_RELEASED_CHILD_WAKE_EVENT)?.[0];
	assert.ok(listener);
	listener({ childName: "named-child" });
	listener({ childName: "named-child" });
	assert.equal(delivered.length, 2);
	assert.equal(delivered[0]?.key, subagentWakeKey(ownerSessionId, "run:0"));
	assert.equal(delivered[0]?.wake.kind, "intercom");
	assert.match(delivered[0]?.wake.id ?? "", /^intercom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	assert.notEqual(delivered[0]?.wake.id, delivered[1]?.wake.id);
	assert.equal(await drained(dispatcher), 0);
	assert.deepEqual(
		restoreState.calls.map((call) => [call.childId, call.promptless]),
		[
			["run:0", undefined],
			["run:0", undefined],
		],
		"the intercom wake prompts the child",
	);
	stop();
});

test("a wake acknowledges the broker only for a child that has an Intercom name (#4326)", async () => {
	const named = await ownerWith([{}]);
	const unnamed = await ownerWith([{ intercomTarget: undefined }]);
	for (const [owner, expected] of [
		[named, [{ childName: "named-child" }]],
		[unnamed, []],
	] as const) {
		restoreState.outcome = { kind: "terminal", record: record(owner.ownerSessionId) };
		const events = bus();
		const dispatcher = new AgentWakeDispatcher();
		const stop = bindReleasedChildWakes(deps, owner.ctx, events, dispatcher);
		await dispatcher.deliver(subagentWakeKey(owner.ownerSessionId, "run:0"), intercomWake);
		assert.deepEqual(
			events.emitted
				.filter((entry) => entry.channel === SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT)
				.map((entry) => entry.data),
			expected,
		);
		stop();
	}
});

test("a restored child's wake waits until the host reports its task settled, and only then (#4326)", async () => {
	const waited: string[] = [];
	const states = [
		{ ok: true, value: { kind: "running" } },
		{ ok: true, value: { kind: "settled" } },
	];
	const host = {
		waitForTask: async (taskId: string) => {
			waited.push(taskId);
			return states[waited.length - 1] ?? { ok: false };
		},
	};
	const { ctx, ownerSessionId } = await ownerWith([{}], host);
	const dispatcher = new AgentWakeDispatcher();
	const stop = bindReleasedChildWakes(deps, ctx, bus(), dispatcher);
	restoreState.outcome = restored("task-7");
	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:0"), intercomWake);
	assert.deepEqual(waited, ["task-7", "task-7"]);

	waited.length = 0;
	states.length = 0;
	states.push({ ok: false } as never);
	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:0"), intercomWake);
	assert.deepEqual(waited, ["task-7"], "a failed observation ends the wait");

	waited.length = 0;
	restoreState.outcome = { kind: "terminal", record: record(ownerSessionId) };
	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:0"), intercomWake);
	assert.deepEqual(waited, [], "a child that was already terminal has no task to wait for");
	stop();
});

test("a restored child with no task host is not waited for (#4326)", async () => {
	const { ctx, ownerSessionId } = await ownerWith([{}]);
	const dispatcher = new AgentWakeDispatcher();
	const stop = bindReleasedChildWakes(deps, ctx, bus(), dispatcher);
	restoreState.outcome = restored("task-8");
	await dispatcher.deliver(subagentWakeKey(ownerSessionId, "run:0"), intercomWake);
	assert.equal(restoreState.calls.length, 1);
	stop();
});
