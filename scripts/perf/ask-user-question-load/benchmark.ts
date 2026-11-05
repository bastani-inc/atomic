#!/usr/bin/env bun
/**
 * Keystroke-to-frame latency of the ask_user_question dialog under synthetic background UI load (#4333).
 *
 * Each run spawns `engine.ts`, the real engine-side UI code behind the production stdin path, and plays the host
 * here over real pipes, following `RemoteComponent` and `RemoteRenderer`:
 * - every key is sent as `engine_custom_input` followed at once by the dialog's `engine_custom_render`, as
 *   `RemoteComponent.handleInput` and pi-tui's immediate keyboard render do;
 * - invalidations and streaming tool-card updates mark components dirty, and one host render pass every 16 ms
 *   sends their render requests, as the host TUI's throttled frame does;
 * - latency runs from a key's scheduled time to the arrival of the dialog frame that answers it, so a delayed
 *   key is charged for the delay.
 *
 * Keys are sent open-loop at a fixed rate, like a held key. The background load grows across levels:
 * `--levels 0,10,40` gives that many workflow widgets, plus one streaming tool card per `--widgets-per-card`.
 *
 *   bun run scripts/perf/ask-user-question-load/benchmark.ts --label after --out /tmp/aq-after.json
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type InteractiveEngineCommand,
	serializeInteractiveEngineFrame,
} from "../../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { attachJsonlLineReader } from "../../../packages/coding-agent/src/modes/rpc/jsonl.js";
import type { BenchControl, EngineCounters, EngineLoad } from "./engine.js";
import { KEY_CYCLE } from "./fixture.js";

interface Options {
	readonly label: string;
	readonly levels: readonly number[];
	readonly repeats: number;
	readonly keystrokes: number;
	readonly keyIntervalMs: number;
	readonly widgetHz: number;
	readonly widgetCostMs: number;
	readonly broadcastHz: number;
	readonly widgetsPerCard: number;
	readonly cardHz: number;
	readonly width: number;
	readonly rows: number;
	readonly warmupMs: number;
	readonly idleMs: number;
	readonly drainTimeoutMs: number;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const number = (name: string, fallback: number): number => Number(value(name) ?? fallback);
	return {
		label: value("label") ?? "run",
		levels: (value("levels") ?? "0,10,20,40,80,160,320").split(",").map(Number),
		repeats: number("repeats", 3),
		keystrokes: number("keystrokes", 120),
		keyIntervalMs: number("key-interval-ms", 33),
		widgetHz: number("widget-hz", 12),
		widgetCostMs: number("widget-cost-ms", 1),
		broadcastHz: number("broadcast-hz", 20),
		widgetsPerCard: number("widgets-per-card", 4),
		cardHz: number("card-hz", 10),
		width: number("width", 120),
		rows: number("rows", 40),
		warmupMs: number("warmup-ms", 1000),
		idleMs: number("idle-ms", 2000),
		drainTimeoutMs: number("drain-timeout-ms", 20_000),
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

const HOST_FRAME_MS = 16;
/** A run whose engine cannot answer a counter request this quickly has fallen behind; its counts are reported missing. */
const COUNTERS_TIMEOUT_MS = 10_000;
const CHILD_EXIT_GRACE_MS = 2000;
/** A streaming tool card shows the tail of its output, as the collapsed card does. */
const CARD_OUTPUT_LINES = 40;
const ENGINE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "engine.ts");

interface EngineLine {
	type: string;
	componentId?: string;
	requestId?: number;
	overlay?: boolean;
	widgetKey?: string;
	counters?: EngineCounters;
}

interface RunResult {
	readonly widgets: number;
	readonly toolCards: number;
	readonly latenciesMs: number[];
	readonly timedOut: number;
	readonly keys: EngineCounters | undefined;
	readonly idle: EngineCounters | undefined;
	readonly idleDialogInvalidations: number;
	readonly widgetFramesPerSecond: number;
	readonly toolFramesPerSecond: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? Number.NaN;
}

class SimulatedHost {
	private readonly child: ChildProcessByStdio<Writable, Readable, null>;
	private readonly options: Options;
	private readonly waiters: Array<{ match: (line: EngineLine) => boolean; resolve: (line: EngineLine) => void }> = [];
	private readonly dirty = new Set<string>();
	private readonly widgetIds = new Set<string>();
	private readonly cards: Array<{ componentId: string; output: string[]; lines: number }> = [];
	private readonly pendingKeys = new Map<number, number>();
	private frameTimer: ReturnType<typeof setTimeout> | undefined;
	private waitingForDrain = false;
	private closed = false;
	private cardTimer: ReturnType<typeof setInterval> | undefined;
	private nextRequestId = 0;
	dialogId: string | undefined;
	dialogInvalidations = 0;
	widgetFrames = 0;
	toolFrames = 0;
	readonly latenciesMs: number[] = [];

