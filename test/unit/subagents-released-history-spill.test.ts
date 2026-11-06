import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import type { CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
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

useTemporaryAgentDir();

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
});

function entryBytes(entries: readonly object[]): number {
	return entries.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(entries)) - 2;
}

test(
	"a released in-memory subagent keeps only its header in memory, and its call's result wakes it from its whole history (#4502)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const owner = await SessionManager.create(store, env.root);
		const ownerSessionId = owner.getSessionId();
		const host = new AgentTaskHost({ scope: { kind: "session", sessionId: ownerSessionId }, authorizeLaunch() {} });
		const childSessionOptions = env.options("unused").getChildSessionOptions as (
			options: CreateAgentSessionOptions,
		) => CreateAgentSessionOptions;
		const ctx = {
			getChildSessionOptions: childSessionOptions,
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
		cleanups.push(async () => {
			stopWakes();
			await host.close("session-close");
			await store.close();
		});
		const latest = (): SubagentChildRecord | undefined => readSubagentChildRecords(owner.getEntries()).get("spill:0");
		const until = async (accept: (record: SubagentChildRecord) => boolean) => {
			for (let turn = 0; turn < 4000; turn++) {
				const record = latest();
				if (record !== undefined && accept(record)) return record;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`the child never reached the expected record: ${JSON.stringify(latest())}`);
		};

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
		const childSessionId = released.childSessionId as string;
		await dispatcher.whenIdle();

		const history = (await store.load(childSessionId)).entries;
		assert.ok(entryBytes(history) > CHILD_TEXT_BYTES, `${entryBytes(history)} bytes of child history`);
		const ownerSnapshot = await store.load(ownerSessionId);
		const ownerBytes = Buffer.byteLength(JSON.stringify(ownerSnapshot.header)) + entryBytes(ownerSnapshot.entries);
		const childHeaderBytes = Buffer.byteLength(JSON.stringify(await store.readHeader(childSessionId)));
		assert.deepEqual(store.historyBytes(), {
			inMemory: ownerBytes + childHeaderBytes,
			onDisk: entryBytes(history),
		});

		env.answers[0]?.({ content: [{ type: "text", text: "CI passed" }], details: undefined });
		await until((record) => record.terminalStatus !== SUBAGENT_CHILD_RELEASED_STATUS && record.state === "terminal");
		await dispatcher.whenIdle();

		const woken = (await store.load(childSessionId)).entries;
		assert.deepEqual(woken.slice(0, history.length), history, "the wake continued from the whole history");
		const continuation = woken.slice(history.length);
		assert.equal(continuation[0]?.parentId, history.at(-1)?.id);
		const messages = continuation.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		assert.deepEqual(
			messages.map((message) => message.role),
			["toolResult", "assistant"],
		);
		assert.equal(latest()?.terminalStatus, "ok");
	},
	CHILD_TIMEOUT_MS,
);
