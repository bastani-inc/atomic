/** How long a worker host waits after its first failed poll of the shared journal, and the longest it waits (#4768). */
export const HOST_POLL_BACKOFF = { firstMs: 1_000, maxMs: 30_000 } as const;

/**
 * When a worker host polls the shared journal again after its polls failed (#4768): after the n-th failure in a row it
 * waits `firstMs * 2^(n-1)`, at most `maxMs`, less up to half of that at random, so hosts that lost the journal
 * together do not all come back at once. A poll that succeeds forgets the failures.
 */
export class HostPollBackoff {
	private failures = 0;
	private until = 0;

	constructor(
		private readonly now: () => number = () => performance.now(),
		private readonly random: () => number = Math.random,
		private readonly policy: { readonly firstMs: number; readonly maxMs: number } = HOST_POLL_BACKOFF,
	) {}

	/** Whether the host may poll now. */
	due(): boolean {
		return this.now() >= this.until;
	}

	/** Records a failed poll; returns its count of failures in a row and how long the host now waits. */
	failed(): { readonly failures: number; readonly retryInMs: number } {
		this.failures++;
		const longest = Math.min(this.policy.maxMs, this.policy.firstMs * 2 ** (this.failures - 1));
		const retryInMs = Math.round(longest * (1 - this.random() / 2));
		this.until = this.now() + retryInMs;
		return { failures: this.failures, retryInMs };
	}

	/** Records a poll that succeeded; returns how many failed in a row before it. */
	succeeded(): number {
		const failures = this.failures;
		this.failures = 0;
		this.until = 0;
		return failures;
	}
}
