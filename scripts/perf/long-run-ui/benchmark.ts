#!/usr/bin/env bun
/**
 * Long-run interactive UI benchmark (#4642): how the engine's memory, live sessions, frame time and keystroke latency
 * change as workflow runs finish more and more stages.
 *
 * Spawns `engine.ts`, the engine-side workflow surfaces behind the production stdin path, and plays the host over
 * real pipes as `RemoteComponent` does: invalidations mark the progress widget and the graph overlay dirty, one host
 * render pass every 16 ms requests their frames, and every key is sent as `engine_custom_input` followed at once by
 * the overlay's and the widget's `engine_custom_render`. Key latency runs from a key's scheduled time to the overlay
 * frame that answers it.
 *
 * The engine runs `--runs` concurrent workflow runs of `--lanes` sequential stage lanes each, every stage a real
 * `AgentSession` over a scripted model. At each checkpoint (`--checkpoints`, counts of finished stages) the lanes stop
 * starting stages and the driver:
 * 1. reopens `--reopen` finished stages, cycling through attach-then-detach, attach-then-hide, message and Intercom ask;
 * 2. samples heap, RSS, live sessions, registry entries and active handles after a full collection;
 * 3. measures an idle window and a busy window (reopened stages answering asks while keys arrive) of `--keys` keys,
 *    each `--windows` times (default 5), and reports the median of every statistic, since one window on a shared host
 *    varies by more than the frames it measures;
 * 4. measures `--churn-windows` churn windows (default 5): `--churn-keys` keys (default 60), one every
 *    `--churn-key-interval-ms` (default 8, so they land while stages start rather than after) arrive while the lanes
 *    start and finish `--churn` stages (default one per lane, and at least six, so a window sees several stages
 *    start whatever the lane count), after a full collection, and the median of every
 *    statistic is reported. The first checkpoint has one more churn window first, discarded as warm-up. Each churn
 *    window adds its stages, so the table reports the finished stages the checkpoint's churn windows ran from and to;
 * 5. writes a CPU profile of each window and a heap snapshot when `--profile-dir` is given.
 *
 * After the runs end, `store-change-cost.ts` measures in a process of its own the CPU time one store change costs the
 * engine's workflow surfaces at the first and the last checkpoint's finished-stage counts, without sessions: what a
 * churn window's key latency adds to the cost of starting a stage.
 *
 * Before the measured runs start, a throwaway run finishes `--warmup-stages` stages (default 10 per lane) and the store
 * drops it, so the 10-stage baseline is measured with the code that starts and finishes stages already warm.
 *
 * Transcripts and the run journal live in SQLite files in a temporary directory (`--store sqlite`, the default) or in
 * memory (`--store memory`); the engine runs with its own temporary agent directory and never opens the user's.
 *
 *   bun run scripts/perf/long-run-ui/benchmark.ts --runs 2 --lanes 1 --label after --out /tmp/long-run-after.json
 *
 * `--result-bytes` sets the size of the text every stage ends with (default 1,100): the heap a finished stage may add
 * is a fixed part plus that text kept once, so a larger result checks that it is not kept more often than that.
 *
 * `--assert` fails the run unless the criteria of `criteria.ts` hold. The first checkpoint is measured after a discarded
 * warm-up window and is the baseline: frame time and key latency, as the median from 200 finished stages on and as the median of the largest half of those checkpoints, stay within 20% of it
 * (plus a small timer-noise floor); churn key latency p50 and p95 and the store-change cost at the last checkpoint stay
 * within 20% of it with no noise floor; no session or registry entry is left open, and heap grows by an index-sized
 * amount per finished stage.
 *
 * The default viewport is 12 rows, so that the 10-stage baseline already fills it: a graph draws only the rows in view,
 * and a baseline that leaves the viewport half empty is cheaper than any later checkpoint by construction.
 *
 * Take frame and key numbers from a run without `--profile-dir`: the profiler and the heap snapshots slow the frames
 * that follow them.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type InteractiveEngineCommand,
	serializeInteractiveEngineFrame,
} from "../../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { attachJsonlLineReader } from "../../../packages/coding-agent/src/modes/rpc/jsonl.js";
import { evaluateCriteria, pairedCostRatio } from "./criteria.js";
import type { BenchControl, EngineConfig, EngineSample, RenderTimes, ReopenPath } from "./engine.js";
import type { StoreChangeCost, StoreChangeCostOptions } from "./store-change-cost.js";

interface Options {
	readonly label: string;
	readonly runs: number;
	readonly lanes: number;
	readonly checkpoints: readonly number[];
	readonly reopen: number;
	readonly keys: number;
	readonly keyIntervalMs: number;
	readonly probes: number;
	/** Stages the lanes may start while keys arrive in each churn window. */
	readonly churn: number;
	/** Measured churn windows per checkpoint; their median is reported. */
	readonly churnWindows: number;
	/** Keys sent in each churn window, and the milliseconds between them: dense, so they land while stages start. */
	readonly churnKeys: number;
	readonly churnKeyIntervalMs: number;
	/** Stages a throwaway run finishes before the measured runs start. */
	readonly warmupStages: number;
	readonly toolDelayMs: number;
	readonly resultBytes: number;
	readonly store: "sqlite" | "memory";
	readonly width: number;
	readonly rows: number;
	readonly profileDir?: string;
	readonly out?: string;
	/** Fail when the criteria of `criteria.ts` do not hold. */
	readonly assert: boolean;
	readonly windows: number;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const count = (name: string, fallback: number): number => {
		const raw = value(name);
		const parsed = raw === undefined ? fallback : Number(raw);
		if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a whole number, got ${raw}`);
		return parsed;
	};
	const checkpoints = (value("checkpoints") ?? "10,50,100,200,400,600")
		.split(",")
		.map(Number)
		.sort((left, right) => left - right);
	if (checkpoints.some((checkpoint) => !Number.isInteger(checkpoint) || checkpoint < 1))
		throw new Error("--checkpoints must be positive whole numbers");
	const profileDir = value("profile-dir");
	const out = value("out");
	const store = value("store") ?? "sqlite";
	if (store !== "sqlite" && store !== "memory") throw new Error(`--store must be sqlite or memory, got ${store}`);
	const runs = Math.max(1, count("runs", 2));
	const lanes = Math.max(1, count("lanes", 3));
	return {
		label: value("label") ?? "run",
		runs,
		lanes,
		checkpoints,
		reopen: count("reopen", 8),
		keys: count("keys", 60),
		keyIntervalMs: count("key-interval-ms", 33),
		probes: count("probes", 3),
		churn: Math.max(1, count("churn", Math.max(MIN_CHURN_STAGES, runs * lanes))),
		churnWindows: Math.max(1, count("churn-windows", 5)),
		churnKeys: Math.max(1, count("churn-keys", 60)),
		churnKeyIntervalMs: Math.max(1, count("churn-key-interval-ms", 8)),
		warmupStages: count("warmup-stages", 10 * runs * lanes),
		toolDelayMs: count("tool-delay-ms", 5),
		resultBytes: Math.max(1, count("result-bytes", 1_100)),
		store,
		width: count("width", 120),
		rows: count("rows", 12),
		...(profileDir === undefined ? {} : { profileDir }),
		...(out === undefined ? {} : { out }),
		assert: argv.includes("--assert"),
		windows: Math.max(1, count("windows", 5)),
	};
}

const HOST_FRAME_MS = 16;
/** Stages a churn window starts at least: with fewer, its slowest keys depend on one or two stage starts. */
const MIN_CHURN_STAGES = 6;
const REOPEN_PATHS: readonly ReopenPath[] = ["attach", "message", "ask", "hidden"];
const GRAPH_KEYS = ["\x1b[B", "\x1b[B", "\x1b[A", "\x1b[A"];
const ENGINE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "engine.ts");

interface EngineLine {
	readonly type: string;
	readonly componentId?: string;
	readonly requestId?: number;
	readonly overlay?: boolean;
	readonly widgetKey?: string;
	readonly finished?: number;
	readonly sample?: EngineSample;
	readonly renderTimes?: RenderTimes;
	readonly loopLagMs?: readonly number[];
	readonly results?: readonly { readonly status: string; readonly error?: string }[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function stats(values: readonly number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
	const round = (value: number) => Number(value.toFixed(3));
	return {
		n: values.length,
		p50: round(percentile(values, 50)),
		p95: round(percentile(values, 95)),
		p99: round(percentile(values, 99)),
		max: values.length === 0 ? Number.NaN : round(Math.max(...values)),
	};
}

class SimulatedHost {
	private readonly child: ChildProcessByStdio<Writable, Readable, null>;
	private readonly waiters: { match: (line: EngineLine) => boolean; resolve: (line: EngineLine) => void }[] = [];
	private readonly dirty = new Set<string>();
	private readonly sentAt = new Map<number, { componentId: string; at: number }>();
	private readonly pendingKeys = new Map<number, number>();
	private frameTimer: ReturnType<typeof setTimeout> | undefined;
	private nextRequestId = 0;
	private closed = false;
	private readonly cleanupAgentDir: () => void;
	widgetId: string | undefined;
	overlayId: string | undefined;
	readonly roundTrips = { widget: [] as number[], pane: [] as number[] };
	readonly keyLatencies: number[] = [];

	constructor(
		config: EngineConfig,
		private readonly options: Options,
	) {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-long-run-ui-agent-"));
		this.cleanupAgentDir = () => rmSync(agentDir, { recursive: true, force: true });
		this.child = spawn(process.execPath, [ENGINE_SCRIPT, JSON.stringify(config)], {
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		});
		attachJsonlLineReader(this.child.stdout, (line) => this.receive(JSON.parse(line) as EngineLine));
		this.child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (!this.closed || error.code !== "EPIPE") throw error;
		});
	}

	waitFor(match: (line: EngineLine) => boolean): Promise<EngineLine> {
		return new Promise((resolve) => this.waiters.push({ match, resolve }));
	}

	async request(message: BenchControl, reply: string): Promise<EngineLine> {
		const answered = this.waitFor((line) => line.type === reply);
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
		return answered;
	}

	control(message: BenchControl): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	resetWindow(): void {
		this.roundTrips.widget.length = 0;
		this.roundTrips.pane.length = 0;
		this.keyLatencies.length = 0;
	}

	sendKey(data: string, scheduledAt: number): void {
		const componentId = this.overlayId;
		if (componentId === undefined) throw new Error("the graph overlay is not open");
		// A timer that fired early sends the key before its time; it was pressed when it was sent.
		const pressedAt = Math.min(scheduledAt, performance.now());
		this.send({ type: "engine_custom_input", componentId, requestId: ++this.nextRequestId, data });
		this.pendingKeys.set(this.requestRender(componentId), pressedAt);
		// The host repaints the whole screen for a key, the progress widget included.
		if (this.widgetId !== undefined) this.requestRender(this.widgetId);
	}

	pendingKeyCount(): number {
		return this.pendingKeys.size;
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.frameTimer !== undefined) clearTimeout(this.frameTimer);
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.stdin.end();
		const killer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
		await exited;
		clearTimeout(killer);
		this.cleanupAgentDir();
	}

	private requestRender(componentId: string): number {
		const requestId = ++this.nextRequestId;
		this.sentAt.set(requestId, { componentId, at: performance.now() });
		this.send({
			type: "engine_custom_render",
			componentId,
			requestId,
			width: this.options.width,
			rows: this.options.rows,
		});
		return requestId;
	}

	private send(command: InteractiveEngineCommand): void {
		if (this.closed) return;
		this.child.stdin.write(serializeInteractiveEngineFrame(command));
	}

	private markDirty(componentId: string): void {
		if (this.closed) return;
		this.dirty.add(componentId);
		this.frameTimer ??= setTimeout(() => this.hostFrame(), HOST_FRAME_MS);
	}

	private hostFrame(): void {
		this.frameTimer = undefined;
		const ids = [...this.dirty];
		this.dirty.clear();
		for (const componentId of ids) this.requestRender(componentId);
	}

	private receive(line: EngineLine): void {
		switch (line.type) {
			case "engine_custom_open":
				if (line.componentId !== undefined && line.overlay === true) this.overlayId = line.componentId;
				else if (line.componentId !== undefined && line.widgetKey !== undefined) this.widgetId = line.componentId;
				if (line.componentId !== undefined) this.markDirty(line.componentId);
				break;
			case "engine_custom_invalidate":
				if (line.componentId !== undefined) this.markDirty(line.componentId);
				break;
			case "engine_custom_frame": {
				const now = performance.now();
				const sent = line.requestId === undefined ? undefined : this.sentAt.get(line.requestId);
				if (sent !== undefined && line.requestId !== undefined) {
					this.sentAt.delete(line.requestId);
					if (sent.componentId === this.widgetId) this.roundTrips.widget.push(now - sent.at);
					else if (sent.componentId === this.overlayId) this.roundTrips.pane.push(now - sent.at);
				}
				if (line.componentId === this.overlayId && line.requestId !== undefined) {
					for (const [keyRequestId, scheduledAt] of this.pendingKeys) {
						if (keyRequestId > line.requestId) continue;
						this.keyLatencies.push(now - scheduledAt);
						this.pendingKeys.delete(keyRequestId);
					}
				}
				break;
			}
		}
		for (let index = this.waiters.length - 1; index >= 0; index--) {
			const waiter = this.waiters[index];
			if (waiter?.match(line)) {
				this.waiters.splice(index, 1);
				waiter.resolve(line);
			}
		}
	}
}

type Stats = ReturnType<typeof stats>;

function medianOf(values: readonly number[]): number {
	return percentile(values, 50);
}

function medianStats(all: readonly Stats[]): Stats {
	const field = (read: (stat: Stats) => number): number => Number(medianOf(all.map(read)).toFixed(3));
	return {
		n: all.reduce((total, stat) => total + stat.n, 0),
		p50: field((stat) => stat.p50),
		p95: field((stat) => stat.p95),
		p99: field((stat) => stat.p99),
		max: field((stat) => stat.max),
	};
}

/** The windows of one checkpoint as one: every statistic is the median of that statistic across them. */
function medianWindow(all: readonly WindowResult[]): WindowResult {
	const pick = (read: (window: WindowResult) => Stats): Stats => medianStats(all.map(read));
	return {
		engineRenderMs: {
			widget: pick((window) => window.engineRenderMs.widget),
			pane: pick((window) => window.engineRenderMs.pane),
		},
		roundTripMs: {
			widget: pick((window) => window.roundTripMs.widget),
			pane: pick((window) => window.roundTripMs.pane),
		},
		keyLatencyMs: pick((window) => window.keyLatencyMs),
		keysUnanswered: Math.max(...all.map((window) => window.keysUnanswered)),
		engineLoopLagMs: pick((window) => window.engineLoopLagMs),
	};
}

interface WindowResult {
	readonly engineRenderMs: { readonly widget: ReturnType<typeof stats>; readonly pane: ReturnType<typeof stats> };
	readonly roundTripMs: { readonly widget: ReturnType<typeof stats>; readonly pane: ReturnType<typeof stats> };
	readonly keyLatencyMs: ReturnType<typeof stats>;
	readonly keysUnanswered: number;
	readonly engineLoopLagMs: ReturnType<typeof stats>;
}

async function measureWindow(host: SimulatedHost, options: Options, probes: number, profile?: string) {
	host.resetWindow();
	await host.request({ type: "bench_window_start", probes, ...(profile ? { profile } : {}) }, "bench_window_started");
	const startedAt = performance.now();
	for (let index = 0; index < options.keys; index++) {
		const scheduledAt = startedAt + index * options.keyIntervalMs;
		const wait = scheduledAt - performance.now();
		if (wait > 0) await sleep(wait);
		host.sendKey(GRAPH_KEYS[index % GRAPH_KEYS.length]!, scheduledAt);
	}
	const deadline = performance.now() + 10_000;
	while (host.pendingKeyCount() > 0 && performance.now() < deadline) await sleep(5);
	const ended = await host.request({ type: "bench_window_end" }, "bench_window_result");
	const times = ended.renderTimes ?? { widget: [], pane: [] };
	const result: WindowResult = {
		engineRenderMs: { widget: stats(times.widget), pane: stats(times.pane) },
		roundTripMs: { widget: stats(host.roundTrips.widget), pane: stats(host.roundTrips.pane) },
		keyLatencyMs: stats(host.keyLatencies),
		keysUnanswered: host.pendingKeyCount(),
		engineLoopLagMs: stats(ended.loopLagMs ?? []),
	};
	return result;
}

/**
 * Keys arrive while the lanes keep starting and finishing stages, up to `options.churn` of them, after a full
 * collection, so a collection the previous window left pending does not land in this one. Resolves with the window
 * and the finished stages once the lanes are idle again.
 */
async function measureChurnWindow(
	host: SimulatedHost,
	options: Options,
	profile?: string,
): Promise<{ readonly window: WindowResult; readonly finished: number }> {
	await host.request({ type: "bench_collect" }, "bench_collected");
	const churned = host.waitFor((line) => line.type === "bench_churn_done");
	host.control({ type: "bench_churn_start", stages: options.churn });
	const window = await measureWindow(
		host,
		{ ...options, keys: options.churnKeys, keyIntervalMs: options.churnKeyIntervalMs },
		0,
		profile,
	);
	host.control({ type: "bench_churn_stop" });
	const done = await churned;
	return { window, finished: done.finished ?? Number.NaN };
}

const STORE_CHANGE_COST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "store-change-cost.ts");

/** Runs `store-change-cost.ts` in a process of its own and reads the costs it prints. */
function measureStoreChangeCost(options: StoreChangeCostOptions): Promise<StoreChangeCost[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [STORE_CHANGE_COST_SCRIPT, JSON.stringify(options)], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) reject(new Error(`store-change-cost.ts exited with ${code}`));
			else resolve(JSON.parse(output) as StoreChangeCost[]);
		});
	});
}

interface CheckpointResult {
	readonly finished: number;
	readonly reopened: number;
	readonly sample: EngineSample;
	readonly idle: WindowResult;
	readonly busy: WindowResult;
	/** Key latency while the lanes start and finish stages, the median of the checkpoint's churn windows. */
	readonly churn: WindowResult;
	/** Finished stages before the checkpoint's first measured churn window and after its last. */
	readonly churnFinished: { readonly from: number; readonly to: number };
}

/** Self time per function of a CPU profile, the costliest first. */
function summarizeProfile(
	path: string,
): { readonly function: string; readonly selfMs: number; readonly share: number }[] {
	const profile = JSON.parse(readFileSync(path, "utf8")) as {
		nodes: {
			id: number;
			callFrame: { functionName: string; url: string; lineNumber: number };
		}[];
		samples: number[];
		timeDeltas: number[];
	};
	const byNode = new Map(profile.nodes.map((node) => [node.id, node]));
	const self = new Map<string, number>();
	let total = 0;
	profile.samples.forEach((id, index) => {
		const node = byNode.get(id);
		const delta = (profile.timeDeltas[index] ?? 0) / 1000;
		total += delta;
		if (node === undefined) return;
		const frame = node.callFrame;
		const file = frame.url.split("/packages/").at(-1) ?? frame.url;
		const key = `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}`;
		self.set(key, (self.get(key) ?? 0) + delta);
	});
	return [...self]
		.sort((left, right) => right[1] - left[1])
		.slice(0, 15)
		.map(([name, ms]) => ({ function: name, selfMs: Number(ms.toFixed(1)), share: Number((ms / total).toFixed(3)) }));
}

/** Retained size by constructor name in a V8 heap snapshot, the largest first. */
function summarizeHeap(path: string): { readonly name: string; readonly count: number; readonly selfBytes: number }[] {
	const snapshot = JSON.parse(readFileSync(path, "utf8")) as {
		snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
		nodes: number[];
		strings: string[];
	};
	const fields = snapshot.snapshot.meta.node_fields;
	const typeNames = snapshot.snapshot.meta.node_types[0];
	const width = fields.length;
	const typeAt = fields.indexOf("type");
	const nameAt = fields.indexOf("name");
	const sizeAt = fields.indexOf("self_size");
	const totals = new Map<string, { count: number; selfBytes: number }>();
	for (let offset = 0; offset < snapshot.nodes.length; offset += width) {
		const type = typeNames[snapshot.nodes[offset + typeAt]!] ?? "unknown";
		const name =
			type === "object" || type === "closure" ? snapshot.strings[snapshot.nodes[offset + nameAt]!]! : `(${type})`;
		const entry = totals.get(name) ?? { count: 0, selfBytes: 0 };
		entry.count += 1;
		entry.selfBytes += snapshot.nodes[offset + sizeAt]!;
		totals.set(name, entry);
	}
	return [...totals]
		.sort((left, right) => right[1].selfBytes - left[1].selfBytes)
		.slice(0, 25)
		.map(([name, entry]) => ({ name, ...entry }));
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const stages =
		(options.checkpoints.at(-1) ?? 10) + 10 + options.churn * (options.checkpoints.length * options.churnWindows + 1);
	const config: EngineConfig = {
		runs: options.runs,
		lanes: options.lanes,
		stages,
		checkpoints: options.checkpoints,
		toolDelayMs: options.toolDelayMs,
		resultBytes: options.resultBytes,
		store: options.store,
		warmupStages: options.warmupStages,
	};
	if (options.profileDir !== undefined) mkdirSync(options.profileDir, { recursive: true });
	const host = new SimulatedHost(config, options);
	await host.waitFor((line) => line.type === "bench_ready");
	const done = host.waitFor((line) => line.type === "bench_done");
	host.control({ type: "bench_start" });
	const checkpoints: CheckpointResult[] = [];
	const profiles: Record<string, ReturnType<typeof summarizeProfile>> = {};
	const heaps: Record<string, ReturnType<typeof summarizeHeap>> = {};
	let reopenedTotal = 0;
	let pathCursor = 0;
	for (const checkpoint of options.checkpoints) {
		const reached = await host.waitFor((line) => line.type === "bench_checkpoint");
		if (host.overlayId === undefined) {
			const opened = host.waitFor((line) => line.type === "engine_custom_open" && line.overlay === true);
			host.control({ type: "bench_open_overlay" });
			await opened;
		}
		const paths = Array.from({ length: options.reopen }, () => REOPEN_PATHS[pathCursor++ % REOPEN_PATHS.length]!);
		await host.request({ type: "bench_reopen", paths }, "bench_reopen_done");
		reopenedTotal += paths.length;
		const sampled = await host.request({ type: "bench_sample" }, "bench_sample_result");
		const profile = (window: string) =>
			options.profileDir === undefined
				? undefined
				: join(options.profileDir, `${options.label}-${checkpoint}-${window}.cpuprofile`);
		// The first checkpoint is the baseline the later ones are compared with: let the code warm up, then measure.
		if (checkpoint === options.checkpoints[0]) await measureWindow(host, options, 0);
		const idleProfile = profile("idle");
		const idleWindows: WindowResult[] = [];
		for (let repeat = 0; repeat < options.windows; repeat++)
			idleWindows.push(await measureWindow(host, options, 0, repeat === 0 ? idleProfile : undefined));
		const idle = medianWindow(idleWindows);
		const busyProfile = profile("busy");
		const busyWindows: WindowResult[] = [];
		for (let repeat = 0; repeat < options.windows; repeat++)
			busyWindows.push(await measureWindow(host, options, options.probes, repeat === 0 ? busyProfile : undefined));
		const busy = medianWindow(busyWindows);
		let churnFrom = reached.finished ?? checkpoint;
		if (checkpoint === options.checkpoints[0]) churnFrom = (await measureChurnWindow(host, options)).finished;
		const churnProfile = profile("churn");
		const churnWindows: WindowResult[] = [];
		let churnTo = churnFrom;
		for (let repeat = 0; repeat < options.churnWindows; repeat++) {
			const measured = await measureChurnWindow(host, options, repeat === 0 ? churnProfile : undefined);
			churnWindows.push(measured.window);
			churnTo = measured.finished;
		}
		const churn = medianWindow(churnWindows);
		if (churnProfile !== undefined) profiles[`${checkpoint}-churn`] = summarizeProfile(churnProfile);
		if (idleProfile !== undefined) profiles[`${checkpoint}-idle`] = summarizeProfile(idleProfile);
		if (busyProfile !== undefined) profiles[`${checkpoint}-busy`] = summarizeProfile(busyProfile);
		if (options.profileDir !== undefined) {
			const heapPath = join(options.profileDir, `${options.label}-${checkpoint}.heapsnapshot`);
			await host.request({ type: "bench_heap_snapshot", path: heapPath }, "bench_heap_snapshot_done");
			heaps[checkpoint] = summarizeHeap(heapPath);
		}
		const result: CheckpointResult = {
			finished: reached.finished ?? checkpoint,
			reopened: reopenedTotal,
			sample: sampled.sample!,
			idle,
			busy,
			churn,
			churnFinished: { from: churnFrom, to: churnTo },
		};
		checkpoints.push(result);
		process.stderr.write(
			`${options.label} finished=${result.finished} reopened=${reopenedTotal} heap=${(result.sample.heapUsedBytes / 2 ** 20).toFixed(1)}MiB rss=${(result.sample.rssBytes / 2 ** 20).toFixed(1)}MiB live=${result.sample.liveSessions} registry=${result.sample.registryEntries} widget p50=${idle.engineRenderMs.widget.p50}ms pane p50=${idle.engineRenderMs.pane.p50}ms key p50=${busy.keyLatencyMs.p50}ms p95=${busy.keyLatencyMs.p95}ms\n`,
		);
		host.control({ type: "bench_continue" });
	}
	const ended = await done;
	const final = await host.request({ type: "bench_sample" }, "bench_sample_result");
	await host.close();
	const first = checkpoints[0];
	const last = checkpoints.at(-1);
	const storeChangeCost =
		first === undefined || last === undefined
			? []
			: await measureStoreChangeCost({
					runs: options.runs,
					lanes: options.lanes,
					finished: [...new Set([first.finished, last.finished])],
					resultBytes: options.resultBytes,
				});
	const criteria = evaluateCriteria(checkpoints, {
		resultBytes: options.resultBytes,
		heldStagesMax: options.runs * options.lanes,
		storeChangeCost,
	});
	const report = {
		label: options.label,
		runtime:
			(globalThis as { Bun?: { version: string } }).Bun === undefined
				? `node ${process.version}`
				: `bun ${(globalThis as { Bun?: { version: string } }).Bun!.version}`,
		options,
		checkpoints,
		storeChangeCost,
		criteria,
		afterRunsEnded: final.sample,
		runResults: ended.results,
		...(Object.keys(profiles).length === 0 ? {} : { cpuProfileSelfTime: profiles }),
		...(Object.keys(heaps).length === 0 ? {} : { heapByConstructor: heaps }),
	};
	const text = JSON.stringify(report, null, 2);
	if (options.out !== undefined) writeFileSync(options.out, `${text}\n`);
	process.stdout.write(`${table(report.label, checkpoints, storeChangeCost)}\n`);
	if (options.assert && !criteria.passed) {
		process.stderr.write(`${criteria.failures.map((failure) => `FAILED: ${failure}`).join("\n")}\n`);
		process.exitCode = 1;
	}
}

function table(label: string, rows: readonly CheckpointResult[], storeChangeCost: readonly StoreChangeCost[]): string {
	const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(1);
	const handles = (sample: EngineSample) =>
		Object.values(sample.activeResources).reduce((sum, count) => sum + count, 0);
	return [
		`### ${label}`,
		"",
		"| finished | reopened | heap MiB | RSS MiB | live sessions | registry | handles | widget render p50/p95 ms | pane render p50/p95 ms | key p50/p95 ms idle | key p50/p95 ms busy | key p50/p95 ms churn | churn finished |",
		`|${"---|".repeat(13)}`,
		...rows.map(
			(row) =>
				`| ${row.finished} | ${row.reopened} | ${mb(row.sample.heapUsedBytes)} | ${mb(row.sample.rssBytes)} | ${row.sample.liveSessions} | ${row.sample.registryEntries} | ${handles(row.sample)} | ${row.idle.engineRenderMs.widget.p50}/${row.idle.engineRenderMs.widget.p95} | ${row.idle.engineRenderMs.pane.p50}/${row.idle.engineRenderMs.pane.p95} | ${row.idle.keyLatencyMs.p50}/${row.idle.keyLatencyMs.p95} | ${row.busy.keyLatencyMs.p50}/${row.busy.keyLatencyMs.p95} | ${row.churn.keyLatencyMs.p50}/${row.churn.keyLatencyMs.p95} | ${row.churnFinished.from}–${row.churnFinished.to} |`,
		),
		"",
		"| finished | store change µs CPU | graph snapshot µs | activity publication µs | median ratio to the first, paired windows |",
		"|---|---|---|---|---|",
		...storeChangeCost.map((cost) => {
			const ratio = storeChangeCost[0] === undefined ? Number.NaN : pairedCostRatio(storeChangeCost[0], cost);
			return `| ${cost.finished} | ${cost.usPerChange} | ${cost.graphSnapshotUs} | ${cost.activityUs} | ${ratio.toFixed(3)} |`;
		}),
	].join("\n");
}

await main();
