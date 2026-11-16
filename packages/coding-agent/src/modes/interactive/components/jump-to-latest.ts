/**
 * Counts what arrived in a transcript since the reader scrolled away from its live end. Observe it on every frame:
 * while the reader follows, the baseline moves with the transcript; once they scroll up, it stays where they left.
 */
export class NewMessageCounter {
	private baseline: number | undefined;
	private latest = 0;

	observe(following: boolean, count: number): void {
		this.latest = count;
		if (following || this.baseline === undefined || count < this.baseline) this.baseline = count;
	}

	/** Messages that arrived since the reader stopped following; 0 while they follow. */
	get count(): number {
		return this.baseline === undefined ? 0 : Math.max(0, this.latest - this.baseline);
	}
}

/** `↓ 3 new messages · ctrl+end`, or `↓ jump to bottom · ctrl+end` while nothing new has arrived. */
export function jumpToLatestLabel(newCount: number, keyLabel: string): string {
	const what = newCount > 0 ? `↓ ${newCount} new ${newCount === 1 ? "message" : "messages"}` : "↓ jump to bottom";
	return keyLabel.length > 0 ? `${what} · ${keyLabel}` : what;
}
