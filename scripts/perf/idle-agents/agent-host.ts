/**
 * One agent host of the idle-agents benchmark: a scripted model, a session store, a runtime whose factory shares one
 * services bundle, and the wake dispatcher. The benchmark runs one host in its main thread, or one per worker thread.
 * Every agent runs `turns` tool turns through the real AgentSession runtime and ends waiting on a detachable long tool;
 * in `release` mode it is then released, in `resident` mode it stays live, as every agent did before #4326.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import type { AgentSession } from "../../../packages/coding-agent/src/core/agent-session.js";
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
import { AuthStorage } from "../../../packages/coding-agent/src/core/auth-storage.js";
import { createEventBus } from "../../../packages/coding-agent/src/core/event-bus.js";
import type { ToolDefinition } from "../../../packages/coding-agent/src/core/extensions/index.js";
import { ModelRuntime } from "../../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../../packages/coding-agent/src/core/storage/session/types.js";
import { resetSessionTempCleanupScheduleForTesting } from "../../../packages/coding-agent/src/core/tools/session-temp-cleanup.js";
import { countHandles, percentile } from "./summary.js";

export interface HostOptions {
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
}

export interface DelaySummary {
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
}

export interface WakeResult {
	readonly latencyMs: readonly number[];
	readonly elapsedMs: number;
	readonly delay: DelaySummary;
}

export interface StoredBytes {
	readonly agents: number;
	readonly sampled: number;
	readonly jsonBytes: number;
	readonly sqliteFileBytes: number;
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

/** ~1.2 KB of completion text: 12 chunks of about 100 characters, as agent_scale streams. */
const CHUNK = "The scripted model streams this sentence as one chunk of roughly one hundred characters of output. ";
const COMPLETION_TEXT = CHUNK.repeat(12);
const TOOL_OUTPUT = "lookup result: ".padEnd(100, "x");
export const WAIT_TOOL = "wait_for_ci";

const lookupTool: ToolDefinition = {
	name: "lookup",
	label: "Lookup",
	description: "Returns a short fixed result",
	parameters: Type.Object({ key: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: TOOL_OUTPUT }], details: undefined }),
};

/** The long tool: its work happens elsewhere, and its result comes back through the wake dispatcher. */
const waitTool: ToolDefinition = {
	name: WAIT_TOOL,
	label: "Wait for CI",
	description: "Waits for a CI run that finishes later",
	parameters: Type.Object({ run: Type.String() }),
	detachable: true,
	execute: () => new Promise(() => {}),
};

type TranscriptMessage = { readonly role: string; readonly toolName?: string };

function delaySummary(histogram: ReturnType<typeof monitorEventLoopDelay>): DelaySummary {
	return { p50Ms: histogram.percentile(50) / 1e6, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 };
}

/** Wait, by event-loop turns, until work still finishing lets go of its timers: the counts must repeat five times. */
async function settle(): Promise<void> {
	let previous = "";
	let repeats = 0;
	for (let turn = 0; turn < 500 && repeats < 5; turn++) {
		resetSessionTempCleanupScheduleForTesting();
		await new Promise((resolve) => setImmediate(resolve));
		const current = JSON.stringify(countHandles(process.getActiveResourcesInfo()));
		repeats = current === previous ? repeats + 1 : 0;
		previous = current;
	}
}

