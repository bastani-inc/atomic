import assert from "node:assert/strict";
import v8 from "node:v8";
import { AgentWakeDispatcher, type DetachedToolResult } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { subagentWakeNamespace } from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	subagentChildIndexEntry,
	subagentChildIndexSize,
	subagentChildRecordOf,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	recordSubagentChildHeldToolResults,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecordSink,
	subagentChildRecordsAppended,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { subagentRegistrySizes } from "../../packages/subagents/src/runs/foreground/subagent-registry-sizes.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { liveAsyncResources, trackAsyncResources } from "../../scripts/perf/idle-agents/async-resources.js";
import { settle } from "../../scripts/perf/idle-agents/scripted-model.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** Thousands of released children, each launched, released and given history through the real record path. */
const RELEASED_CHILDREN = 2_000;
/** A real task host admission and several saved records per child, for every child: structural, not a slow test. */
const THOUSANDS_OF_CHILDREN_TIMEOUT_MS = 120_000;
/** Every this many children, one carries a large task, held messages and held results, and is saved more often. */
const LARGE_HISTORY_EVERY = 100;
const LARGE_PAYLOAD_CHARS = 128 * 1024;
const OWNER_SESSION_ID = "released-index-owner";
/** The keys of a child's record that hold its history; none of them is kept in its index entry. */
const PAYLOAD_KEYS = [
	"launch",
	"heldMessages",
	"heldToolResults",
	"inherited",
	"modelConstraints",
	"waitingOn",
	"wakeFailure",
	"worktree",
] as const;

const agent: AgentConfig = {
	name: "waiter",
	description: "waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/waiter.md",
};

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function growth(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>, children: number) {
	const grown: Record<string, number> = {};
	for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const added = (after[name] ?? 0) - (before[name] ?? 0);
		if (added !== 0) grown[name] = added / children;
	}
	return grown;
}

function assertPlainData(value: unknown): void {
	assert.notEqual(typeof value, "function", "the index must not retain a function");
	if (value === null || typeof value !== "object") return;
	assert.ok(
		Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
		"only plain objects and arrays",
	);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		assert.ok(descriptor);
		assert.equal(descriptor.get, undefined, "the index must not retain a getter");
		assert.equal(descriptor.set, undefined, "the index must not retain a setter");
		assertPlainData(descriptor.value);
	}
}

function padded(index: number): string {
	return String(index).padStart(5, "0");
}

function heldResult(toolCallId: string, chars: number): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text: "r".repeat(chars) }], details: undefined },
		isError: false,
	};
}

interface Owner {
	readonly sessionManager: SessionManager;
	readonly host: AgentTaskHost;
	readonly dispatcher: AgentWakeDispatcher;
	readonly sink: SubagentChildRecordSink;
	readonly pi: { appendEntry(customType: string, data?: unknown): Promise<void> };
	readonly cwd: string;
}

function owner(): Owner {
	const cwd = makeTempDirectory("released-index-");
	const sessionManager = SessionManager.inMemory(cwd);
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: OWNER_SESSION_ID }, authorizeLaunch() {} });
	const dispatcher = new AgentWakeDispatcher();
	cleanups.push(() => removeTempDirectory(cwd));
	cleanups.push(dispatcher.handle(subagentWakeNamespace(sessionManager.getSessionId()), async () => {}));
	cleanups.push(async () => {
		await host.close("session-close");
	});
	const pi = {
		appendEntry: async (customType: string, data?: unknown) => {
			await sessionManager.appendCustomEntry(customType, data);
		},
	};
	const sink = createSubagentChildRecordSink(pi, { sessionManager, orchestrationContext: undefined });
	return { sessionManager, host, dispatcher, sink, pi, cwd };
}

/**
 * Launch one child as a parallel launch does (queued for a slot first, so its record keeps its launch and task), let it
 * run until it is released waiting on CI, then give it history: messages and tool results held for its next wake.
 */
