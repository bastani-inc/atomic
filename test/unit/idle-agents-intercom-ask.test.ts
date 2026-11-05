import assert from "node:assert/strict";
import type { ToolDefinition } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall, registerSessionResourceCleanup } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { releasedReplyTimeoutId } from "../../packages/subagents/src/runs/foreground/released-child-replies.js";
import {
	subagentReleasePolicy,
	subagentWakeKey,
	subagentWakeNamespace,
} from "../../packages/subagents/src/runs/foreground/released-children.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { subagentRegistrySizes } from "../../packages/subagents/src/runs/foreground/subagent-registry-sizes.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { liveAsyncResources, trackAsyncResources } from "../../scripts/perf/idle-agents/async-resources.js";
import { settle } from "../../scripts/perf/idle-agents/scripted-model.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent } from "../helpers/released-task-launch.js";
import { trackSessions } from "../helpers/track-sessions.js";

const CHILD_LOAD_TIMEOUT_MS = 120_000;
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearSubagentControls();
});

test(
	"released children waiting on Intercom asks keep one index entry and no live per-child resources (#4326)",
	async () => {
		const tracked = trackCollection();
		cleanups.push(trackSessions(tracked));
		cleanups.push(trackAsyncResources());
		const env = await liveChildEnvironment(cleanups);
		const owner = SessionManager.inMemory(env.root);
		const ownerId = owner.getSessionId();
		const dispatcher = new AgentWakeDispatcher();
		const stop = dispatcher.handle(subagentWakeNamespace(ownerId), async () => {});
		cleanups.push(() => {
			for (const record of readSubagentChildRecords(owner.getEntries()).values())
				for (const call of record.waitingOn ?? [])
					if (call.replyWait)
						dispatcher.cancel(
							subagentWakeKey(ownerId, record.childId),
							releasedReplyTimeoutId(call.replyWait.questionId),
						);
			stop();
		});
		const host = new AgentTaskHost({ scope: { kind: "session", sessionId: ownerId }, authorizeLaunch() {} });
		cleanups.push(() => void host.close("session-close"));
		const waits = new Map<string, ReplyWaiterRegistry>();
		cleanups.push(
			registerSessionResourceCleanup((id) => {
				if (id !== undefined) {
					waits.get(id)?.releaseRunningWaits(new Error("released"));
					waits.delete(id);
				}
			}),
		);
		const sink = createSubagentChildRecordSink(
			{ appendEntry: async (type, data) => void (await owner.appendCustomEntry(type, data)) },
			{ sessionManager: owner, orchestrationContext: undefined },
		);
		const launch = async (index: number) => {
			const child = await SessionManager.create(new MemorySessionStore(), env.root);
			const registry = new ReplyWaiterRegistry();
			waits.set(child.getSessionId(), registry);
			let ask: ToolDefinition | undefined;
			let liveManager = child;
			const client = {
				sessionId: "child",
				groups: ["default"],
				send: async (_to: string, message: { messageId: string }) => ({ id: message.messageId, delivered: true }),
				listSessions: async () => [],
			};
			const pi = {
				registerTool: (tool: ToolDefinition) => {
					ask = tool;
				},
				appendEntry: async (type: string, data: object) => {
					await liveManager.appendCustomEntry(type, data);
				},
				events: { emit() {} },
			};
			registerIntercomTool(
				pi as never,
				{
					ensureConnected: async () => client,
					syncPresenceIdentity() {},
					resolveSessionTarget: async () => "peer",
					beginReplyWait: (from: string, id: string, signal?: AbortSignal) => registry.begin(from, id, signal),
					mayDetachReplyWait: () => true,
					confirmSend: false,
					homeGroup: () => "default",
					setJoinedGroups() {},
					clearJoinedGroups() {},
					replyTracker: new ReplyTracker(),
				} as never,
			);
			assert.ok(ask);
			const askTool: ToolDefinition = {
				...ask,
				name: "peer_ask",
				execute: (...args) => {
					liveManager = args[4].sessionManager as SessionManager;
					return ask!.execute(...args);
				},
			};
			const base = env.options(`ask-${index}`, {
				sessionManager: child,
				resumeSession: true,
				releaseWhenWaiting: subagentReleasePolicy(0),
			});
			const resolver = base.getChildSessionOptions;
			assert.ok(resolver);
			env.faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("peer_ask", { action: "ask", to: "peer", message: "Question?" }, { id: `ask-${index}` })],
					{ stopReason: "toolUse" },
				),
			]);
			const response = await runAgentTask({
				host,
				cwd: env.root,
				agents: [agent],
				agent: "waiter",
				task: "ask",
				options: {
					...base,
					index: 0,
					intercomSessionName: `child-${index}`,
					getChildSessionOptions: (options) => ({
						...resolver(options),
						customTools: [askTool],
						builtins: { intercom: false, workflows: false, subagents: false, mcp: false, "web-access": false },
					}),
				},
				wakeDispatcher: dispatcher,
				wait: { kind: "background" },
				recordChild: sink,
				runtime: { runSync },
			});
			assert.equal(response.kind, "admitted");
			for (let turn = 0; turn < 2_000; turn++) {
				const record = readSubagentChildRecords(owner.getEntries()).get(`ask-${index}:0`);
				if (record?.terminalStatus === "released") {
					assert.ok(record.waitingOn?.[0]?.replyWait);
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(
				`child ${index} was not released: ${JSON.stringify({ record: readSubagentChildRecords(owner.getEntries()).get(`ask-${index}:0`), childId: child.getSessionId(), entries: child.getEntries(), waits: registry.size(), task: response.kind === "admitted" ? await host.waitForTask(response.observation.taskId as never) : response })}`,
			);
		};
		await launch(0);
		await settle();
		const before = subagentRegistrySizes();
		const resources = liveAsyncResources();
		for (let index = 1; index <= 3; index++) await launch(index);
		await settle();
		const after = subagentRegistrySizes();
		const grown = Object.fromEntries(
			Object.keys(after).flatMap((key) => {
				const diff = (after[key] ?? 0) - (before[key] ?? 0);
				return diff === 0 ? [] : [[key, diff / 3]];
			}),
		);
		assert.deepEqual(grown, { records: 1 });
		assert.deepEqual(liveAsyncResources(), resources);
		assert.deepEqual(
			{ scheduled: dispatcher.stats().scheduled, timers: dispatcher.stats().timers },
			{ scheduled: 4, timers: 1 },
		);
		assert.equal(waits.size, 0);
		await collectEverythingTracked(tracked);
		assert.deepEqual(
			{ created: tracked.created, uncollected: tracked.uncollected() },
			{ created: tracked.created, uncollected: [] },
		);
	},
	CHILD_LOAD_TIMEOUT_MS,
);