	constructor(load: EngineLoad, options: Options) {
		this.options = options;
		this.child = spawn(process.execPath, [ENGINE_SCRIPT, JSON.stringify(load)], {
			stdio: ["pipe", "pipe", "inherit"],
		});
		attachJsonlLineReader(this.child.stdout, (line) => this.receive(JSON.parse(line) as EngineLine));
		// A run is over once `close()` starts; an engine still draining a backlog may exit before the pipe empties.
		this.child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (!this.closed || error.code !== "EPIPE") throw error;
		});
	}

	waitFor(match: (line: EngineLine) => boolean): Promise<EngineLine> {
		return new Promise((resolve) => this.waiters.push({ match, resolve }));
	}

	control(control: BenchControl): void {
		this.child.stdin.write(`${JSON.stringify(control)}\n`);
	}

	/** The engine's render counts, or undefined when it is too far behind to answer within `COUNTERS_TIMEOUT_MS`. */
	async counters(): Promise<EngineCounters | undefined> {
		const reply = this.waitFor((line) => line.type === "bench_counters");
		this.control({ type: "bench_counters" });
		const timeout = sleep(COUNTERS_TIMEOUT_MS).then(() => undefined);
		return (await Promise.race([reply, timeout]))?.counters;
	}

	startToolCards(count: number): void {
		for (let index = 0; index < count; index++) {
			this.cards.push({ componentId: `bench_card_${index}`, output: [], lines: 0 });
			this.dirty.add(`bench_card_${index}`);
		}
		if (count === 0) return;
		this.cardTimer = setInterval(() => {
			for (const card of this.cards) {
				card.output.push(`subagent ${card.componentId} streamed line ${card.lines++}: reading files and reasoning`);
				if (card.output.length > CARD_OUTPUT_LINES) card.output.shift();
				this.markDirty(card.componentId);
			}
		}, 1000 / Math.max(1, this.options.cardHz));
	}

	/** Sends one key at its scheduled time; the latency clock starts at `scheduledAt`. */
	sendKey(data: string, scheduledAt: number): void {
		const componentId = this.dialogId;
		if (!componentId) throw new Error("dialog is not open");
		this.send({ type: "engine_custom_input", componentId, requestId: ++this.nextRequestId, data });
		const requestId = this.requestRender(componentId);
		this.pendingKeys.set(requestId, scheduledAt);
	}

	pendingKeyCount(): number {
		return this.pendingKeys.size;
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.frameTimer) clearTimeout(this.frameTimer);
		if (this.cardTimer) clearInterval(this.cardTimer);
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.stdin.end();
		const killer = setTimeout(() => this.child.kill("SIGKILL"), CHILD_EXIT_GRACE_MS);
		await exited;
		clearTimeout(killer);
	}

	requestRender(componentId: string): number {
		const requestId = ++this.nextRequestId;
		const card = this.cards.find((candidate) => candidate.componentId === componentId);
		if (card) {
			this.send({
				type: "engine_tool_render",
				componentId,
				requestId,
				width: this.options.width,
				toolName: "subagent",
				toolCallId: `call_${componentId}`,
				args: { task: "review the change" },
				result: { content: [{ type: "text", text: card.output.join("\n") }], isError: false },
				executionStarted: true,
				argsComplete: true,
				isPartial: true,
				expanded: false,
				showImages: false,
				imageWidthCells: 60,
			});
		} else {
			this.send({
				type: "engine_custom_render",
				componentId,
				requestId,
				width: this.options.width,
				rows: this.options.rows,
			});
		}
		return requestId;
	}

	private send(command: InteractiveEngineCommand): void {
		if (this.closed) return;
		this.child.stdin.write(serializeInteractiveEngineFrame(command));
	}

	private markDirty(componentId: string): void {
		if (this.closed) return;
		this.dirty.add(componentId);
		if (!this.waitingForDrain) this.frameTimer ??= setTimeout(() => this.hostFrame(), HOST_FRAME_MS);
	}

	/**
	 * One host render pass. While the pipe to the engine is full, dirty components stay dirty and the pass waits for
	 * it to drain, so a backed-up engine cannot make the host buffer render requests without bound. Keys are always
	 * sent at once.
	 */
	private hostFrame(): void {
		this.frameTimer = undefined;
		if (this.child.stdin.writableNeedDrain) {
			this.waitingForDrain = true;
			this.child.stdin.once("drain", () => {
				this.waitingForDrain = false;
				this.frameTimer ??= setTimeout(() => this.hostFrame(), HOST_FRAME_MS);
			});
			return;
		}
		const ids = [...this.dirty];
		this.dirty.clear();
		for (const componentId of ids) this.requestRender(componentId);
	}

	private receive(line: EngineLine): void {
		switch (line.type) {
			case "engine_custom_open":
				if (line.componentId && line.overlay) {
					this.dialogId = line.componentId;
				} else if (line.componentId && line.widgetKey) {
					this.widgetIds.add(line.componentId);
					this.markDirty(line.componentId);
				}
				break;
			case "engine_custom_invalidate":
				if (!line.componentId) break;
				if (line.componentId === this.dialogId) this.dialogInvalidations++;
				this.markDirty(line.componentId);
				break;
			case "engine_custom_frame":
				if (line.componentId === this.dialogId) this.resolveKeys(line.requestId ?? 0);
				else if (line.componentId && this.widgetIds.has(line.componentId)) this.widgetFrames++;
				else this.toolFrames++;
				break;
		}
		for (let index = this.waiters.length - 1; index >= 0; index--) {
			const waiter = this.waiters[index];
			if (waiter?.match(line)) {
				this.waiters.splice(index, 1);
				waiter.resolve(line);
			}
		}
	}

	private resolveKeys(requestId: number): void {
		const now = performance.now();
		for (const [keyRequestId, scheduledAt] of this.pendingKeys) {
			if (keyRequestId > requestId) continue;
			this.latenciesMs.push(now - scheduledAt);
			this.pendingKeys.delete(keyRequestId);
		}
	}
}

