import { availableParallelism, loadavg } from "node:os";

export const BASE_STARTUP_TIMEOUT_MS = 30_000;
export const MAX_DEFAULT_STARTUP_TIMEOUT_MS = 600_000;

export interface HostCapacity {
	readonly cpus: number;
	readonly load: number;
}

function currentHostCapacity(): HostCapacity {
	return { cpus: availableParallelism(), load: loadavg()[0] ?? 0 };
}

export function defaultStartupTimeoutMs(workers: number, host: HostCapacity = currentHostCapacity()): number {
	const cores = Math.max(1, host.cpus);
	const demand = workers + Math.max(0, host.load);
	const oversubscription = Math.max(1, demand / cores);
	return Math.min(MAX_DEFAULT_STARTUP_TIMEOUT_MS, Math.ceil(BASE_STARTUP_TIMEOUT_MS * oversubscription));
}

export function startupTimeoutMessage(startupTimeoutMs: number): string {
	return `Local worker startup timed out after ${startupTimeoutMs} ms: workers were too slow to start, usually because the machine is busy or the pool is large for its cores. Raise workflows.localWorkers.startupTimeoutMs (localWorkers.startupTimeoutMs in the SDK) to allow more time`;
}
