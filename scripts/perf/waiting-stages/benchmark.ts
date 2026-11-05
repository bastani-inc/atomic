#!/usr/bin/env bun
/**
 * Idle-agent memory benchmark for waiting workflow stages (#4309), after hydro-project/infinity's `agent_scale`.
 *
 * Launches agents in waves. Each agent is a workflow stage that runs `--turns` turns through the real runtime against
 * a scripted model: the user message enters the stage, the model streams about 1.2 KB of text and calls a tool, the
 * tool result comes back, and a second completion of about 1.2 KB closes the turn. A last turn calls a fake long tool
 * (`wait_for_ci`) that never answers until the wake phase, so the stage ends up waiting on it. After each wave every
 * agent of the wave waits, and the process RSS and heap are sampled after a full collection; the report gives the
 * per-agent slope. Waves are then woken one by one and the wake latency is recorded.
 *
 * Every stage runs through `run()` with the SDK stage adapter over a real `AgentSession`; one run holds one wave.
 *
 *   bun run scripts/perf/waiting-stages/benchmark.ts --agents 1000 --wave 500 --store sqlite --label after --out after.json
 *
 * The run fails (non-zero exit, no report written) when the idle invariants of `assertIdleInvariants` are violated.
 *
 * `--store memory` keeps the conversations in an in-memory session store, comparable to Infinity's in-memory figure;
 * `--store sqlite` uses the default SQLite session store and journal on disk.
 */
import { getEventListeners } from "node:events";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import {
	AuthStorage,
	ModelRuntime,
	resolveSessionStore,
	type SessionStore,
	SettingsManager,
	type ToolDefinition,
} from "@bastani/atomic";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { InMemoryCodingAgentModelsStore } from "../../../packages/coding-agent/src/core/models-store.js";
import { MemorySessionStore } from "../../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { createAgentSessionAdapter, run, workflow } from "../../../packages/workflows/src/sdk-surface.js";
import type { StageLifecycleEvent } from "../../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createStore } from "../../../packages/workflows/src/shared/store.js";

export interface Options {
	readonly agents: number;
	readonly turns: number;
	readonly wave: number;
	readonly store: "memory" | "sqlite";
	readonly label: string;
	readonly out?: string;
	/** False for a build whose stages cannot release: a wave is idle once every agent called the long tool. */
	readonly expectRelease: boolean;
}