async function measure(widgets: number, options: Options): Promise<RunResult> {
	const toolCards = Math.floor(widgets / Math.max(1, options.widgetsPerCard));
	const host = new SimulatedHost(
		{ widgets, widgetHz: options.widgetHz, widgetCostMs: options.widgetCostMs, broadcastHz: options.broadcastHz },
		options,
	);
	await host.waitFor((line) => line.type === "bench_ready");
	const opened = host.waitFor((line) => line.type === "engine_custom_open" && line.overlay === true);
	host.control({ type: "bench_open_dialog" });
	const dialogId = (await opened).componentId ?? "";
	const firstFrame = host.waitFor((line) => line.type === "engine_custom_frame" && line.componentId === dialogId);
	host.requestRender(dialogId);
	await firstFrame;

	host.control({ type: "bench_start_load" });
	host.startToolCards(toolCards);
	await sleep(options.warmupMs);

	host.control({ type: "bench_reset_counters" });
	const idleInvalidationsBefore = host.dialogInvalidations;
	await sleep(options.idleMs);
	const idle = await host.counters();
	const idleDialogInvalidations = host.dialogInvalidations - idleInvalidationsBefore;

	host.control({ type: "bench_reset_counters" });
	const widgetFramesBefore = host.widgetFrames;
	const toolFramesBefore = host.toolFrames;
	const keysStartedAt = performance.now();
	for (let index = 0; index < options.keystrokes; index++) {
		const scheduledAt = keysStartedAt + index * options.keyIntervalMs;
		const wait = scheduledAt - performance.now();
		if (wait > 0) await sleep(wait);
		host.sendKey(KEY_CYCLE[index % KEY_CYCLE.length] ?? "\x1b[B", scheduledAt);
	}
	const drainDeadline = performance.now() + options.drainTimeoutMs;
	while (host.pendingKeyCount() > 0 && performance.now() < drainDeadline) await sleep(5);
	const keysSeconds = (performance.now() - keysStartedAt) / 1000;
	const keys = await host.counters();
	const result: RunResult = {
		widgets,
		toolCards,
		latenciesMs: [...host.latenciesMs],
		timedOut: host.pendingKeyCount(),
		keys,
		idle,
		idleDialogInvalidations,
		widgetFramesPerSecond: (host.widgetFrames - widgetFramesBefore) / keysSeconds,
		toolFramesPerSecond: (host.toolFrames - toolFramesBefore) / keysSeconds,
	};
	await host.close();
	return result;
}

