import type { AgentPanelState } from "./agent-panel-source.js";
import type { Execution } from "./contracts.js";

export function taskClockRunning(state: Execution["kind"] | AgentPanelState): boolean {
	return state === "running" || state === "cancelling" || state === "stopping" || state === "input";
}

type ElapsedClock = { since: number; displayed: number; frozen?: number; settled?: boolean };
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
		entry.frozen = Math.max(entry.frozen ?? 0, reportedMs ?? 0, entry.displayed);
		return entry.frozen;
	}
	if (entry === undefined || entry.frozen !== undefined) {
		entry = { since: now - (reportedMs ?? 0), displayed: reportedMs ?? 0 };
		const reference = new WeakRef(entry);
		seen.set(taskId, reference);
		released.register(entry, { taskId, reference });
	}
	if (reportedMs !== undefined) entry.since = Math.min(entry.since, now - reportedMs);
	entry.displayed = Math.max(entry.displayed, reportedMs ?? 0, now - entry.since);
	return entry.displayed;
}

export class TaskElapsedClocks {
	private readonly retained = new Map<string, ElapsedClock>();

	elapsedMs(taskId: string, reportedMs: number | undefined, running: boolean, now = Date.now()): number | undefined {
		const elapsedMs = liveElapsedMs(taskId, reportedMs, running, now);
		const clock = seen.get(taskId)?.deref();
		if (clock !== undefined) this.retained.set(taskId, clock);
		return elapsedMs;
	}

	settle(taskId: string, reportedMs: number | undefined, now = Date.now()): void {
		const entry = seen.get(taskId)?.deref();
		if (entry === undefined || entry.settled) return;
		entry.frozen = Math.max(entry.frozen ?? 0, reportedMs ?? 0, entry.displayed, now - entry.since);
		entry.settled = true;
		this.retained.set(taskId, entry);
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