export function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const count = (name: string, fallback: number): number => {
		const raw = value(name);
		const parsed = raw === undefined ? fallback : Number(raw);
		if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer, got ${raw}`);
		return parsed;
	};
	const store = value("store") ?? "sqlite";
	if (store !== "memory" && store !== "sqlite") throw new Error(`--store must be memory or sqlite, got ${store}`);
	const out = value("out");
	return {
		agents: count("agents", 1_000),
		turns: count("turns", 20),
		wave: count("wave", 500),
		store,
		label: value("label") ?? "run",
		...(out === undefined ? {} : { out: resolve(out) }),
		expectRelease: !argv.includes("--no-release"),
	};
}

/** About 100 characters of assistant text per chunk, as in agent_scale. */
const CHUNK_TEXT = "Reviewed the module and updated the failing case; the assertion now covers the boundary path. ";
/** Twelve chunks: about 1.2 KB of assistant text per completion. */
const COMPLETION_TEXT = CHUNK_TEXT.repeat(12);
const TOOL_RESULT_TEXT = "test result: ok. 148 passed; 0 failed; 3 ignored; finished in 21.38s".repeat(5);
const WAIT_MARKER = "Wait for the CI run";
const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

function userText(agent: number, turn: number): string {
	return `Turn ${turn}: re-run the affected tests for agent-${agent} and summarize any failures along with the modules they belong to.`;
}

/** The engine's `gc`, exposing it on a plain `node` run through the `vm` trick when `--expose-gc` was not passed. */
function resolveNodeGc(): (() => void) | undefined {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

function collect(): void {
	const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
	if (bun !== undefined) {
		bun.gc(true);
		bun.gc(true);
		return;
	}
	const gc = resolveNodeGc();
	gc?.();
	gc?.();
}

async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await new Promise((resolve) => setTimeout(resolve, 20));
	collect();
}

function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function summarize(values: readonly number[]): { p50: number; p99: number; max: number } {
	const sorted = [...values].sort((left, right) => left - right);
	return { p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), max: sorted.at(-1) ?? 0 };
}

/** Event-loop delay from one 10 ms timer: how late each tick fires. One timer for the whole process, not per agent. */
function eventLoopDelaySampler(): { stop(): { p50: number; p99: number; max: number } } {
	const delays: number[] = [];
	let expected = performance.now() + 10;
	const timer = setInterval(() => {
		const now = performance.now();
		delays.push(Math.max(0, now - expected));
		expected = now + 10;
	}, 10);
	return {
		stop() {
			clearInterval(timer);
			return summarize(delays);
		},
	};
}

function activeResources(): Record<string, number> {
	const info = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? [];
	const counts: Record<string, number> = {};
	for (const kind of info) counts[kind] = (counts[kind] ?? 0) + 1;
	return counts;
}

/** The most numerous heap object types under Bun (`bun:jsc`), to see what an idle agent keeps. */
async function objectTypeCounts(): Promise<Record<string, number> | undefined> {
	if ((globalThis as { Bun?: object }).Bun === undefined) return undefined;
	const { heapStats } = (await import("bun:jsc")) as { heapStats(): { objectTypeCounts: Record<string, number> } };
	return Object.fromEntries(
		Object.entries(heapStats().objectTypeCounts)
			.sort((left, right) => right[1] - left[1])
			.slice(0, 25),
	);
}

function slope(points: readonly { readonly agents: number; readonly bytes: number }[]): number {
	const n = points.length;
	if (n < 2) return 0;
	const meanX = points.reduce((sum, point) => sum + point.agents, 0) / n;
	const meanY = points.reduce((sum, point) => sum + point.bytes, 0) / n;
	let numerator = 0;
	let denominator = 0;
	for (const point of points) {
		numerator += (point.agents - meanX) * (point.bytes - meanY);
		denominator += (point.agents - meanX) ** 2;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

function directoryBytes(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
	}
	return total;
}

/** The idle-phase fields `assertIdleInvariants` reads; `runIdleAgentBenchmark`'s report carries them. */
export interface IdleInvariantReport {
	readonly options: Pick<Options, "agents" | "wave" | "expectRelease">;
	readonly idle: {
		readonly liveSessions: number;
		readonly sessionsRetained: number;
		readonly waitingStages: number;
		readonly ciCallsPending: number;
		readonly abortListenersPerRun: { readonly max: number };
		readonly resources: Readonly<Record<string, number>>;
	};
	readonly baselineResources: Readonly<Record<string, number>>;
}

/**
 * Per run, the resource handles of one kind that may exist beyond the baseline while every agent idles: the run's own
 * timers and its wake dispatcher, not anything per agent. A per-agent handle puts hundreds here.
 */
export const IDLE_RESOURCE_GROWTH_PER_RUN = 16;
/** Abort listeners on one run's signal while its agents idle: the wake dispatcher's one, with slack for run-wide ones. */
export const ABORT_LISTENERS_PER_RUN_MAX = 16;
/** Resource kinds that come and go with ordinary asynchronous work rather than holding the process open. */
const TRANSIENT_RESOURCE_KINDS: ReadonlySet<string> = new Set(["PromiseResolve", "FSReqCallback"]);

/**
 * Throws when an idle agent still costs something per agent: a live or retained session, a handle (timer, socket,
 * pipe, child process) beyond a small per-run constant, or an abort listener per agent on the run's signal. Skipped for
 * a build that cannot release (`--no-release`), where every agent keeps its session by design.
 */
export function assertIdleInvariants(report: IdleInvariantReport): void {
	if (!report.options.expectRelease) return;
	const { idle, baselineResources, options } = report;
	const violations: string[] = [];
	if (idle.liveSessions !== 0) violations.push(`${idle.liveSessions} sessions still live while every agent idles`);
	if (idle.sessionsRetained !== 0) {
		violations.push(`${idle.sessionsRetained} disposed sessions were not garbage collected`);
	}
	if (idle.abortListenersPerRun.max > ABORT_LISTENERS_PER_RUN_MAX) {
		violations.push(
			`${idle.abortListenersPerRun.max} abort listeners on one run (limit ${ABORT_LISTENERS_PER_RUN_MAX}) for ${options.agents} agents`,
		);
	}
	const allowedGrowth = IDLE_RESOURCE_GROWTH_PER_RUN * Math.ceil(options.agents / options.wave);
	for (const [kind, count] of Object.entries(idle.resources)) {
		if (TRANSIENT_RESOURCE_KINDS.has(kind)) continue;
		const growth = count - (baselineResources[kind] ?? 0);
		if (growth > allowedGrowth) {
			violations.push(
				`${kind} handles grew by ${growth} over the baseline (limit ${allowedGrowth}) for ${options.agents} agents`,
			);
		}
	}
	if (violations.length > 0) throw new Error(`idle invariants violated:\n  ${violations.join("\n  ")}`);
}

export async function runIdleAgentBenchmark(options: Options): Promise<IdleInvariantReport & Record<string, unknown>> {
	// The scripted model simulates a provider's prompt cache by keeping every session's last prompt in this process;
	// a real provider keeps it on its own servers, so it is left out of what an idle agent costs here.
	process.env.PI_CACHE_RETENTION = "none";
	const cwd = mkdtempSync(join(tmpdir(), "atomic-waiting-stages-"));
	const agentDir = join(cwd, "agent");
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	const respond = (context: {
		readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
	}) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(COMPLETION_TEXT);
		const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
		const text = JSON.stringify(lastUser?.content ?? "");
		const tool = text.includes(WAIT_MARKER)
			? fauxToolCall("wait_for_ci", {})
			: fauxToolCall("run_command", { command: "cargo test --workspace" });
		return fauxAssistantMessage([fauxText(COMPLETION_TEXT), tool], { stopReason: "toolUse" });
	};

	/** The fake CI service: one pending answer per waiting agent, settled only in the wake phase. */
	const ciAnswers = new Map<string, { readonly wave: number; readonly answer: () => void }>();
	let ciCalls = 0;
	let currentWave = 0;
	const runCommand: ToolDefinition = {
		name: "run_command",
		label: "Run command",
		description: "Run a shell command.",
		parameters: Type.Object({ command: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: TOOL_RESULT_TEXT }], details: undefined }),
	};
	const waitForCi: ToolDefinition = {
		name: "wait_for_ci",
		label: "Wait for CI",
		description: "Wait for the CI run of the change.",
		parameters: Type.Object({}),
		detachable: true,
		execute: (toolCallId) => {
			ciCalls += 1;
			const wave = currentWave;
			return new Promise<AgentToolResult>((resolveAnswer) => {
				ciAnswers.set(toolCallId, {
					wave,
					answer: () => resolveAnswer({ content: [{ type: "text", text: TOOL_RESULT_TEXT }], details: undefined }),
				});
			});
		},
	};

	const sessionStore: SessionStore =
		options.store === "memory"
			? new MemorySessionStore()
			: await resolveSessionStore(cwd, { agentDir, settings: {} });
	const sdkAdapter = createAgentSessionAdapter({
		cwd,
		agentDir,
		model,
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		builtins: BUILTINS,
		tools: ["run_command", "wait_for_ci"],
	});
	let liveSessions = 0;
	let sessionsCreated = 0;
	let sessionsCollected = 0;
	const sessionFinalizer = new FinalizationRegistry<number>(() => {
		sessionsCollected += 1;
	});
	const runSignals = new Set<AbortSignal>();
	const waiting = new Map<string, number>();
	const rehydratedAt = new Map<string, number>();
	const definition = workflow({
		name: "idle-agents",
		description: "",
		inputs: { first: Type.Number(), count: Type.Number() },
		outputs: {},
		run: async (ctx) => {
			const first = ctx.inputs.first as number;
			const count = ctx.inputs.count as number;
			await Promise.all(
				Array.from({ length: count }, async (_, offset) => {
					const agent = first + offset;
					const stage = ctx.stage(`agent-${agent}`, { customTools: [runCommand, waitForCi] });
					await stage.prompt(userText(agent, 0));
					for (let turn = 1; turn < options.turns; turn++) await stage.sendUserMessage(userText(agent, turn));
					await stage.sendUserMessage(`${WAIT_MARKER} of agent-${agent}, then report back.`);
				}),
			);
			return {};
		},
	});
	const adapters = {
		sessionStore,
		agentSession: {
			async create(...args: Parameters<typeof sdkAdapter.create>) {
				const meta = args[1];
				if (meta?.signal !== undefined) runSignals.add(meta.signal);
				const created = await sdkAdapter.create(...args);
				const session = "session" in created ? created.session : created;
				liveSessions += 1;
				sessionsCreated += 1;
				sessionFinalizer.register(session, sessionsCreated);
				const dispose = session.dispose.bind(session);
				session.dispose = async () => {
					liveSessions -= 1;
					await dispose();
				};
				return created;
			},
		},
	};

	collect();
	const baseline = process.memoryUsage();
	const baselineResources = activeResources();
	const samples: {
		agents: number;
		rssBytes: number;
		heapBytes: number;
		seconds: number;
		resources: Record<string, number>;
	}[] = [
		{ agents: 0, rssBytes: baseline.rss, heapBytes: baseline.heapUsed, seconds: 0, resources: baselineResources },
	];
	const runs: {
		readonly first: number;
		readonly count: number;
		readonly store: ReturnType<typeof createStore>;
		readonly result: Promise<{ readonly status: string; readonly error?: string }>;
	}[] = [];
	const started = performance.now();
	let launched = 0;
	while (launched < options.agents) {
		const count = Math.min(options.wave, options.agents - launched);
		currentWave = runs.length;
		faux.appendResponses(Array.from({ length: count * (2 * options.turns + 1) }, () => respond));
		const callsBefore = ciCalls;
		const waitingBefore = waiting.size;
		const store = createStore();
		const result = run(
			definition,
			{ first: launched, count },
			{
				cwd,
				store,
				adapters,
				...(options.store === "memory" ? { journal: { memory: true } } : {}),
				releaseWhenWaiting: { afterMs: 0 },
				onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
					if (event.type === "stage_waiting") waiting.set(event.stageName, Date.now());
					else rehydratedAt.set(event.stageName, Date.now());
				},
			},
		);
		runs.push({ first: launched, count, store, result });
		let ended: { readonly status: string; readonly error?: string } | undefined;
		void result.then((settled) => {
			ended = settled;
		});
		const idleWave = (): boolean =>
			ciCalls - callsBefore === count && (!options.expectRelease || waiting.size - waitingBefore === count);
		while (!idleWave()) {
			if (ended !== undefined) throw new Error(`wave ${runs.length} ended early: ${ended.status} ${ended.error}`);
			await new Promise((resolveTick) => setTimeout(resolveTick, 25));
		}
		launched += count;
		await settle();
		const usage = process.memoryUsage();
		samples.push({
			agents: launched,
			rssBytes: usage.rss,
			heapBytes: usage.heapUsed,
			seconds: (performance.now() - started) / 1000,
			resources: activeResources(),
		});
		console.error(
			`${options.label}: ${launched} agents idle, rss ${(usage.rss / 2 ** 20).toFixed(1)} MiB, heap ${(usage.heapUsed / 2 ** 20).toFixed(1)} MiB, live sessions ${liveSessions}, ${((performance.now() - started) / 1000).toFixed(1)} s`,
		);
	}

	const idleLoop = eventLoopDelaySampler();
	await new Promise((resolveIdle) => setTimeout(resolveIdle, 2_000));
	const idleEventLoopDelay = idleLoop.stop();
	const listenersPerRun = [...runSignals].map((signal) => getEventListeners(signal, "abort").length);
	const heapTypes = await objectTypeCounts();
	await settle();
	const snapshotPath = process.env.ATOMIC_WAITING_STAGES_HEAP_SNAPSHOT;
	if (snapshotPath !== undefined) {
		const bun = (globalThis as { Bun?: { generateHeapSnapshot(format: "v8"): string } }).Bun;
		if (bun !== undefined) writeFileSync(snapshotPath, bun.generateHeapSnapshot("v8"));
		else (await import("node:v8")).writeHeapSnapshot(snapshotPath);
	}
	const idle = {
		liveSessions,
		/** Disposed sessions something still references: an idle agent should keep none. */
		sessionsRetained: sessionsCreated - sessionsCollected - liveSessions,
		waitingStages: waiting.size,
		ciCallsPending: ciAnswers.size,
		abortListenersPerRun: summarize(listenersPerRun),
		resources: activeResources(),
		...(heapTypes === undefined ? {} : { topObjectTypes: heapTypes }),
	};

	let storedEntryBytes = 0;
	for (const wave of runs) {
		for (const stage of wave.store.runs()[0]?.stages ?? []) {
			if (stage.sessionId === undefined) continue;
			storedEntryBytes += JSON.stringify((await sessionStore.load(stage.sessionId)).entries).length;
		}
	}
	const storedFileBytes = options.store === "sqlite" ? directoryBytes(cwd) : undefined;

	const wakeLoop = eventLoopDelaySampler();
	const wakeLatencies: number[] = [];
	for (const [index, wave] of runs.entries()) {
		const wokenAt = Date.now();
		for (const [toolCallId, pending] of [...ciAnswers]) {
			if (pending.wave !== index) continue;
			ciAnswers.delete(toolCallId);
			pending.answer();
		}
		const result = await wave.result;
		if (result.status !== "completed")
			throw new Error(`wave starting at ${wave.first} ended ${result.status}: ${result.error}`);
		for (let offset = 0; offset < wave.count; offset++) {
			const at = rehydratedAt.get(`agent-${wave.first + offset}`);
			if (at !== undefined) wakeLatencies.push(at - wokenAt);
		}
	}
	const wakeEventLoopDelay = wakeLoop.stop();

	const points = samples.map((sample) => ({ agents: sample.agents, bytes: sample.rssBytes }));
	const heapPoints = samples.map((sample) => ({ agents: sample.agents, bytes: sample.heapBytes }));
	const last = samples.at(-1)!;
	const report = {
		label: options.label,
		runtime:
			(globalThis as { Bun?: { version: string } }).Bun === undefined
				? `node ${process.version}`
				: `bun ${(globalThis as { Bun?: { version: string } }).Bun!.version}`,
		options,
		samples: samples.map(({ agents, rssBytes, heapBytes, seconds }) => ({ agents, rssBytes, heapBytes, seconds })),
		rssKbPerAgent: slope(points) / 1024,
		heapKbPerAgent: slope(heapPoints) / 1024,
		rssDeltaKbPerAgent: (last.rssBytes - baseline.rss) / 1024 / options.agents,
		heapDeltaKbPerAgent: (last.heapBytes - baseline.heapUsed) / 1024 / options.agents,
		storedEntryBytesPerAgent: storedEntryBytes / options.agents,
		...(storedFileBytes === undefined ? {} : { storedFileBytesPerAgent: storedFileBytes / options.agents }),
		idle,
		baselineResources,
		idleEventLoopDelayMs: idleEventLoopDelay,
		wakeLatencyMs: summarize(wakeLatencies),
		wakeEventLoopDelayMs: wakeEventLoopDelay,
		woken: wakeLatencies.length,
		fakeLongToolCalls: ciCalls,
		modelRequests: faux.state.callCount,
	};
	await sessionStore.close();
	faux.unregister();
	rmSync(cwd, { recursive: true, force: true });
	return report;
}

if (import.meta.main) {
	const options = parseOptions(process.argv.slice(2));
	const report = await runIdleAgentBenchmark(options);
	const text = JSON.stringify(report, null, 2);
	try {
		assertIdleInvariants(report);
	} catch (error) {
		console.error(text);
		throw error;
	}
	if (options.out !== undefined) writeFileSync(options.out, `${text}\n`);
	console.log(text);
}
