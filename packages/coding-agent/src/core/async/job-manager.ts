import { COMPLETED_JOB_TTL_MS, MAX_MANAGED_BASH_JOBS, type ManagedBashJob } from "../tools/bash-async-jobs.js";
import { formatAsyncResultForFollowUp } from "./format.js";
import type { AsyncJobDeliveryCallback, AsyncJobDeliveryHandler, AsyncJobDeliveryMessage, ManagedAsyncBashJob } from "./types.js";

const DEFAULT_MAX_RUNNING_JOBS = 15;
const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;

interface AsyncJobManagerOptions {
	onJobComplete: AsyncJobDeliveryCallback;
	maxRunningJobs?: number;
	maxRetainedJobs?: number;
	completedJobTtlMs?: number;
}

interface Delivery {
	jobId: string;
	message: AsyncJobDeliveryMessage;
	attempt: number;
	nextAttemptAt: number;
	promise?: Promise<void>;
}

interface RegisteredSession {
	disposed: boolean;
	activeJobIds: Set<string>;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, ManagedBashJob>();
	readonly #deliveries: Delivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #inFlightDeliveries = new Map<string, Delivery>();
	readonly #deliveryHandlers = new Map<string, AsyncJobDeliveryHandler>();
	readonly #jobSessions = new Map<string, symbol>();
	readonly #sessions = new Map<symbol, RegisteredSession>();
	readonly #onJobComplete: AsyncJobDeliveryCallback;
	readonly #maxRunningJobs: number;
	readonly #maxRetainedJobs: number;
	readonly #completedJobTtlMs: number;
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;
	#runningDeliveryLoop = false;
	#disposeWhenUnused = false;

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#maxRetainedJobs = Math.max(1, Math.floor(options.maxRetainedJobs ?? MAX_MANAGED_BASH_JOBS));
		this.#completedJobTtlMs = Math.max(0, Math.floor(options.completedJobTtlMs ?? COMPLETED_JOB_TTL_MS));
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get atCapacity(): boolean {
		let running = 0;
		for (const job of this.#jobs.values()) if (job.status === "running") running += 1;
		return running >= this.#maxRunningJobs;
	}


	registerSession(): symbol {
		if (this.#disposed) throw new Error("Async job manager is disposed");
		const sessionId = Symbol("async-job-session");
		this.#sessions.set(sessionId, { disposed: false, activeJobIds: new Set() });
		return sessionId;
	}

	releaseSession(sessionId: symbol): void {
		const session = this.#sessions.get(sessionId);
		if (!session) return;
		session.disposed = true;
		this.acknowledgeDeliveries([...session.activeJobIds]);
		this.#sessions.delete(sessionId);
		if (this.#sessions.size === 0) this.#disposeWhenUnused = true;
		this.#disposeIfUnused();
	}


	transferSessionDeliveries(sourceId: symbol, targetId: symbol, handler: AsyncJobDeliveryHandler): void {
		const source = this.#sessions.get(sourceId);
		const target = this.#sessions.get(targetId);
		if (!source || !target || target.disposed) return;
		for (const jobId of source.activeJobIds) {
			source.activeJobIds.delete(jobId);
			target.activeJobIds.add(jobId);
			this.#jobSessions.set(jobId, targetId);
			this.#deliveryHandlers.set(jobId, handler);
		}
	}

	isSessionDisposed(sessionId: symbol): boolean {
		return this.#disposed || this.#sessions.get(sessionId)?.disposed !== false;
	}
	registerBashJob(job: ManagedBashJob, onComplete?: AsyncJobDeliveryHandler, sessionId?: symbol): void {
		if (this.#disposed) throw new Error("Async job manager is disposed");
		this.#pruneRetention();
		if (this.atCapacity) throw new Error(`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`);
		if (sessionId !== undefined && this.isSessionDisposed(sessionId)) throw new Error("Async job session is disposed");
		this.#suppressedDeliveries.delete(job.jobId);
		if (onComplete) this.#deliveryHandlers.set(job.jobId, onComplete);
		else this.#deliveryHandlers.delete(job.jobId);
		if (sessionId !== undefined) {
			this.#jobSessions.set(job.jobId, sessionId);
			this.#sessions.get(sessionId)?.activeJobIds.add(job.jobId);
		} else this.#jobSessions.delete(job.jobId);
		this.#jobs.set(job.jobId, job);
		this.#pruneRetention();
	}

	completeBashJob(job: ManagedBashJob): void {
		if (this.#disposed || this.#suppressedDeliveries.has(job.jobId)) return;
		if (job.status === "running") return;
		this.#jobs.set(job.jobId, job);
		this.#pruneRetention();
		if (this.#jobs.has(job.jobId)) this.#enqueueDelivery(job as ManagedAsyncBashJob);
	}

	acknowledgeDeliveries(jobIds: readonly string[]): void {
		for (const jobId of jobIds) {
			this.#suppressedDeliveries.add(jobId);
			for (let index = this.#deliveries.length - 1; index >= 0; index -= 1) {
				if (this.#deliveries[index]?.jobId === jobId) this.#deliveries.splice(index, 1);
			}
			this.#deliveryHandlers.delete(jobId);
			this.#completeTrackedJob(jobId);
		}
		this.#pruneRetention();
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId);
	}

	deliveryState(): { queued: number; delivering: boolean; pendingJobIds: string[] } {
		this.#pruneRetention();
		return {
			queued: this.#deliveries.length,
			delivering: this.#runningDeliveryLoop || this.#inFlightDeliveries.size > 0,
			pendingJobIds: [...this.#deliveries.map((delivery) => delivery.jobId), ...this.#inFlightDeliveries.keys()],
		};
	}

	retentionState(): { jobs: number; suppressions: number; handlers: number; queued: number; sessions: number } {
		this.#pruneRetention();
		return { jobs: this.#jobs.size, suppressions: this.#suppressedDeliveries.size, handlers: this.#deliveryHandlers.size, queued: this.#deliveries.length + this.#inFlightDeliveries.size, sessions: this.#sessions.size };
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#deliveries.length = 0;
		this.#inFlightDeliveries.clear();
		this.#deliveryHandlers.clear();
		this.#jobSessions.clear();
		this.#sessions.clear();
		this.#jobs.clear();
		this.#suppressedDeliveries.clear();
	}

	#enqueueDelivery(job: ManagedAsyncBashJob): void {
		if (this.#inFlightDeliveries.has(job.jobId)) return;
		for (let index = this.#deliveries.length - 1; index >= 0; index -= 1) if (this.#deliveries[index]?.jobId === job.jobId) this.#deliveries.splice(index, 1);
		this.#deliveries.push({ jobId: job.jobId, message: formatAsyncResultForFollowUp(job), attempt: 0, nextAttemptAt: Date.now() });
		this.#pruneRetention();
		void this.#runDeliveryLoop();
	}


	#completeTrackedJob(jobId: string): void {
		const sessionId = this.#jobSessions.get(jobId);
		if (sessionId !== undefined) this.#sessions.get(sessionId)?.activeJobIds.delete(jobId);
		this.#jobSessions.delete(jobId);
	}
	#disposeIfUnused(): void {
		if (!this.#disposeWhenUnused || this.#sessions.size > 0 || this.#inFlightDeliveries.size > 0) return;
		this.dispose();
		if (AsyncJobManager.#instance === this) AsyncJobManager.#instance = undefined;
	}
	#pruneRetention(now = Date.now()): void {
		for (const [jobId, job] of this.#jobs) {
			if (job.status !== "running" && job.endedAt !== undefined && now - job.endedAt > this.#completedJobTtlMs) {
				this.#jobs.delete(jobId);
				this.#completeTrackedJob(jobId);
			}
		}
		for (const jobId of this.#suppressedDeliveries) {
			if (!this.#jobs.has(jobId)) this.#suppressedDeliveries.delete(jobId);
		}
		const oldestTerminalJobs = [...this.#jobs.values()]
			.filter((job) => job.status !== "running")
			.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
		while (this.#jobs.size > this.#maxRetainedJobs && oldestTerminalJobs.length > 0) {
			const job = oldestTerminalJobs.shift();
			if (job) {
				this.#jobs.delete(job.jobId);
				this.#completeTrackedJob(job.jobId);
			}
		}
		for (let index = this.#deliveries.length - 1; index >= 0; index -= 1) {
			const delivery = this.#deliveries[index];
			if (!delivery || !this.#jobs.has(delivery.jobId) || this.#suppressedDeliveries.has(delivery.jobId)) this.#deliveries.splice(index, 1);
		}
		while (this.#deliveries.length + this.#inFlightDeliveries.size > this.#maxRetainedJobs && this.#deliveries.length > 0) this.#deliveries.shift();
		for (const jobId of this.#deliveryHandlers.keys()) if (!this.#jobs.has(jobId) || this.#suppressedDeliveries.has(jobId)) this.#deliveryHandlers.delete(jobId);
		for (const session of this.#sessions.values()) for (const jobId of session.activeJobIds) if (!this.#jobs.has(jobId)) session.activeJobIds.delete(jobId);
	}

	#scheduleDeliveryLoop(delayMs: number): void {
		if (this.#disposed) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#runDeliveryLoop();
		}, delayMs);
		this.#timer.unref?.();
	}

	async #runDeliveryLoop(): Promise<void> {
		if (this.#runningDeliveryLoop || this.#disposed) return;
		this.#runningDeliveryLoop = true;
		try {
			while (!this.#disposed) {
				const now = Date.now();
				const delivery = this.#deliveries.find((candidate) => candidate.nextAttemptAt <= now);
				if (!delivery) break;
				this.#deliveries.splice(this.#deliveries.indexOf(delivery), 1);
				this.#startDelivery(delivery);
			}
		} finally {
			this.#runningDeliveryLoop = false;
		}
		this.#scheduleNextDelivery();
	}

	#startDelivery(delivery: Delivery): void {
		if (this.#suppressedDeliveries.has(delivery.jobId) || !this.#jobs.has(delivery.jobId) || this.#inFlightDeliveries.has(delivery.jobId)) return;
		const handler = this.#deliveryHandlers.get(delivery.jobId) ?? this.#onJobComplete;
		this.#inFlightDeliveries.set(delivery.jobId, delivery);
		delivery.promise = (async () => handler(delivery.message))()
			.then(() => {
				if (!this.#suppressedDeliveries.has(delivery.jobId) && this.#jobs.has(delivery.jobId)) {
					this.#deliveryHandlers.delete(delivery.jobId);
					this.#completeTrackedJob(delivery.jobId);
				}
			})
			.catch(() => {
				if (this.#disposed || this.#suppressedDeliveries.has(delivery.jobId) || !this.#jobs.has(delivery.jobId)) return;
				delivery.attempt += 1;
				const jitter = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
				delivery.nextAttemptAt = Date.now() + Math.min(DELIVERY_RETRY_MAX_MS, DELIVERY_RETRY_BASE_MS * 2 ** delivery.attempt) + jitter;
				this.#deliveries.push(delivery);
			})
			.finally(() => {
				this.#inFlightDeliveries.delete(delivery.jobId);
				this.#pruneRetention();
				this.#scheduleNextDelivery();
				this.#disposeIfUnused();
			});
	}

	#scheduleNextDelivery(): void {
		const next = this.#deliveries.reduce<number | undefined>((soonest, delivery) => soonest === undefined ? delivery.nextAttemptAt : Math.min(soonest, delivery.nextAttemptAt), undefined);
		if (next !== undefined) this.#scheduleDeliveryLoop(Math.max(0, next - Date.now()));
	}
}
