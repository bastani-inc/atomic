import type { AgentPanelState } from "./agent-panel-source.js";
import type { Execution } from "./contracts.js";

export function taskClockRunning(state: Execution["kind"] | AgentPanelState): boolean {
	return state === "running" || state === "cancelling" || state === "stopping" || state === "input";
}

type ElapsedClock = { readonly since: number; frozen?: number };
type ClockReference = { readonly taskId: string; readonly reference: WeakRef<ElapsedClock> };

const seen = new Map<string, WeakRef<ElapsedClock>>();
const released = new FinalizationRegistry<ClockReference>(({ taskId, reference }) => {
	if (seen.get(taskId) === reference) seen.delete(taskId);
});

export function liveElapsedMs(
	taskId: string,
	reportedMs: number | undefined,
	running: boolean,
	now = Date.now(),
): number | undefined {
	let entry = seen.get(taskId)?.deref();
	if (!running) {
		if (entry === undefined) return reportedMs;
		entry.frozen ??= now - entry.since;
		return Math.max(reportedMs ?? 0, entry.frozen);
	}
	if (entry === undefined || entry.frozen !== undefined) {
		entry = { since: now - (reportedMs ?? 0) };
		const reference = new WeakRef(entry);
		seen.set(taskId, reference);
		released.register(entry, { taskId, reference });
	}
	return Math.max(reportedMs ?? 0, now - entry.since);
}

export class TaskElapsedClocks {
	private readonly retained = new Map<string, ElapsedClock>();

	elapsedMs(taskId: string, reportedMs: number | undefined, running: boolean, now = Date.now()): number | undefined {
		const elapsedMs = liveElapsedMs(taskId, reportedMs, running, now);
		const clock = seen.get(taskId)?.deref();
		if (clock !== undefined) this.retained.set(taskId, clock);
		return elapsedMs;
	}

	delete(taskId: string): void {
		this.retained.delete(taskId);
	}

	prune(taskIds: ReadonlySet<string>): void {
		for (const id of this.retained.keys()) if (!taskIds.has(id)) this.retained.delete(id);
	}

	clear(): void {
		this.retained.clear();
	}
}
