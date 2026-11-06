/**
 * Pure helpers of the idle-agents benchmark: the KB-per-agent slope of a series of samples, latency percentiles,
 * handle counts by kind, and the Markdown line a run reports. Kept free of I/O so `test/unit` checks them directly.
 */

/** One sample taken after a wave went idle. */
export interface IdleAgentSample {
	readonly agents: number;
	readonly rssBytes: number;
	readonly heapUsedBytes: number;
	/** Memory held in ArrayBuffers outside the JS heap, such as the in-memory store's UTF-8 history. */
	readonly arrayBuffersBytes: number;
	/** Live async resources by type (`Timeout`, `TCPWRAP`, `PIPEWRAP`, `PROCESSWRAP`, ...), counted with `async_hooks`. */
	readonly handles: Readonly<Record<string, number>>;
	/** Subscriptions on the event bus every session shares; extension listeners of a live session are among them. */
	readonly listeners: number;
	/** Entries in every per-agent registry the host keeps, by name; the subagent path reports them. */
	readonly registries?: Readonly<Record<string, number>>;
}

/**
 * Least-squares slope of `y` over `x`: Σ(x − x̄)·y / Σ(x − x̄)², or 0 with fewer than two distinct `x` values. (The
 * mean of `y` drops out, since Σ(x − x̄) is 0.)
 */
export function leastSquaresSlope(points: readonly { readonly x: number; readonly y: number }[]): number {
	const meanX = points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length);
	let numerator = 0;
	let denominator = 0;
	for (const point of points) {
		numerator += (point.x - meanX) * point.y;
		denominator += (point.x - meanX) ** 2;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * KB per idle agent, fitted over every sample: RSS, JS heap, and heap plus ArrayBuffers (what the process holds for an
 * agent in memory, wherever the engine keeps it).
 */
export function perAgentKb(samples: readonly IdleAgentSample[]): {
	readonly rssKb: number;
	readonly heapKb: number;
	readonly heapAndBuffersKb: number;
} {
	const kb = (select: (sample: IdleAgentSample) => number) =>
		leastSquaresSlope(samples.map((sample) => ({ x: sample.agents, y: select(sample) }))) / 1024;
	return {
		rssKb: kb((sample) => sample.rssBytes),
		heapKb: kb((sample) => sample.heapUsedBytes),
		heapAndBuffersKb: kb((sample) => sample.heapUsedBytes + sample.arrayBuffersBytes),
	};
}

/** The `p`th percentile (0-100) by nearest rank, or 0 for no values. */
export function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1] ?? 0;
}

/** Async resource types that stand for a timer, a socket or a child process. */
export const AGENT_HANDLE_KINDS = {
	timers: ["Timeout"],
	sockets: ["TCPWRAP", "PIPEWRAP", "TCPSERVERWRAP", "TLSWRAP", "UDPWRAP"],
	processes: ["PROCESSWRAP"],
} as const;

/** Timers, sockets and processes in a handle count. */
export function handleTotals(handles: Readonly<Record<string, number>>): {
	readonly timers: number;
	readonly sockets: number;
	readonly processes: number;
} {
	const sum = (kinds: readonly string[]) => kinds.reduce((total, kind) => total + (handles[kind] ?? 0), 0);
	return {
		timers: sum(AGENT_HANDLE_KINDS.timers),
		sockets: sum(AGENT_HANDLE_KINDS.sockets),
		processes: sum(AGENT_HANDLE_KINDS.processes),
	};
}

/**
 * Handles each idle agent adds: the slope of each kind over the samples. Zero means no agent keeps a timer,
 * socket or process while idle, however many there are.
 */
export function perAgentHandles(samples: readonly IdleAgentSample[]): {
	readonly timers: number;
	readonly sockets: number;
	readonly processes: number;
} {
	const slope = (kind: "timers" | "sockets" | "processes") =>
		leastSquaresSlope(samples.map((sample) => ({ x: sample.agents, y: handleTotals(sample.handles)[kind] })));
	return { timers: slope("timers"), sockets: slope("sockets"), processes: slope("processes") };
}

/**
 * Entries each idle agent adds to every registry: the slope of each over the samples, only for those that grow. An
 * agent that costs nothing in a registry does not appear.
 */
export function perAgentRegistries(samples: readonly IdleAgentSample[]): Record<string, number> {
	const names = new Set(samples.flatMap((sample) => Object.keys(sample.registries ?? {})));
	const slopes: Record<string, number> = {};
	for (const name of names) {
		const slope = leastSquaresSlope(
			samples.map((sample) => ({ x: sample.agents, y: sample.registries?.[name] ?? 0 })),
		);
		if (Math.abs(slope) > 1e-6) slopes[name] = slope;
	}
	return slopes;
}

/** Event-bus subscriptions each idle agent adds: the slope over the samples. */
export function perAgentListeners(samples: readonly IdleAgentSample[]): number {
	return leastSquaresSlope(samples.map((sample) => ({ x: sample.agents, y: sample.listeners })));
}

/** The result of one benchmark run, as its JSON report holds it. */
export interface IdleAgentsReport {
	readonly label: string;
	readonly store: "memory" | "sqlite";
	readonly mode: "release" | "resident";
	readonly agents: number;
	readonly turns: number;
	readonly wave: number;
	readonly storedBytesPerAgent: number;
	readonly samples: readonly IdleAgentSample[];
	readonly wakeLatencyMs: readonly number[];
	readonly eventLoopDelayP99Ms: number;
	readonly eventLoopDelayMaxMs: number;
	readonly elapsedMs: number;
}

/** One Markdown table row: label, store, mode, agents, KB/agent RSS and heap, stored KB, handles, wake p50/p99, lag. */
export function reportRow(report: IdleAgentsReport): string {
	const { rssKb, heapAndBuffersKb } = perAgentKb(report.samples);
	const handles = perAgentHandles(report.samples);
	const fixed = (value: number, digits = 1) => value.toFixed(digits);
	return `| ${report.label} | ${report.store} | ${report.mode} | ${report.agents} | ${fixed(rssKb)} | ${fixed(heapAndBuffersKb)} | ${fixed(report.storedBytesPerAgent / 1024)} | ${fixed(handles.timers, 3)} / ${fixed(handles.sockets, 3)} / ${fixed(handles.processes, 3)} / ${fixed(perAgentListeners(report.samples), 3)} | ${fixed(percentile(report.wakeLatencyMs, 50))} / ${fixed(percentile(report.wakeLatencyMs, 99))} | ${fixed(report.eventLoopDelayP99Ms)} / ${fixed(report.eventLoopDelayMaxMs)} |`;
}

/** The header of the table {@link reportRow} fills. */
export const REPORT_HEADER = [
	"| run | store | mode | agents | RSS KB/agent | heap + buffers KB/agent | stored KB/agent | timers / sockets / processes / listeners per agent | wake p50 / p99 ms | event-loop delay p99 / max ms |",
	"| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |",
].join("\n");
