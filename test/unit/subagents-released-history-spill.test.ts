import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import type { CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionSpillError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { releasedHistoryFiles } from "../../packages/coding-agent/src/core/storage/session/released-history-files.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { resumeReleasedChild } from "../../packages/subagents/src/runs/foreground/released-child-resume.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import { subagentReleasePolicy } from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { IntercomEventBus } from "../../packages/subagents/src/shared/types.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent } from "../helpers/released-task-launch.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * A background subagent whose session lives in its owner's in-memory store, released while it waits on a detachable
 * call (#4502): its history leaves process memory with it, and the call's result wakes it from that history, whole.
 */
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_TEXT_BYTES = 8_000;

const agentDir = useTemporaryAgentDir();

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
});

function entryBytes(entries: readonly object[]): number {
	return entries.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(entries)) - 2;
}

/** The most bytes the owner's own history may differ by from its JSON: the commas between its few buffers. */
const BUFFER_SEPARATOR_SLACK = 32;

/**
 * An owner session over `store` with the real task host, record sink and wake binding, as the idle-agents benchmark
 * builds it; `launch()` starts one background child in the same store that waits on a detachable call and is released.
 */
async function ownerOf(store: SessionStore, closeStore: () => Promise<void>) {
	const env = await liveChildEnvironment(cleanups);
	const owner = await SessionManager.create(store, env.root);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: owner.getSessionId() },
		authorizeLaunch() {},
	});
	const ctx = {
		getChildSessionOptions: env.options("unused").getChildSessionOptions as (
			options: CreateAgentSessionOptions,
		) => CreateAgentSessionOptions,
		cwd: env.root,
		mode: "tui",
		hasUI: false,
		ui: {},
		sessionManager: owner,
		getAgentTaskHost: () => host,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		model: undefined,
		thinkingLevel: undefined,
	} as unknown as ExtensionContext;
	const handlers = new Map<string, Array<(payload: object) => void>>();
	const events: IntercomEventBus = {
		on(channel, handler) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () =>
				handlers.set(
					channel,
					(handlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
				);
		},
		emit(channel, payload) {
			for (const handler of handlers.get(channel) ?? []) handler(payload as object);
		},
	};
	const appendEntry = async <T>(type: string, data?: T): Promise<void> => {
		await owner.appendCustomEntry(type, data);
	};
	const deps: SubagentChildRestoreDeps = {
		pi: { events, appendEntry, getSessionName: () => "owner" } as never,
		config: {},
		discoverAgents: () => ({ agents: [agent] }),
		runtime: {
			runSync: (cwd, agents, agentName, task, options) =>
				runSync(cwd, agents, agentName, task, { ...options, testSession: false }),
		},
	};
	const dispatcher = new AgentWakeDispatcher();
	const stopWakes = bindReleasedChildWakes(deps, ctx, events, dispatcher);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		stopWakes();
		await host.close("session-close");
		await closeStore();
	};
	cleanups.push(close);
	const latest = (): SubagentChildRecord | undefined => readSubagentChildRecords(owner.getEntries()).get("spill:0");
	const until = async (accept: (record: SubagentChildRecord) => boolean) => {
		for (let turn = 0; turn < 4000; turn++) {
			const record = latest();
			if (record !== undefined && accept(record)) return record;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`the child never reached the expected record: ${JSON.stringify(latest())}`);
	};
	/** Launch the child and wait until it is released; returns its session id. */
	const launch = async (): Promise<string> => {
		env.faux.setResponses([
			{
				role: "assistant",
				content: [
					{ type: "text", text: `Checked the build. ${"x".repeat(CHILD_TEXT_BYTES)}` },
					{ type: "toolCall", id: "ci-call", name: "wait_for_ci", arguments: { run: "spill" } },
				],
				stopReason: "toolUse",
			} as never,
			{ role: "assistant", content: [{ type: "text", text: "CI passed; done." }], stopReason: "stop" } as never,
		]);
		const response = await runAgentTask({
			host,
			cwd: env.root,
			agents: [agent],
			agent: "waiter",
			task: "watch CI",
			options: {
				...env.options("spill", {
					sessionManager: await SessionManager.create(store, env.root),
					resumeSession: true,
					releaseWhenWaiting: subagentReleasePolicy(0),
				}),
				index: 0,
			},
			wakeDispatcher: dispatcher,
			wait: { kind: "background" },
			recordChild: createSubagentChildRecordSink({ appendEntry }, ctx),
			runtime: { runSync },
		});
		assert.equal(response.kind, "admitted");
		const released = await until((record) => record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS);
		await dispatcher.whenIdle();
		return released.childSessionId as string;
	};
	/** Answer the child's call, which wakes it. */
	const answer = () => env.answers[0]?.({ content: [{ type: "text", text: "CI passed" }], details: undefined });
	/** The child's run, woken or resumed, has ended. */
	const ended = async () => {
		await until((record) => record.terminalStatus !== SUBAGENT_CHILD_RELEASED_STATUS && record.state === "terminal");
		await dispatcher.whenIdle();
	};
	/** Answer the child's call, which wakes it, and wait until its woken run has ended. */
	const wake = async () => {
		answer();
		await ended();
	};
	/** The cleanup each of the owner's tasks ended with: `"reaped"` once its session closed cleanly. */
	const taskCleanups = () => {
		const watched = host.watchOwnerTasks();
		assert.ok(watched.ok);
		const kinds = watched.value.snapshot.tasks.map((task) => task.cleanup.kind);
		watched.value.dispose();
		return kinds;
	};
	return { owner, launch, answer, ended, wake, until, latest, close, taskCleanups, dispatcher, faux: env.faux };
}

