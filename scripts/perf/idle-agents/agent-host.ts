/**
 * One agent host of the idle-agents benchmark: a scripted model, a session store, a runtime whose factory shares one
 * services bundle, and the wake dispatcher. The benchmark runs one host in its main thread, or one per worker thread.
 * Every agent runs `turns` tool turns through the real AgentSession runtime and ends waiting on a detachable long tool;
 * in `release` mode it is then released, in `resident` mode it stays live, as every agent did before #4326.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentSession } from "../../../packages/coding-agent/src/core/agent-session.js";
import type { DetachedToolCall } from "../../../packages/coding-agent/src/core/agent-session-detached-tools.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../packages/coding-agent/src/core/agent-session-runtime.js";
import {
	AgentWakeDispatcher,
	type AgentWakeDispatcherStats,
} from "../../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { createEventBus } from "../../../packages/coding-agent/src/core/event-bus.js";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { StorageProvider } from "../../../packages/coding-agent/src/core/storage/provider.js";
import { SqlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../../packages/coding-agent/src/core/storage/session/types.js";
import { liveAsyncResources, trackAsyncResources } from "./async-resources.js";
import {
	agentOf,
	COMPLETION_TEXT,
	type DelaySummary,
	delaySummary,
	lookupTool,
	operations,
	scriptedProvider,
	settle,
	type TranscriptMessage,
	WAIT_TOOL,
	type WakeResult,
	waitTool,
	wakeDriver,
} from "./scripted-model.js";
import { percentile } from "./summary.js";

export type { DelaySummary, WakeResult } from "./scripted-model.js";

export interface HostOptions {
	/** `sdk`: released SDK sessions. `subagent`: background subagents launched as tasks, released while they wait. */
	readonly path: "sdk" | "subagent";
	readonly root: string;
	readonly index: number;
	readonly store: "memory" | "sqlite";
	readonly mode: "release" | "resident";
	readonly turns: number;
	readonly wakeConcurrency: number;
}

/** What one thread holds after a full collection. */
export interface HostSnapshot {
	readonly heapUsedBytes: number;
	readonly arrayBuffersBytes: number;
	readonly handles: Readonly<Record<string, number>>;
	readonly listeners: number;
	readonly registries?: Readonly<Record<string, number>>;
}

export interface StoredBytes {
	readonly agents: number;
	readonly sampled: number;
	readonly jsonBytes: number;
	readonly sqliteFileBytes: number;
	/** The subagent path: bytes of the child records the owner's session holds, in all. */
	readonly ownerEntryBytes?: number;
}

export interface AgentHost {
	runWave(count: number, offset: number): Promise<void>;
	snapshot(): Promise<HostSnapshot>;
	measureIdle(windowMs: number): Promise<DelaySummary>;
	wakeSequential(count: number): Promise<WakeResult>;
	wakeBurst(count: number): Promise<WakeResult>;
	stored(sample: number): Promise<StoredBytes>;
	stats(): { readonly dispatcher: AgentWakeDispatcherStats; readonly liveRehydrated: number; readonly unused: number };
	close(): Promise<void>;
}

/** The in-memory session store as Atomic opens one for a `{ kind: "memory" }` selection. */
export function memoryStore(): Promise<SessionStore> {
	return new StorageProvider().openSessionStore(
		{ kind: "memory" },
		{ agentDir: process.env.ATOMIC_CODING_AGENT_DIR as string, domain: "sessions" },
	);
}

/**
 * Hand a detached call's result to the dispatcher, once, when its operation finishes. Module-level so the reaction
 * closes over a session id and the dispatcher, never over the session.
 */
function forwardResult(dispatcher: AgentWakeDispatcher, sessionId: string, call: DetachedToolCall): void {
	void call.result.then((toolResult) =>
		dispatcher.deliver(`bench:${sessionId}`, { id: `ci:${call.toolCallId}`, kind: "tool-result", toolResult }),
	);
}

