// Summarizes one benchmark root result: checkpoint latency percentiles, aggregate throughput, per-host distribution.
export function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function summarize(result) {
	const done = result.outcomes.filter((outcome) => Array.isArray(outcome.latenciesMs));
	const latencies = done.flatMap((outcome) => outcome.latenciesMs).sort((a, b) => a - b);
	const first = Math.min(...done.map((outcome) => outcome.startedAt));
	const last = Math.max(...done.map((outcome) => outcome.endedAt));
	const perHost = {};
	for (const outcome of done) perHost[outcome.host] = (perHost[outcome.host] ?? 0) + 1;
	const failures = result.outcomes.filter((outcome) => !Array.isArray(outcome.latenciesMs));
	return {
		status: result.status,
		children: result.children,
		completed: done.length,
		failed: failures.length,
		failureSamples: failures.slice(0, 3).map((failure) => `${failure.name ?? failure.status}: ${String(failure.error).slice(0, 200)}`),
		checkpoints: latencies.length,
		wallMs: result.wallMs,
		activeMs: last - first,
		checkpointsPerSec: latencies.length === 0 ? 0 : Math.round((latencies.length / ((last - first) / 1000)) * 10) / 10,
		latencyMs: {
			p50: percentile(latencies, 50),
			p90: percentile(latencies, 90),
			p99: percentile(latencies, 99),
			max: latencies.at(-1) ?? null,
		},
		stageMs: (() => {
			const stages = done.map((outcome) => outcome.stageMs ?? 0).filter((value) => value > 0).sort((a, b) => a - b);
			return stages.length === 0 ? null : { p50: percentile(stages, 50), p90: percentile(stages, 90), max: stages.at(-1) };
		})(),
		perHost,
	};
}