async function releaseChild(at: Owner, index: number): Promise<string> {
	const id = padded(index);
	const runId = `released-${id}`;
	const childId = `${runId}:0`;
	const large = index % LARGE_HISTORY_EVERY === 0;
	const runtime = async (
		_cwd: string,
		_agents: AgentConfig[],
		_agent: string,
		task: string,
		options: RunSyncOptions,
	): Promise<SingleResult> => {
		options.taskExecution?.bindChildSession?.({ sessionId: `child-session-${id}`, sessionFile: undefined });
		return {
			agent: "waiter",
			task,
			status: "interrupted",
			interrupted: true,
			usage: NO_USAGE,
			messages: [],
			released: {
				waitingOn: [{ toolCallId: `ci-${id}`, toolName: "wait_for_ci" }],
				calls: [],
				intercomId: `intercom-${id}`,
			},
		};
	};
	const response = await runAgentTask({
		host: at.host,
		cwd: at.cwd,
		agents: [agent],
		agent: "waiter",
		task: large ? "t".repeat(LARGE_PAYLOAD_CHARS) : "watch CI",
		options: { cwd: at.cwd, runId, index: 0, intercomSessionName: `subagent-waiter-${id}` },
		wait: { kind: "background" },
		recordChild: at.sink,
		wakeDispatcher: at.dispatcher,
		schedule: (dispatch) => setImmediate(() => void dispatch()),
		runtime: { runSync: runtime },
	});
	assert.equal(response.kind, "admitted");
	assert.ok(response.kind === "admitted");
	const taskId = response.observation.taskId as TaskId;
	for (;;) {
		const observed = await at.host.waitForTask(taskId);
		if (!observed.ok || observed.value.kind === "settled") break;
	}
	await subagentChildRecordsAppended(at.sessionManager.getSessionId());
	const holds = large ? 6 : 1;
	for (let hold = 0; hold < holds; hold++)
		assert.equal(
			await at.sink.holdMessages?.(childId, [large ? "m".repeat(LARGE_PAYLOAD_CHARS) : "ping"]),
			"released",
		);
	await recordSubagentChildHeldToolResults(at.pi, at.sessionManager.getSessionId(), childId, [
		heldResult(`late-${id}`, large ? LARGE_PAYLOAD_CHARS : 8),
	]);
	return childId;
}

test(
	"thousands of released children keep one constant-size, plain-data index entry each and nothing else (#4395)",
	async () => {
		cleanups.push(trackAsyncResources());
		const at = owner();
		const ownerSessionId = at.sessionManager.getSessionId();
		await releaseChild(at, 0);
		await settle();
		const before = subagentRegistrySizes();
		const indexed = subagentChildIndexSize();
		const resources = liveAsyncResources();

		const childIds: string[] = [];
		for (let index = 1; index <= RELEASED_CHILDREN; index++) childIds.push(await releaseChild(at, index));
		await subagentChildRecordsAppended(ownerSessionId);
		await settle();

		assert.deepEqual(growth(before, subagentRegistrySizes(), RELEASED_CHILDREN), { records: 1 });
		assert.equal(subagentChildIndexSize() - indexed, RELEASED_CHILDREN);
		assert.deepEqual(liveAsyncResources(), resources, "no timer, socket or process grows with released children");

		const saved = readSubagentChildRecords(at.sessionManager.getEntries(), ownerSessionId);
		const entryBytesByTaskIdLength = new Map<number, Set<number>>();
		for (const childId of childIds) {
			const entry = subagentChildIndexEntry(childId);
			assert.ok(entry?.taskId);
			assert.equal(entry.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS);
			assert.ok(entry.entryId, "the entry points at the session entry that holds the child's latest record");
			for (const key of PAYLOAD_KEYS) assert.equal(Object.hasOwn(entry, key), false, `${key} is not indexed`);
			const sizes = entryBytesByTaskIdLength.get(entry.taskId.length) ?? new Set<number>();
			sizes.add(v8.serialize(entry).byteLength);
			entryBytesByTaskIdLength.set(entry.taskId.length, sizes);
			assert.deepEqual(
				subagentChildRecordOf(ownerSessionId, childId),
				saved.get(childId),
				"the entry reads the child's latest saved record",
			);
		}
		for (const [taskIdLength, sizes] of entryBytesByTaskIdLength)
			assert.equal(sizes.size, 1, `entries whose host task ids have ${taskIdLength} characters are all one size`);
		const large = `released-${padded(10 * LARGE_HISTORY_EVERY)}:0`;
		const small = `released-${padded(10 * LARGE_HISTORY_EVERY + 1)}:0`;
		const bytes = (value: object | undefined) => v8.serialize(value).byteLength;
		assert.equal(
			bytes(subagentChildIndexEntry(large)),
			bytes(subagentChildIndexEntry(small)),
			"a child with a large task, held messages, held results and more saves has an entry the size of one without",
		);
		assert.ok(
			bytes(subagentChildRecordOf(ownerSessionId, large)) - bytes(subagentChildRecordOf(ownerSessionId, small)) >
				LARGE_PAYLOAD_CHARS * 3,
			"its history is in its session's records, not in the index",
		);
		const last = subagentChildIndexEntry(childIds.at(-1) ?? "");
		assertPlainData(last);
		assert.deepEqual(structuredClone(last), last);
	},
	THOUSANDS_OF_CHILDREN_TIMEOUT_MS,
);
