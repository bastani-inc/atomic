import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryObjects } from "node:v8";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { DetachedToolCall, DetachedToolResult } from "../src/core/agent-session-detached-tools.js";
import { armedIdleSessionCount } from "../src/core/agent-session-release.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AgentWakeDispatcher } from "../src/core/agent-wake-dispatcher.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionConflictError } from "../src/core/storage/session/errors.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import { releasedHistoryFiles } from "../src/core/storage/session/released-history-files.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { resetSessionTempCleanupScheduleForTesting } from "../src/core/tools/session-temp-cleanup.ts";

/**
 * CI-sized counting variant of scripts/perf/idle-agents (#4326): agents run tool turns through the real runtime with a
 * scripted model, wait on a detachable long tool, and are released. Everything is counted, nothing is timed: active
 * timers, sockets and processes, shared event-bus subscriptions, dispatcher entries, live sessions, and store
 * operations per wake. A resident run is the positive control: it shows the counters see per-agent state.
 */
const AGENTS_PER_WAVE = 12;
const TURNS = 3;
const WAIT_TOOL = "wait_for_ci";

const agentDir = useTemporaryAgentDir();

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	vi.unstubAllEnvs();
});

/** Delegates to a memory store and counts its operations; `spill` forwards `release`, so released agents leave memory. */
function countingStore(inner: MemorySessionStore, spill: boolean) {
	const counts = new Map<string, number>();
	const counted =
		<T extends unknown[], R>(name: string, operation: (...args: T) => R) =>
		(...args: T): R => {
			counts.set(name, (counts.get(name) ?? 0) + 1);
			return operation(...args);
		};
	const store: SessionStore = {
		get descriptor() {
			return inner.descriptor;
		},
		create: counted("create", inner.create.bind(inner)),
		append: counted("append", inner.append.bind(inner)),
		replace: counted("replace", inner.replace.bind(inner)),
		load: counted("load", inner.load.bind(inner)),
		readHeader: counted("readHeader", inner.readHeader.bind(inner)),
		delete: counted("delete", inner.delete.bind(inner)),
		list: counted("list", inner.list.bind(inner)),
		findMostRecent: counted("findMostRecent", inner.findMostRecent.bind(inner)),
		close: counted("close", inner.close.bind(inner)),
		...(spill ? { releaseSession: counted("releaseSession", inner.releaseSession.bind(inner)) } : {}),
	};
	return { store, inner, get: (name: string) => counts.get(name) ?? 0, reset: () => counts.clear() };
}

/** Timers, sockets and child processes this process holds now. */
function handles(): { timers: number; sockets: number; processes: number } {
	const resources = process.getActiveResourcesInfo();
	const count = (kinds: readonly string[]) => resources.filter((resource) => kinds.includes(resource)).length;
	return {
		timers: count(["Timeout", "Immediate"]),
		sockets: count(["TCPSocketWrap", "PipeWrap", "TCPServerWrap", "PipeServerWrap", "TLSWrap", "UDPWrap"]),
		processes: count(["ProcessWrap"]),
	};
}

/** Event-loop turns a snapshot may wait for work still finishing (an auth check, a close) to let go of its timer. */
const SETTLE_TURNS = 500;

/**
 * Handles once nothing is still finishing: the counts are read after each event-loop turn until they repeat five
 * times. The one process-wide temp-directory sweep a new session schedules is cancelled first: it is a single
 * debounced timer for the whole process, armed or not by timing alone.
 */
async function settledHandles(): Promise<{ timers: number; sockets: number; processes: number }> {
	let previous = "";
	let repeats = 0;
	for (let turn = 0; turn < SETTLE_TURNS; turn++) {
		resetSessionTempCleanupScheduleForTesting();
		await new Promise((resolve) => setImmediate(resolve));
		const current = JSON.stringify(handles());
		repeats = current === previous ? repeats + 1 : 0;
		previous = current;
		if (repeats >= 5 && JSON.parse(current).timers === 0) break;
	}
	return handles();
}

/** How the long tool's work runs, and what the host does with a call that outlived its run. */
interface LongCall {
	readonly start: (toolCallId: string) => Promise<AgentToolResult>;
	readonly taken: (call: DetachedToolCall, sessionId: string) => void;
}

const NEVER_ENDING: LongCall = { start: () => new Promise(() => {}), taken: () => {} };

