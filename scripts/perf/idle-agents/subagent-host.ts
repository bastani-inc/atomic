/**
 * The subagent host of the idle-agents benchmark: an owner session that launches background subagents as tasks, each
 * through the real task host, runner, release policy, record sink and wake binding. Every child runs `turns` tool
 * turns on the scripted model in one run, then waits on a long tool whose operation is still running, and is released.
 * A wake finishes that operation: its result goes through the child's call to the dispatcher, which restores the child
 * from its saved session, hands back the result and lets it finish its turn.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@bastani/pi-ai/compat";
import { AgentWakeDispatcher } from "../../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import type { ExtensionContext } from "../../../packages/coding-agent/src/core/extensions/index.js";
import type { CreateAgentSessionOptions } from "../../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../../packages/coding-agent/src/core/storage/session/types.js";
import { AgentTaskHost } from "../../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { AgentConfig } from "../../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../../packages/subagents/src/runs/foreground/execution.js";
import { bindReleasedChildWakes } from "../../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import {
	subagentReleasePolicy,
	subagentWakeKey,
} from "../../../packages/subagents/src/runs/foreground/released-children.js";
import { subagentChildRecordOf } from "../../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import {
	createSubagentChildRecordSink,
	SUBAGENT_CHILD_RECORD_TYPE,
	subagentChildRecordsAppended,
} from "../../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import type { SubagentChildRestoreDeps } from "../../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { subagentRegistrySizes } from "../../../packages/subagents/src/runs/foreground/subagent-registry-sizes.js";
import { runAgentTask } from "../../../packages/subagents/src/runs/foreground/task-execution.js";
import type { IntercomEventBus } from "../../../packages/subagents/src/shared/types.js";
import type { AgentHost, HostOptions, StoredBytes } from "./agent-host.js";
import { liveAsyncResources, trackAsyncResources } from "./async-resources.js";
import {
	agentOf,
	COMPLETION_TEXT,
	delaySummary,
	lookupTool,
	operations,
	scriptedProvider,
	settle,
	type TranscriptMessage,
	WAIT_TOOL,
	waitTool,
	wakeDriver,
} from "./scripted-model.js";

const worker: AgentConfig = {
	name: "worker",
	description: "waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "worker.md",
};

function isPendingWait(message: TranscriptMessage): boolean {
	return message.role === "toolResult" && message.toolName === WAIT_TOOL;
}

export async function createSubagentHost(options: HostOptions): Promise<AgentHost> {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (gc === undefined) throw new Error("Run with node --expose-gc so samples are taken after a full collection.");
	trackAsyncResources();
	const { faux, model, modelRuntime } = await scriptedProvider(options.root, options.index);
	/** Every request is answered from its transcript: one run asks the lookup `turns` times, then waits on CI. */
	const respond = (context: { readonly messages: readonly TranscriptMessage[] }) => {
		const last = context.messages.at(-1);
		const lookups = context.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "lookup",
		);
		if (last !== undefined && isPendingWait(last)) return fauxAssistantMessage("CI passed; done.");
		if (lookups.length >= options.turns)
			return fauxAssistantMessage(
				[fauxText("Waiting for CI."), fauxToolCall(WAIT_TOOL, { run: `agent-${agentOf(context.messages)}` })],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage(
			[fauxText(COMPLETION_TEXT), fauxToolCall("lookup", { key: `turn-${lookups.length + 1}` })],
			{ stopReason: "toolUse" },
		);
	};
	const script = (requests: number) => faux.appendResponses(Array.from({ length: requests }, () => respond));

	const cwd = join(options.root, "project");
	mkdirSync(cwd, { recursive: true });
	const sessionDir = join(options.root, `children-${options.index}`);
	const sqlitePath = join(options.root, `journal-${options.index}.sqlite`);
	const database = options.store === "sqlite" ? await openNodeSqliteDatabase(sqlitePath) : undefined;
	const store: SessionStore = database === undefined ? new MemorySessionStore() : await SqlSessionStore.open(database);
	const owner = await SessionManager.create(store, cwd);
	const ownerSessionId = owner.getSessionId();
	const taskHost = new AgentTaskHost({ scope: { kind: "session", sessionId: ownerSessionId }, authorizeLaunch() {} });
	/** What every child session, launched or restored, is created with: the scripted model, the two tools, no builtins. */
	const childSessionOptions = (childOptions: CreateAgentSessionOptions): CreateAgentSessionOptions => ({
		...childOptions,
		model,
		modelRuntime,
		customTools: [lookupTool, waitTool],
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
	});
	const ctx = {
		getChildSessionOptions: childSessionOptions,
		cwd,
		mode: "tui",
		hasUI: false,
		ui: {},
		sessionManager: owner,
		getAgentTaskHost: () => taskHost,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		model: undefined,
		thinkingLevel: undefined,
	} as unknown as ExtensionContext;

	let subscriptions = 0;
	const handlers = new Map<string, Array<(payload: object) => void>>();
	const events: IntercomEventBus = {
		on(channel, handler) {
			subscriptions += 1;
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => {
				subscriptions -= 1;
				handlers.set(
					channel,
					(handlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
				);
			};
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
		discoverAgents: () => ({ agents: [worker] }),
		runtime: { runSync },
	};
	const dispatcher = new AgentWakeDispatcher();
	const stopWakes = bindReleasedChildWakes(deps, ctx, events, dispatcher);
	const recordSink = createSubagentChildRecordSink({ appendEntry }, ctx);

	const released: string[] = [];

	async function runAgent(index: number): Promise<void> {
		const runId = `b${options.index}-${index}`;
		const childId = `${runId}:0`;
		const response = await runAgentTask({
			host: taskHost,
			cwd,
			agents: [worker],
			agent: "worker",
			task: `Agent ${index}, watch the CI run: look up ${options.turns} items, then wait for CI.`,
			options: {
				cwd,
				runId,
				index: 0,
				sessionDir,
				sessionManager: await SessionManager.create(store, cwd),
				resumeSession: true,
				releaseWhenWaiting: subagentReleasePolicy(0),
				testSession: false,
				getChildSessionOptions: childSessionOptions,
			},
			wait: { kind: "background" },
			recordChild: recordSink,
			runtime: { runSync },
			wakeDispatcher: dispatcher,
		});
		if (response.kind !== "admitted") throw new Error(`child ${childId} was not admitted: ${response.kind}`);
		await taskHost.waitForTask(response.observation.taskId);
		await subagentChildRecordsAppended(ownerSessionId);
		released.push(childId);
	}

	/** Finish one released child's long operation, as the real one would; resolves with the wake's latency in ms. */
	async function wake(childId: string): Promise<number> {
		const record = subagentChildRecordOf(ownerSessionId, childId);
		if (record?.childSessionId === undefined) throw new Error(`child ${childId} has no record of its session`);
		const call = [...(await store.load(record.childSessionId)).entries]
			.reverse()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [],
			)
			.find((part) => part.type === "toolCall" && part.name === WAIT_TOOL) as
			| { id: string; arguments: { run: string } }
			| undefined;
		const finish = call === undefined ? undefined : operations.get(call.arguments.run);
		if (call === undefined || finish === undefined)
			throw new Error(`child ${childId} is not waiting on a live ${WAIT_TOOL} operation`);
		operations.delete(call.arguments.run);
		const toolResult = {
			toolCallId: call.id,
			toolName: WAIT_TOOL,
			result: { content: [{ type: "text" as const, text: "CI passed" }], details: undefined },
			isError: false,
		};
		const started = performance.now();
		finish(toolResult.result);
		// The same wake the call's own result makes: delivered twice, it is one, and settles when the child has finished.
		await dispatcher.deliver(subagentWakeKey(ownerSessionId, childId), {
			id: `tool-result:${call.id}`,
			kind: "tool-result",
			toolResult,
		});
		return performance.now() - started;
	}

	const wakes = wakeDriver({ ids: () => released, wake, script });

	return {
		async runWave(count, offset) {
			script(count * (options.turns + 1));
			await Promise.all(Array.from({ length: count }, (_, index) => runAgent(offset + index)));
		},
		async snapshot() {
			await settle();
			gc();
			gc();
			const memory = process.memoryUsage();
			return {
				heapUsedBytes: memory.heapUsed,
				arrayBuffersBytes: memory.arrayBuffers,
				handles: liveAsyncResources(),
				listeners: subscriptions,
				registries: {
					...subagentRegistrySizes(),
					...Object.fromEntries(
						Object.entries(dispatcher.stats()).map(([name, size]) => [`dispatcher.${name}`, size]),
					),
				},
			};
		},
		async measureIdle(windowMs) {
			const histogram = monitorEventLoopDelay({ resolution: 10 });
			histogram.enable();
			await new Promise((resolve) => setTimeout(resolve, windowMs));
			histogram.disable();
			return delaySummary(histogram);
		},
		wakeSequential: wakes.wakeSequential,
		wakeBurst: wakes.wakeBurst,
		async stored(sample): Promise<StoredBytes> {
			let jsonBytes = 0;
			let sampled = 0;
			for (const childId of released.slice(0, sample)) {
				const sessionId = subagentChildRecordOf(ownerSessionId, childId)?.childSessionId;
				if (sessionId === undefined) continue;
				jsonBytes += JSON.stringify(await store.load(sessionId)).length;
				sampled += 1;
			}
			const ownerEntryBytes = owner
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CHILD_RECORD_TYPE)
				.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
			return { agents: released.length, sampled, jsonBytes, sqliteFileBytes: 0, ownerEntryBytes };
		},
		stats: () => ({
			dispatcher: dispatcher.stats(),
			liveRehydrated: 0,
			unused: faux.getPendingResponseCount(),
		}),
		async close() {
			stopWakes();
			await taskHost.close("session-close");
			await store.close();
			faux.unregister();
		},
	};
}
