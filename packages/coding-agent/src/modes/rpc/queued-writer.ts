import type { Writable } from "node:stream";

interface PendingFrame {
	bytes: Buffer;
	resolve?: () => void;
	reject?: (error: Error) => void;
}

/** A one-write-at-a-time stream writer with replaceable updates. */
export class QueuedWriter {
	private readonly critical: PendingFrame[] = [];
	private readonly coalesced = new Map<string, PendingFrame>();
	private queuedBytes = 0;
	private pumping = false;
	private closedError: Error | undefined;

	private readonly stream: Writable;

	constructor(stream: Writable) {
		this.stream = stream;
	}

	get pendingBytes(): number {
		return this.queuedBytes;
	}

	async write(text: string): Promise<void> {
		const bytes = Buffer.from(text, "utf8");
		if (this.closedError) throw this.closedError;
		await new Promise<void>((resolve, reject) => {
			this.critical.push({ bytes, resolve, reject });
			this.queuedBytes += bytes.length;
			this.pump();
		});
	}

	offerLatest(key: string, text: string): boolean {
		if (this.closedError) return false;
		const bytes = Buffer.from(text, "utf8");
		const previous = this.coalesced.get(key);
		if (previous) this.queuedBytes -= previous.bytes.length;
		this.coalesced.set(key, { bytes });
		this.queuedBytes += bytes.length;
		this.pump();
		return true;
	}

	close(error = new Error("RPC writer closed")): void {
		if (this.closedError) return;
		this.closedError = error;
		for (const frame of this.critical.splice(0)) frame.reject?.(error);
		this.coalesced.clear();
		this.queuedBytes = 0;
	}

	private next(): PendingFrame | undefined {
		const critical = this.critical.shift();
		if (critical) return critical;
		const entry = this.coalesced.entries().next().value as [string, PendingFrame] | undefined;
		if (!entry) return undefined;
		this.coalesced.delete(entry[0]);
		return entry[1];
	}

	private pump(): void {
		if (this.pumping) return;
		this.pumping = true;
		void this.runPump();
	}

	private async runPump(): Promise<void> {
		try {
			let frame: PendingFrame | undefined;
			while (!this.closedError && (frame = this.next())) {
				this.queuedBytes -= frame.bytes.length;
				await new Promise<void>((resolve, reject) => {
					this.stream.write(frame!.bytes, (error) => (error ? reject(error) : resolve()));
				});
				frame.resolve?.();
			}
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.close(failure);
		} finally {
			this.pumping = false;
			if (!this.closedError && (this.critical.length > 0 || this.coalesced.size > 0)) this.pump();
		}
	}
}
