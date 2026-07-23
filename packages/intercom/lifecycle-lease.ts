export interface LifecycleLease<TShutdown> {
	readonly id: number;
	readonly priorCleanup: Promise<void>;
	retired: boolean;
	shutdown: TShutdown | null;
	cleanupBarrier: Promise<void>;
}

export function createLifecycleLease<TShutdown>(
	id: number,
	priorCleanup: Promise<void> = Promise.resolve(),
): LifecycleLease<TShutdown> {
	return { id, priorCleanup, retired: false, shutdown: null, cleanupBarrier: priorCleanup };
}

export function retireLifecycleLease<TShutdown>(lease: LifecycleLease<TShutdown>, shutdown: TShutdown): void {
	if (lease.retired) return;
	lease.retired = true;
	lease.shutdown = shutdown;
}

export function retainSettledLifecycleCleanup<TShutdown>(
	lease: LifecycleLease<TShutdown>,
	cleanup: readonly (Promise<unknown> | null)[],
): Promise<void> {
	const previousCleanup = lease.cleanupBarrier;
	const pendingCleanup = cleanup.filter((task): task is Promise<unknown> => task !== null);
	lease.cleanupBarrier = Promise.allSettled([previousCleanup, ...pendingCleanup]).then(() => undefined);
	return lease.cleanupBarrier;
}

export function assertCurrentLifecycleLease<TShutdown>(
	current: LifecycleLease<TShutdown>,
	expected: LifecycleLease<TShutdown>,
	message: string,
): void {
	if (current !== expected || expected.retired) throw new Error(message);
}

/** Rejection-safe FIFO for lifecycle forwarding that must not overtake replay. */
export class SerializedLifecycleForwarder {
	private tail: Promise<void> = Promise.resolve();

	get settled(): Promise<void> { return this.tail; }

	enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}
}