interface LevelSummary {
	widgets: number;
	toolCards: number;
	samples: number;
	timedOut: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	p99PerRepeat: number[];
	dialogFramesPerKey: number;
	dialogRenderCallsPerKey: number;
	optionListRendersPerKey: number;
	markdownMissesPerKey: number;
	dialogFramesPerUnrelatedInvalidation: number;
	widgetFramesPerSecond: number;
	toolFramesPerSecond: number;
}

function summarize(runs: readonly RunResult[], options: Options): LevelSummary {
	const timedOut = runs.reduce((total, run) => total + run.timedOut, 0);
	// A key whose frame never arrived counts as slower than every key that was answered.
	const all = [
		...runs.flatMap((run) => run.latenciesMs).sort((a, b) => a - b),
		...Array<number>(timedOut).fill(Number.POSITIVE_INFINITY),
	];
	const keys = runs.length * options.keystrokes;
	const sum = (pick: (run: RunResult) => number) => runs.reduce((total, run) => total + pick(run), 0);
	const round = (value: number, digits = 1) => Number(value.toFixed(digits));
	const first = runs[0];
	return {
		widgets: first?.widgets ?? 0,
		toolCards: first?.toolCards ?? 0,
		samples: all.length,
		timedOut,
		p50: round(percentile(all, 50)),
		p95: round(percentile(all, 95)),
		p99: round(percentile(all, 99)),
		max: round(all.at(-1) ?? Number.NaN),
		p99PerRepeat: runs.map((run) =>
			round(
				percentile(
					[
						...run.latenciesMs.toSorted((a, b) => a - b),
						...Array<number>(run.timedOut).fill(Number.POSITIVE_INFINITY),
					],
					99,
				),
			),
		),
		dialogFramesPerKey: round(sum((run) => run.keys?.dialogFrames ?? Number.NaN) / keys, 2),
		dialogRenderCallsPerKey: round(sum((run) => run.keys?.dialogRenderCalls ?? Number.NaN) / keys, 2),
		optionListRendersPerKey: round(sum((run) => run.keys?.optionListRenders ?? Number.NaN) / keys, 2),
		markdownMissesPerKey: round(sum((run) => run.keys?.markdownMisses ?? Number.NaN) / keys, 2),
		dialogFramesPerUnrelatedInvalidation: round(
			sum((run) => run.idle?.dialogFrames ?? Number.NaN) /
				Math.max(
					1,
					sum((run) => run.idleDialogInvalidations),
				),
			2,
		),
		widgetFramesPerSecond: round(sum((run) => run.widgetFramesPerSecond) / runs.length),
		toolFramesPerSecond: round(sum((run) => run.toolFramesPerSecond) / runs.length),
	};
}

function table(label: string, summaries: readonly LevelSummary[]): string {
	const header =
		"| widgets | tool cards | p50 ms | p95 ms | p99 ms | max ms | p99 per repeat | timed out | frames/key | option-list renders/key | markdown misses/key | frames per unrelated invalidation | widget frames/s | tool frames/s |";
	const ms = (value: number) => (Number.isFinite(value) ? String(value) : "unanswered");
	const rows = summaries.map(
		(s) =>
			`| ${s.widgets} | ${s.toolCards} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} | ${s.p99PerRepeat.map(ms).join(", ")} | ${s.timedOut} | ${s.dialogFramesPerKey} | ${s.optionListRendersPerKey} | ${s.markdownMissesPerKey} | ${s.dialogFramesPerUnrelatedInvalidation} | ${s.widgetFramesPerSecond} | ${s.toolFramesPerSecond} |`,
	);
	return [`### ${label}`, "", header, `|${"---|".repeat(14)}`, ...rows].join("\n");
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const summaries: LevelSummary[] = [];
	for (const widgets of options.levels) {
		const runs: RunResult[] = [];
		for (let repeat = 0; repeat < options.repeats; repeat++) runs.push(await measure(widgets, options));
		const summary = summarize(runs, options);
		summaries.push(summary);
		process.stderr.write(`${options.label} widgets=${widgets} p99=${summary.p99}ms timedOut=${summary.timedOut}\n`);
	}
	const report = table(options.label, summaries);
	process.stdout.write(`${report}\n`);
	if (options.out)
		writeFileSync(options.out, `${JSON.stringify({ label: options.label, options, summaries }, null, 2)}\n`);
}

await main();
