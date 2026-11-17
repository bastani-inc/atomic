interface WorkerWait {
	from: number;
	readonly requests: Map<string, number>;
}

export class FleetRateWaiting {
	private readonly workers = new Map<string, WorkerWait>();
	private elapsedMs = 0;

	private accumulate(wait: WorkerWait, now: number): void {
		let until = wait.from;
		for (const expires of wait.requests.values()) until = Math.max(until, expires);
		this.elapsedMs += Math.max(0, Math.min(now, until) - wait.from);
		wait.from = now;
		for (const [request, expires] of wait.requests) if (expires <= now) wait.requests.delete(request);
	}

	record(worker: string, request: string, durationMs: number, now: number): void {
		const wait = this.workers.get(worker) ?? { from: now, requests: new Map<string, number>() };
		this.accumulate(wait, now);
		wait.requests.set(request, now + durationMs);
		this.workers.set(worker, wait);
	}

	releaseRequest(worker: string, request: string, now: number): void {
		const wait = this.workers.get(worker);
		if (wait === undefined) return;
		this.accumulate(wait, now);
		wait.requests.delete(request);
		if (wait.requests.size === 0) this.workers.delete(worker);
	}

	releaseWorker(worker: string, now: number): void {
		const wait = this.workers.get(worker);
		if (wait === undefined) return;
		this.accumulate(wait, now);
		this.workers.delete(worker);
	}

	total(now: number): number {
		for (const [worker, wait] of this.workers) {
			this.accumulate(wait, now);
			if (wait.requests.size === 0) this.workers.delete(worker);
		}
		return this.elapsedMs;
	}

	close(now: number): void {
		for (const worker of this.workers.keys()) this.releaseWorker(worker, now);
	}
}