export async function createAgentHost(options: HostOptions): Promise<AgentHost> {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (gc === undefined) throw new Error("Run with node --expose-gc so samples are taken after a full collection.");
	const faux = registerFauxProvider({ tokenSize: { min: 25, max: 25 } });
	const model = faux.getModel();
	/** Every request is answered from its transcript, so concurrent agents need no shared script order. */
	const respond = (context: { readonly messages: readonly TranscriptMessage[] }) => {
		const last = context.messages.at(-1);
		const turn = context.messages.filter((message) => message.role === "user").length;
		if (last?.role === "user")
			return fauxAssistantMessage([fauxText(COMPLETION_TEXT), fauxToolCall("lookup", { key: `turn-${turn}` })], {
				stopReason: "toolUse",
			});
		if (last?.role === "toolResult" && last.toolName === "lookup" && turn >= options.turns)
			return fauxAssistantMessage([fauxText("Waiting for CI."), fauxToolCall(WAIT_TOOL, { run: `run-${turn}` })], {
				stopReason: "toolUse",
			});
		return fauxAssistantMessage(last?.toolName === WAIT_TOOL ? "CI passed; done." : `Turn ${turn} done.`);
	};
	const script = (requests: number) => faux.appendResponses(Array.from({ length: requests }, () => respond));

	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(options.root, `models-${options.index}.json`),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const cwd = join(options.root, "project");
	mkdirSync(cwd, { recursive: true });
	const sqlitePath = join(options.root, `journal-${options.index}.sqlite`);
	const database = options.store === "sqlite" ? await openNodeSqliteDatabase(sqlitePath) : undefined;
	const store: SessionStore = database === undefined ? new MemorySessionStore() : await SqlSessionStore.open(database);

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
	/** A wake: rehydrate the agent from storage, hand back its long tool's result, finish the turn, release it. */
	dispatcher.handle(
		"bench",
		async (wakeKey, wakes) => {
			const session = await runtime.rehydrate(wakeKey.slice("bench:".length));
			await session.resumeDetachedTurn(
				wakes.flatMap((wake) => (wake.toolResult === undefined ? [] : [wake.toolResult])),
			);
			await session.release();
		},
		{ maxConcurrent: options.wakeConcurrency },
	);
	const resident: AgentSession[] = [];
	const released: string[] = [];
	let woken = 0;

	async function runAgent(index: number): Promise<void> {
		const { session } = await factory({ cwd, agentDir, sessionManager: await SessionManager.create(store, cwd) });
		session.setToolDetachment({ afterMs: 0 });
		for (let turn = 1; turn <= options.turns; turn++)
			await session.prompt(`Agent ${index}, turn ${turn}: look up the next item and report what you find.`);
		// The long tool's own work holds its result; the benchmark delivers it later from outside, by wake key.
		session.takeDetachedToolCalls();
		if (options.mode === "resident") resident.push(session);
		else released.push((await session.release()).sessionId);
	}

	/** Deliver the long tool's result to one released agent; resolves with the wake's latency in milliseconds. */
	async function wake(sessionId: string): Promise<number> {
		const pending = await store.load(sessionId);
		const call = [...pending.entries]
			.reverse()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [],
			)
			.find((part) => part.type === "toolCall" && part.name === WAIT_TOOL) as { id: string } | undefined;
		if (call === undefined) throw new Error(`agent ${sessionId} is not waiting on ${WAIT_TOOL}`);
		const started = performance.now();
		await dispatcher.deliver(`bench:${sessionId}`, {
			id: `ci:${call.id}`,
			kind: "tool-result",
			toolResult: {
				toolCallId: call.id,
				toolName: WAIT_TOOL,
				result: { content: [{ type: "text", text: "CI passed" }], details: undefined },
				isError: false,
			},
		});
		return performance.now() - started;
	}

	/** The next `count` released agents not woken yet, spread over the population. */
	function nextToWake(count: number): string[] {
		const stride = Math.max(1, Math.floor(released.length / Math.max(1, count * 2)));
		const picked: string[] = [];
		for (let index = woken; index < released.length && picked.length < count; index += stride)
			picked.push(released[index] as string);
		woken += 1;
		return picked;
	}

	async function timedWakes(targets: readonly string[], concurrent: boolean): Promise<WakeResult> {
		script(targets.length);
		const histogram = monitorEventLoopDelay({ resolution: 10 });
		histogram.enable();
		const started = performance.now();
		const latencyMs: number[] = [];
		if (concurrent) latencyMs.push(...(await Promise.all(targets.map((sessionId) => wake(sessionId)))));
		else for (const sessionId of targets) latencyMs.push(await wake(sessionId));
		const elapsedMs = performance.now() - started;
		histogram.disable();
		return { latencyMs, elapsedMs, delay: delaySummary(histogram) };
	}

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
				handles: countHandles(process.getActiveResourcesInfo()),
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
		wakeSequential: (count) => timedWakes(nextToWake(count), false),
		wakeBurst: (count) => timedWakes(nextToWake(count), true),
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