export async function createAgentHost(options: HostOptions): Promise<AgentHost> {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (gc === undefined) throw new Error("Run with node --expose-gc so samples are taken after a full collection.");
	trackAsyncResources();
	const { faux, model, modelRuntime } = await scriptedProvider(options.root, options.index);
	/** Every request is answered from its transcript, so concurrent agents need no shared script order. */
	const respond = (context: { readonly messages: readonly TranscriptMessage[] }) => {
		const last = context.messages.at(-1);
		const turn = context.messages.filter((message) => message.role === "user").length;
		if (last?.role === "user")
			return fauxAssistantMessage([fauxText(COMPLETION_TEXT), fauxToolCall("lookup", { key: `turn-${turn}` })], {
				stopReason: "toolUse",
			});
		if (last?.role === "toolResult" && last.toolName === "lookup" && turn >= options.turns)
			return fauxAssistantMessage(
				[fauxText("Waiting for CI."), fauxToolCall(WAIT_TOOL, { run: `agent-${agentOf(context.messages)}` })],
				{ stopReason: "toolUse" },
			);
		return fauxAssistantMessage(last?.toolName === WAIT_TOOL ? "CI passed; done." : `Turn ${turn} done.`);
	};
	const script = (requests: number) => faux.appendResponses(Array.from({ length: requests }, () => respond));

	const cwd = join(options.root, "project");
	mkdirSync(cwd, { recursive: true });
	const sqlitePath = join(options.root, `journal-${options.index}.sqlite`);
	const database = options.store === "sqlite" ? await openNodeSqliteDatabase(sqlitePath) : undefined;
	const store: SessionStore = database === undefined ? await memoryStore() : await SqlSessionStore.open(database);

	/** The event bus every session's extensions subscribe to, counting live subscriptions. */
	const sharedBus = createEventBus();
	let subscriptions = 0;
	const eventBus = {
		emit: sharedBus.emit,
		on(channel: string, handler: (data: unknown) => void): () => void {
			subscriptions += 1;
			const off = sharedBus.on(channel, handler);
			let active = true;
			return () => {
				if (active) subscriptions -= 1;
				active = false;
				off();
			};
		},
	};
	const agentDir = process.env.ATOMIC_CODING_AGENT_DIR as string;
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		modelRuntime,
		resourceLoaderOptions: {
			builtinPackagePaths: [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			eventBus,
		},
	});
	const factory: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const shared = runtimeOptions.services ?? services;
		return {
			...(await createAgentSessionFromServices({
				services: shared,
				sessionManager: runtimeOptions.sessionManager,
				sessionStartEvent: runtimeOptions.sessionStartEvent,
				model,
				customTools: [lookupTool, waitTool],
			})),
			services: shared,
			diagnostics: shared.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir,
		sessionManager: await SessionManager.create(store, cwd),
	});
	const dispatcher = new AgentWakeDispatcher();
	/** Wakes being timed right now: each is told when its agent has been woken, finished and released again. */
	const finishedWakes = new Map<string, () => void>();
	/** A wake: rehydrate the agent from storage, hand back its long tool's result, finish the turn, release it. */
	dispatcher.handle(
		"bench",
		async (wakeKey, wakes) => {
			const sessionId = wakeKey.slice("bench:".length);
			const session = await runtime.rehydrate(sessionId);
			await session.resumeDetachedTurn(
				wakes.flatMap((wake) => (wake.toolResult === undefined ? [] : [wake.toolResult])),
			);
			await session.release();
			finishedWakes.get(sessionId)?.();
			finishedWakes.delete(sessionId);
		},
		{ maxConcurrent: options.wakeConcurrency },
	);
	const resident: AgentSession[] = [];
	const released: string[] = [];

	async function runAgent(index: number): Promise<void> {
		const { session } = await factory({ cwd, agentDir, sessionManager: await SessionManager.create(store, cwd) });
		session.setToolDetachment({ afterMs: 0 });
		for (let turn = 1; turn <= options.turns; turn++)
			await session.prompt(`Agent ${index}, turn ${turn}: look up the next item and report what you find.`);
		// The long tool's own work is still running. Its result will reach the dispatcher through the call's reaction,
		// as a host that took the call would deliver it.
		const calls = session.takeDetachedToolCalls();
		if (options.mode === "resident") {
			resident.push(session);
			return;
		}
		for (const call of calls) forwardResult(dispatcher, session.sessionId, call);
		released.push((await session.release()).sessionId);
	}

	/** Deliver the long tool's result to one released agent; resolves with the wake's latency in milliseconds. */
	async function wake(sessionId: string): Promise<number> {
		const pending = await store.load(sessionId);
		const call = [...pending.entries]
			.reverse()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [],
			)
			.find((part) => part.type === "toolCall" && part.name === WAIT_TOOL) as
			| { arguments: { run: string } }
			| undefined;
		const finish = call === undefined ? undefined : operations.get(call.arguments.run);
		if (call === undefined || finish === undefined)
			throw new Error(`agent ${sessionId} is not waiting on a live ${WAIT_TOOL} operation`);
		operations.delete(call.arguments.run);
		const finished = new Promise<void>((done) => finishedWakes.set(sessionId, done));
		const started = performance.now();
		// The operation finishing is what wakes the agent: its result goes through the call's reaction to the dispatcher.
		finish({ content: [{ type: "text", text: "CI passed" }], details: undefined });
		await finished;
		return performance.now() - started;
	}

	const wakes = wakeDriver({ ids: () => released, wake, script });

	return {
		async runWave(count, offset) {
			script(count * options.turns * 2);
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
		async stored(sample) {
			const ids = (options.mode === "resident" ? resident.map((session) => session.sessionId) : released).slice(
				0,
				sample,
			);
			let jsonBytes = 0;
			for (const id of ids) jsonBytes += JSON.stringify(await store.load(id)).length;
			let sqliteFileBytes = 0;
			if (database !== undefined) {
				await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
				for (const suffix of ["", "-wal"]) {
					try {
						sqliteFileBytes += statSync(`${sqlitePath}${suffix}`).size;
					} catch {
						// No WAL file once it has been checkpointed.
					}
				}
			}
			return {
				agents: options.mode === "resident" ? resident.length : released.length,
				sampled: ids.length,
				jsonBytes,
				sqliteFileBytes,
			};
		},
		stats: () => ({
			dispatcher: dispatcher.stats(),
			liveRehydrated: runtime.rehydratedSessionCount,
			unused: faux.getPendingResponseCount(),
		}),
		async close() {
			for (const session of resident) await session.dispose();
			await runtime.dispose();
			await store.close();
			faux.unregister();
		},
	};
}

export { percentile };
