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
	/** Active handles by kind (`Timeout`, `TCPSocketWrap`, `PipeWrap`, `ProcessWrap`, ...). */
	readonly handles: Readonly<Record<string, number>>;
	/** Subscriptions on the event bus every session shares; extension listeners of a live session are among them. */
	readonly listeners: number;
}

/** Least-squares slope of `y` over `x`, or 0 with fewer than two distinct `x` values. */
export function leastSquaresSlope(points: readonly { readonly x: number; readonly y: number }[]): number {
	const count = points.length;
	if (count < 2) return 0;
	const meanX = points.reduce((sum, point) => sum + point.x, 0) / count;
	const meanY = points.reduce((sum, point) => sum + point.y, 0) / count;
	let numerator = 0;
	let denominator = 0;
	for (const point of points) {
		numerator += (point.x - meanX) * (point.y - meanY);
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
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1] ?? 0;
}

/** Count `process.getActiveResourcesInfo()` entries by kind. */
export function countHandles(resources: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const resource of resources) counts[resource] = (counts[resource] ?? 0) + 1;
	return counts;
}

/** Handle kinds that stand for a timer, a socket or a child process. */
export const AGENT_HANDLE_KINDS = {
	timers: ["Timeout", "Immediate"],
	sockets: ["TCPSocketWrap", "PipeWrap", "TCPServerWrap", "PipeServerWrap", "TLSWrap", "UDPWrap"],
	processes: ["ProcessWrap"],
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