interface HostOptions {
	/** Whether a release moves the agent's history out of memory (#4502); off, the store keeps it in memory. */
	readonly spill?: boolean;
}

async function host(longCall: LongCall = NEVER_ENDING, options: HostOptions = {}) {
	const tempDir = join(tmpdir(), `atomic-idle-count-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	vi.stubEnv("PI_CACHE_RETENTION", "none");
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(tempDir, "models.json"),
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
	const bus = createEventBus();
	let subscriptions = 0;
	const eventBus = {
		emit: bus.emit,
		on(channel: string, handler: (data: unknown) => void): () => void {
			subscriptions += 1;
			const off = bus.on(channel, handler);
			let active = true;
			return () => {
				if (active) subscriptions -= 1;
				active = false;
				off();
			};
		},
	};
	const tools: ToolDefinition[] = [
		{
			name: "lookup",
			label: "Lookup",
			description: "Returns a fixed result",
			parameters: Type.Object({ key: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "found" }], details: undefined }),
		},
		{
			name: WAIT_TOOL,
			label: "Wait for CI",
			description: "Waits for CI",
			parameters: Type.Object({ run: Type.String() }),
			detachable: true,
			execute: (toolCallId) => longCall.start(toolCallId),
		},
	];
	faux.setResponses([]);
	// Fixed-width call IDs: the faux provider's own carry a random suffix whose length varies, and the release tests
	// compare history sizes to the byte.
	let calls = 0;
	const callId = () => ({ id: `call-${String(++calls).padStart(8, "0")}` });
	const respond = (context: {
		readonly messages: readonly { readonly role: string; readonly toolName?: string }[];
	}) => {
		const last = context.messages.at(-1);
		const turn = context.messages.filter((message) => message.role === "user").length;
		if (last?.role === "user")
			return fauxAssistantMessage(
				[fauxText("x".repeat(1200)), fauxToolCall("lookup", { key: `${turn}` }, callId())],
				{
					stopReason: "toolUse",
				},
			);
		if (last?.toolName === "lookup" && turn >= TURNS)
			return fauxAssistantMessage([fauxToolCall(WAIT_TOOL, { run: `${turn}` }, callId())], {
				stopReason: "toolUse",
			});
		return fauxAssistantMessage(last?.toolName === WAIT_TOOL ? "ci passed" : "turn done");
	};
	const script = (requests: number) => faux.appendResponses(Array.from({ length: requests }, () => respond));
	const store = countingStore(
		new MemorySessionStore(undefined, releasedHistoryFiles(agentDir)),
		options.spill ?? true,
	);
	const services = await createAgentSessionServices({
		cwd: tempDir,
		agentDir: tempDir,
		modelRuntime,
		resourceLoaderOptions: {
			builtinPackagePaths: [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			eventBus,
		},
	});
	const factory: CreateAgentSessionRuntimeFactory = async (options) => {
		const shared = options.services ?? services;
		return {
			...(await createAgentSessionFromServices({
				services: shared,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model,
				customTools: tools,
			})),
			services: shared,
			diagnostics: shared.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(factory, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: await SessionManager.create(store.store, tempDir),
	});
	const live: AgentSession[] = [];
	cleanups.push(async () => {
		for (const session of live) await session.dispose();
		await runtime.dispose();
		await store.inner.close();
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	});
	/** Run one agent through its turns, each prompt `promptBytes` longer, until it waits on the long tool. */
	const runAgent = async (index: number, promptBytes = 0): Promise<AgentSession> => {
		const { session } = await factory({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(store.store, tempDir),
		});
		session.setToolDetachment({ afterMs: 0 });
		const padding = "y".repeat(promptBytes);
		for (let turn = 1; turn <= TURNS; turn++) await session.prompt(`agent ${index} turn ${turn}${padding}`);
		const calls = session.takeDetachedToolCalls();
		assert.deepEqual(
			calls.map((call) => call.toolName),
			[WAIT_TOOL],
		);
		for (const call of calls) longCall.taken(call, session.sessionId);
		return session;
	};
	return { runtime, store, script, runAgent, live, subscriptions: () => subscriptions };
}

/**
 * Async context stores alive now. On Node before 24 a store that has run stays in the process's hook list for good, and
 * every promise or async resource made after it visits every one of them: a store per agent is kept, and slows the
 * whole process down, after the agent is gone.
 */
function asyncContextStores(): number {
	return queryObjects(AsyncLocalStorage, { format: "count" }) as number;
}

describe("idle agents hold nothing per agent (#4326)", () => {
	test("released agents add no timer, socket, process, listener, async context store, dispatcher entry or live session", async () => {
		const h = await host();
		const dispatcher = new AgentWakeDispatcher();
		const released: string[] = [];
		const wave = async (offset: number) => {
			h.script(AGENTS_PER_WAVE * TURNS * 2);
			const sessions = await Promise.all(
				Array.from({ length: AGENTS_PER_WAVE }, (_, index) => h.runAgent(offset + index)),
			);
			for (const session of sessions) released.push((await session.release()).sessionId);
		};

		await wave(0);
		const afterFirst = {
			handles: await settledHandles(),
			listeners: h.subscriptions(),
			stores: asyncContextStores(),
		};
		await wave(AGENTS_PER_WAVE);
		await wave(AGENTS_PER_WAVE * 2);

		assert.equal(released.length, AGENTS_PER_WAVE * 3);
		assert.deepEqual(await settledHandles(), afterFirst.handles);
		assert.equal(h.subscriptions(), afterFirst.listeners);
		assert.equal(asyncContextStores(), afterFirst.stores);
		assert.equal(h.runtime.rehydratedSessionCount, 0);
		assert.equal(armedIdleSessionCount(), 0);
		assert.deepEqual(dispatcher.stats(), {
			keys: 0,
			queued: 0,
			running: 0,
			scheduled: 0,
			timers: 0,
			handlers: 0,
			namespaces: 0,
			unobservedFailures: 0,
		});
	});

	test("a wake reads the agent's history once, finishes its turn, and leaves nothing behind", async () => {
		const h = await host();
		const dispatcher = new AgentWakeDispatcher();
		h.script(AGENTS_PER_WAVE * TURNS * 2);
		const sessions = await Promise.all(Array.from({ length: AGENTS_PER_WAVE }, (_, index) => h.runAgent(index)));
		const released: string[] = [];
		for (const session of sessions) released.push((await session.release()).sessionId);
		const idle = { handles: await settledHandles(), listeners: h.subscriptions() };
		dispatcher.handle("bench", async (wakeKey, wakes) => {
			const session = await h.runtime.rehydrate(wakeKey.slice("bench:".length));
			await session.resumeDetachedTurn(wakes.flatMap((wake) => (wake.toolResult ? [wake.toolResult] : [])));
			await session.release();
		});

		for (const sessionId of released) {
			const transcript = (await h.store.store.load(sessionId)).entries;
			const call = transcript
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [],
				)
				.find((part) => part.type === "toolCall" && part.name === WAIT_TOOL) as { id: string };
			h.script(1);
			h.store.reset();
			await dispatcher.deliver(`bench:${sessionId}`, {
				id: `ci:${call.id}`,
				kind: "tool-result",
				toolResult: {
					toolCallId: call.id,
					toolName: WAIT_TOOL,
					result: { content: [{ type: "text", text: "green" }], details: undefined },
					isError: false,
				},
			});
			assert.equal(h.store.get("readHeader"), 1);
			assert.equal(h.store.get("load"), 1);
		}

		assert.deepEqual(await settledHandles(), idle.handles);
		assert.equal(h.subscriptions(), idle.listeners);
		assert.equal(h.runtime.rehydratedSessionCount, 0);
		assert.deepEqual(
			{ ...dispatcher.stats(), handlers: 0, namespaces: 0 },
			{ keys: 0, queued: 0, running: 0, scheduled: 0, timers: 0, handlers: 0, namespaces: 0, unobservedFailures: 0 },
		);
		const finished = (await h.store.store.load(released[0] as string)).entries.at(-1);
		assert.equal(finished?.type === "message" && finished.message.role === "assistant", true);
	});

	test("positive control: resident agents keep their extension listeners, one set per agent", async () => {
		const h = await host();
		const before = h.subscriptions();
		h.script(AGENTS_PER_WAVE * TURNS * 2);
		for (let index = 0; index < AGENTS_PER_WAVE; index++) h.live.push(await h.runAgent(index));
		const perAgent = (h.subscriptions() - before) / AGENTS_PER_WAVE;
		assert.ok(Number.isInteger(perAgent) && perAgent >= 1, `expected whole listener sets per agent, saw ${perAgent}`);
		for (const session of h.live.splice(0)) await session.release();
		assert.equal(h.subscriptions(), before);
	});
});

/**
 * A host's forwarding of a released agent's call, as a host that took the call does it: one reaction on the call's
 * result that delivers it as a wake, holding the result and the agent's id, not the call.
 */
function forwardResult(dispatcher: AgentWakeDispatcher, sessionId: string, result: Promise<DetachedToolResult>): void {
	void result.then((toolResult) =>
		dispatcher.deliver(`bench:${sessionId}`, { id: `ci:${toolResult.toolCallId}`, kind: "tool-result", toolResult }),
	);
}

const COUNTED = { Promise, AbortSignal, ArrayBuffer } as const;

/**
 * Live objects of each counted kind. Each count is a full collection and a walk of the whole heap, so the test takes
 * three of them per sample and no more.
 */
function liveObjects(): Record<keyof typeof COUNTED, number> {
	const counts = {} as Record<keyof typeof COUNTED, number>;
	for (const [name, kind] of Object.entries(COUNTED) as [keyof typeof COUNTED, typeof Promise][])
		counts[name] = queryObjects(kind, { format: "count" }) as number;
	return counts;
}

/** The test walks the vitest worker's whole heap seven times; in a loaded full-suite run that outlasts the default budget. */
const HEAP_WALK_TEST_TIMEOUT_MS = 90_000;

function wholeCountPerAgent(delta: number, agents: number): number {
	return Math.round(delta / agents) || 0;
}

/**
 * On Node before 24, AsyncLocalStorage runs on promise hooks, and the engine then keeps one more promise while the
 * call's promise adopts the tool's.
 */
const ADOPTION_ON_PROMISE_HOOKS = Number(process.versions.node.split(".")[0]) < 24 ? 1 : 0;

/**
 * What one released agent may keep beyond its stored history: the long tool's own promise, the call's promise and the
 * result it makes, and the host's forwarding reaction; no abort signal; and its history in at most log2 of its size
 * buffers, plus its header.
 */
const RELEASED_AGENT_PROMISES = 4 + ADOPTION_ON_PROMISE_HOOKS;

describe("a released agent keeps its history and its long call's delivery, nothing else (#4403)", () => {
	test(
		"per released agent: no abort signal, only the promises that deliver its call, and log2(history) buffers",
		async () => {
			const operations = new Map<string, (result: AgentToolResult) => void>();
			const dispatcher = new AgentWakeDispatcher();
			const delivered: string[] = [];
			dispatcher.handle("bench", async (_wakeKey, wakes) => {
				for (const wake of wakes) delivered.push(wake.id);
			});
			const h = await host(
				{
					start: (toolCallId) => new Promise((resolve) => operations.set(toolCallId, resolve)),
					taken: (call, sessionId) => forwardResult(dispatcher, sessionId, call.result),
				},
				{ spill: false },
			);
			const released: string[] = [];
			const wave = async (offset: number) => {
				h.script(AGENTS_PER_WAVE * TURNS * 2);
				const sessions = await Promise.all(
					Array.from({ length: AGENTS_PER_WAVE }, (_, index) => h.runAgent(offset + index)),
				);
				for (const session of sessions) released.push((await session.release()).sessionId);
			};

			await wave(0);
			await settledHandles();
			const before = liveObjects();
			const firstWave = new Set(operations.keys());
			await wave(AGENTS_PER_WAVE);
			await wave(AGENTS_PER_WAVE * 2);
			await settledHandles();
			const idle = liveObjects();

			const agents = AGENTS_PER_WAVE * 2;
			const perAgent = (counts: Record<keyof typeof COUNTED, number>, name: keyof typeof COUNTED) =>
				wholeCountPerAgent(counts[name] - before[name], agents);
			const history = (await h.store.store.load(released.at(-1) as string)).entries;
			const historyBytes = Buffer.byteLength(JSON.stringify(history));
			assert.equal(perAgent(idle, "AbortSignal"), 0);
			assert.ok(
				perAgent(idle, "Promise") <= RELEASED_AGENT_PROMISES,
				`${perAgent(idle, "Promise")} promises per agent`,
			);
			assert.ok(
				perAgent(idle, "ArrayBuffer") <= Math.floor(Math.log2(historyBytes)) + 2,
				`${perAgent(idle, "ArrayBuffer")} buffers per agent for ${historyBytes} bytes of history`,
			);

			// What stayed is the calls' delivery: finishing the operations delivers each result and frees what it held.
			const later = [...operations.keys()].filter((toolCallId) => !firstWave.has(toolCallId));
			for (const toolCallId of later) {
				const finish = operations.get(toolCallId);
				operations.delete(toolCallId);
				finish?.({ content: [{ type: "text", text: "green" }], details: undefined });
			}
			for (let turn = 0; turn < SETTLE_TURNS && delivered.length < agents; turn++)
				await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(delivered.sort(), later.map((toolCallId) => `ci:${toolCallId}`).sort());
			await settledHandles();
			const finishedPromises = queryObjects(Promise, { format: "count" }) as number;
			assert.equal(wholeCountPerAgent(finishedPromises - before.Promise, agents), 0);
		},
		HEAP_WALK_TEST_TIMEOUT_MS,
	);
});

/** The most history bytes a released agent may keep in process memory: its session header, whatever its history. */
const RELEASED_AGENT_RESIDENT_HISTORY_BYTES = 512;
/** The most ArrayBuffer bytes a released agent may add to the process: its header's buffer, with room for allocator rounding. */
const RELEASED_AGENT_BUFFER_BYTES = 1024;
/** What each prompt of the longer agents adds to their history. */
const LONGER_PROMPT_BYTES = 12_000;

describe("a released agent's history leaves process memory (#4502)", () => {
	/**
	 * One host whose agents are released in groups of two waves; `group(promptBytes)` runs a group with prompts that
	 * much longer and returns what each of its agents added, after a full collection, since the group before.
	 */
	async function releasedGroups(spill: boolean) {
		const h = await host(NEVER_ENDING, { spill });
		let next = 0;
		let last = "";
		const sample = async () => {
			await settledHandles();
			return { ...liveObjects(), bytes: process.memoryUsage().arrayBuffers, held: h.store.inner.historyBytes() };
		};
		const waves = async (count: number, promptBytes: number) => {
			for (let wave = 0; wave < count; wave++) {
				h.script(AGENTS_PER_WAVE * TURNS * 2);
				const sessions = await Promise.all(
					Array.from({ length: AGENTS_PER_WAVE }, () => h.runAgent(next++, promptBytes)),
				);
				for (const session of sessions) last = (await session.release()).sessionId;
			}
		};
		await waves(1, 0);
		let before = await sample();
		return async (promptBytes: number) => {
			await waves(2, promptBytes);
			const after = await sample();
			const agents = AGENTS_PER_WAVE * 2;
			const added = {
				historyBytes: Buffer.byteLength(JSON.stringify((await h.store.inner.load(last)).entries)) - 2,
				headerBytes: Buffer.byteLength(JSON.stringify(await h.store.inner.readHeader(last))),
				buffers: wholeCountPerAgent(after.ArrayBuffer - before.ArrayBuffer, agents),
				promises: wholeCountPerAgent(after.Promise - before.Promise, agents),
				abortSignals: wholeCountPerAgent(after.AbortSignal - before.AbortSignal, agents),
				bytes: (after.bytes - before.bytes) / agents,
				inMemory: (after.held.inMemory - before.held.inMemory) / agents,
				onDisk: (after.held.onDisk - before.held.onDisk) / agents,
			};
			before = after;
			return added;
		};
	}

	test(
		"per released agent: only its header stays in memory, one buffer, no abort signal and only its call's promises, however long its history",
		async () => {
			const group = await releasedGroups(true);
			const short = await group(0);
			const long = await group(LONGER_PROMPT_BYTES);
			assert.ok(
				long.historyBytes - short.historyBytes >= TURNS * LONGER_PROMPT_BYTES,
				`${long.historyBytes} vs ${short.historyBytes} bytes`,
			);
			for (const run of [short, long]) {
				assert.equal(run.inMemory, run.headerBytes);
				assert.ok(run.inMemory <= RELEASED_AGENT_RESIDENT_HISTORY_BYTES, `${run.inMemory} history bytes in memory`);
				assert.ok(run.onDisk >= run.historyBytes * 0.95, `${run.onDisk} of ${run.historyBytes} bytes on disk`);
				assert.ok(run.buffers <= 1, `${run.buffers} buffers per agent`);
				assert.ok(run.bytes <= RELEASED_AGENT_BUFFER_BYTES, `${run.bytes} buffer bytes per agent`);
				assert.equal(run.abortSignals, 0);
				assert.ok(run.promises <= RELEASED_AGENT_PROMISES, `${run.promises} promises per agent`);
			}
		},
		HEAP_WALK_TEST_TIMEOUT_MS,
	);

	test(
		"positive control: without a release to disk, each agent's buffers hold its whole history",
		async () => {
			const group = await releasedGroups(false);
			const kept = await group(LONGER_PROMPT_BYTES);
			assert.equal(kept.onDisk, 0);
			assert.ok(kept.inMemory >= kept.historyBytes, `${kept.inMemory} of ${kept.historyBytes} bytes in memory`);
			assert.ok(kept.bytes >= kept.historyBytes * 0.9, `${kept.bytes} buffer bytes for ${kept.historyBytes}`);
		},
		HEAP_WALK_TEST_TIMEOUT_MS,
	);
});

describe("in-memory history costs its UTF-8 size (#4326)", () => {
	test("records with text outside Latin-1 round-trip exactly and are held as UTF-8 bytes", async () => {
		const store = new MemorySessionStore();
		const text = `${"plain ascii — arrows → ellipsis … ".repeat(1500)}lone \ud800 surrogate`;
		const header = (id: string) => ({ id, version: 4 as const, createdAt: "2026-11-05T00:00:00.000Z", cwd: "/repo" });
		const entry = (id: string) => ({
			type: "custom" as const,
			id,
			parentId: null,
			timestamp: "2026-11-05T00:00:00.000Z",
			customType: "note",
			data: { text },
		});
		const sessions = 40;
		const expected = Buffer.byteLength(JSON.stringify({ header: header("s-00"), entries: [entry("e")], lastSeq: 1 }));
		const before = process.memoryUsage().arrayBuffers;
		for (let index = 0; index < sessions; index++)
			await store.create(header(`s-${String(index).padStart(2, "0")}`), [entry("e")]);
		const grown = process.memoryUsage().arrayBuffers - before;

		const loaded = await store.load("s-07");
		assert.equal((loaded.entries[0] as { data: { text: string } }).data.text, text);
		assert.ok(
			grown >= sessions * expected * 0.9 && grown <= sessions * expected * 1.1,
			`expected about ${sessions * expected} bytes of UTF-8, the store grew by ${grown}`,
		);
	});

	test("an append encodes only the entries it adds and reads nothing back, however long the session already is (#4326)", async () => {
		const store = new MemorySessionStore();
		const header = { id: "s-long", version: 4 as const, createdAt: "2026-11-05T00:00:00.000Z", cwd: "/repo" };
		const entry = (index: number) => ({
			type: "custom" as const,
			id: `e-${index}`,
			parentId: null,
			timestamp: "2026-11-05T00:00:00.000Z",
			customType: "note",
			data: { text: `note ${index} → ${"x".repeat(400)}` },
		});
		const appends = 300;
		await store.create(header, []);
		const encode = vi.spyOn(TextEncoder.prototype, "encode");
		const decode = vi.spyOn(TextDecoder.prototype, "decode");
		const encodedPerAppend: number[] = [];
		let encodedByConflict: number;
		try {
			for (let index = 0; index < appends; index++) {
				encode.mockClear();
				await store.append(header.id, [entry(index)], { expectSeq: index });
				encodedPerAppend.push(encode.mock.results.reduce((sum, result) => sum + result.value.byteLength, 0));
			}
			encode.mockClear();
			await assert.rejects(
				store.append(header.id, [entry(appends)], { expectSeq: appends - 1 }),
				(error: Error) => error instanceof SessionConflictError,
			);
			encodedByConflict = encode.mock.calls.length;
			assert.equal(decode.mock.calls.length, 0);
		} finally {
			encode.mockRestore();
			decode.mockRestore();
		}

		assert.deepEqual(
			encodedPerAppend,
			Array.from({ length: appends }, (_, index) => Buffer.byteLength(JSON.stringify(entry(index)))),
		);
		assert.equal(encodedByConflict, 0);
		const loaded = await store.load(header.id);
		assert.deepEqual(loaded, {
			header,
			entries: Array.from({ length: appends }, (_, index) => entry(index)),
			lastSeq: appends,
		});
		assert.deepEqual(await store.load(header.id), loaded, "loading again returns the same snapshot");
		const reopened = await store.reopen();
		await reopened.append(header.id, [entry(appends)], { expectSeq: appends });
		assert.deepEqual((await store.load(header.id)).entries.at(-1), entry(appends), "a reopened store shares records");
	});
});