test(
	"a released in-memory subagent keeps only its header in memory, and its call's result wakes it from its whole history (#4502)",
	async () => {
		const store = new MemorySessionStore(undefined, releasedHistoryFiles(agentDir));
		const h = await ownerOf(store, () => store.close());
		const childSessionId = await h.launch();

		const history = (await store.load(childSessionId)).entries;
		assert.ok(entryBytes(history) > CHILD_TEXT_BYTES, `${entryBytes(history)} bytes of child history`);
		const ownerSnapshot = await store.load(h.owner.getSessionId());
		const ownerBytes = Buffer.byteLength(JSON.stringify(ownerSnapshot.header)) + entryBytes(ownerSnapshot.entries);
		const childHeaderBytes = Buffer.byteLength(JSON.stringify(await store.readHeader(childSessionId)));
		const held = store.historyBytes();
		assert.equal(held.onDisk, entryBytes(history));
		assert.ok(
			held.inMemory <= ownerBytes + childHeaderBytes &&
				held.inMemory >= ownerBytes + childHeaderBytes - BUFFER_SEPARATOR_SLACK,
			`${held.inMemory} bytes in memory: the owner's ${ownerBytes} and the child's header ${childHeaderBytes}`,
		);

		await h.wake();

		const woken = (await store.load(childSessionId)).entries;
		assert.deepEqual(woken.slice(0, history.length), history, "the wake continued from the whole history");
		const continuation = woken.slice(history.length);
		assert.equal(continuation[0]?.parentId, history.at(-1)?.id);
		assert.deepEqual(
			continuation.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : [])),
			["toolResult", "assistant"],
		);
		assert.equal(h.latest()?.terminalStatus, "ok");
		assert.deepEqual(h.taskCleanups(), ["reaped", "reaped"]);
		assert.equal(
			store.historyBytes().onDisk,
			entryBytes(history),
			"a run that ends without a release keeps what it wrote in memory",
		);
	},
	CHILD_TIMEOUT_MS,
);

