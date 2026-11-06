/** How long a worker host waits after a binding's first failed restore, and the longest it ever waits (#4416). */
export const RESTORE_BACKOFF = { firstMs: 1_000, maxMs: 60_000 } as const;

/**
 * When a worker host may restore each binding again whose restores failed (#4416): after the n-th failure in a row it
 * waits `firstMs * 2^(n-1)`, at most `maxMs`, and a restore that succeeds forgets the binding's failures. A host never
 * claims and releases the same child in a tight loop.
 */
export class RestoreBackoff {
	private readonly failing = new Map<string, { readonly failures: number; readonly until: number }>();

	constructor(
		private readonly now: () => number = () => performance.now(),
		private readonly policy: { readonly firstMs: number; readonly maxMs: number } = RESTORE_BACKOFF,
	) {}

	/** Whether the binding with affinity `key` waits out a backoff now. */
	waiting(key: string): boolean {
		const failing = this.failing.get(key);
		return failing !== undefined && this.now() < failing.until;
	}

	/** Records a failed restore of the binding with affinity `key`; returns how long it now waits. */
	failed(key: string): number {
		const failures = (this.failing.get(key)?.failures ?? 0) + 1;
		const waitMs = Math.min(this.policy.maxMs, this.policy.firstMs * 2 ** (failures - 1));
		this.failing.set(key, { failures, until: this.now() + waitMs });
		return waitMs;
	}

	/** Forgets the failures of the binding with affinity `key`, whose restore succeeded; whether it had any. */
	succeeded(key: string): boolean {
		return this.failing.delete(key);
	}
}