test(
	"a subagent over a store that keeps no history in memory is released and woken as before, and its task closes cleanly (#4502)",
	async () => {
		const inner = new MemorySessionStore(undefined, releasedHistoryFiles(agentDir));
		const store: SessionStore = {
			get descriptor() {
				return inner.descriptor;
			},
			create: (header, entries) => inner.create(header, entries),
			append: (sessionId, entries, options) => inner.append(sessionId, entries, options),
			replace: (sessionId, header, entries, options) => inner.replace(sessionId, header, entries, options),
			load: (sessionId) => inner.load(sessionId),
			readHeader: (sessionId) => inner.readHeader(sessionId),
			delete: (sessionId) => inner.delete(sessionId),
			list: (query) => inner.list(query),
			findMostRecent: (query) => inner.findMostRecent(query),
			close: () => inner.close(),
		};
		const h = await ownerOf(store, () => inner.close());
		const childSessionId = await h.launch();
		const history = (await store.load(childSessionId)).entries;
		assert.equal(inner.historyBytes().onDisk, 0);

		await h.wake();

		assert.deepEqual((await store.load(childSessionId)).entries.slice(0, history.length), history);
		assert.equal(h.latest()?.terminalStatus, "ok");
		assert.deepEqual(h.taskCleanups(), ["reaped", "reaped"], "releasing the child closed its session cleanly");
		await h.close();
	},
	CHILD_TIMEOUT_MS,
);

test(
	"a wake whose read of the child's history fails in a way that passes fails retryably, and the child stays released for a resume (#4502)",
	async () => {
		const inner = new MemorySessionStore(undefined, releasedHistoryFiles(agentDir));
		let failNextLoad: string | undefined;
		const store: SessionStore = {
			get descriptor() {
				return inner.descriptor;
			},
			create: (header, entries) => inner.create(header, entries),
			append: (sessionId, entries, options) => inner.append(sessionId, entries, options),
			replace: (sessionId, header, entries, options) => inner.replace(sessionId, header, entries, options),
			load: async (sessionId) => {
				if (sessionId !== failNextLoad) return inner.load(sessionId);
				failNextLoad = undefined;
				// What the store throws when reading the file runs out of file descriptors.
				throw new SessionSpillError("spill-read-failed", {
					directory: agentDir,
					sessionId,
					bytes: 1,
					errno: "EMFILE",
				});
			},
			readHeader: (sessionId) => inner.readHeader(sessionId),
			delete: (sessionId) => inner.delete(sessionId),
			list: (query) => inner.list(query),
			findMostRecent: (query) => inner.findMostRecent(query),
			close: () => inner.close(),
			releaseSession: (sessionId) => inner.releaseSession(sessionId),
		};
		const h = await ownerOf(store, () => inner.close());
		const childSessionId = await h.launch();
		const history = (await store.load(childSessionId)).entries;
		failNextLoad = childSessionId;

		h.answer();
		const failed = await h.until((record) => record.wakeFailure !== undefined);
		await h.dispatcher.whenIdle();
		assert.equal(failed.wakeFailure?.code, "wake-failed", "the failure passes, so the wake can be tried again");
		assert.match(failed.wakeFailure?.reason ?? "", /spill-read-failed/);
		assert.match(failed.wakeFailure?.hint ?? "", /resume it/);
		assert.equal(failed.terminalStatus, SUBAGENT_CHILD_RELEASED_STATUS, "the child is not gone");
		assert.equal(failed.heldToolResults?.length, 1, "its call's result is kept for the resume");

		h.faux.appendResponses([
			{ role: "assistant", content: [{ type: "text", text: "Continued." }], stopReason: "stop" } as never,
		]);
		const resumed = await resumeReleasedChild(h.owner.getSessionId(), "spill:0", { prompt: "continue" });
		assert.equal(resumed?.kind, "restored");
		await h.ended();
		const woken = (await store.load(childSessionId)).entries;
		assert.deepEqual(woken.slice(0, history.length), history);
		assert.ok(
			woken.slice(history.length).some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
			"the resumed child received its call's result",
		);
		assert.equal(h.latest()?.terminalStatus, "ok");
	},
	CHILD_TIMEOUT_MS,
);
