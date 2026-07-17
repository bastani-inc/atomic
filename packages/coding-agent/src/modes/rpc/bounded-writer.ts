import type { Writable } from "node:stream";

interface PendingFrame {
	bytes: Buffer;
	resolve?: () => void;
	reject?: (error: Error) => void;
	key?: string;
}

export interface BoundedWriterOptions {
	maxFrameBytes: number;
	maxQueuedBytes: number;
}

/** A byte-accounted, one-write-at-a-time stream writer with replaceable updates. */
export class BoundedWriter {
	private readonly critical: PendingFrame[] = [];
	private readonly coalesced = new Map<string, PendingFrame>();
	private readonly capacityWaiters = new Set<() => void>();
	private queuedBytes = 0;
	private pumping = false;
	private closedError: Error | undefined;

	private readonly stream: Writable;
	private readonly options: BoundedWriterOptions;

	constructor(
		stream: Writable,
		options: BoundedWriterOptions,
	) {
		this.stream = stream;
		this.options = options;
	}

	get pendingBytes(): number { return this.queuedBytes; }

	async write(text: string): Promise<void> {
		const bytes = this.frame(text);
		while (!this.closedError && this.queuedBytes + bytes.length > this.options.maxQueuedBytes) {
			await new Promise<void>((resolve) => this.capacityWaiters.add(resolve));
		}
		if (this.closedError) throw this.closedError;
		await new Promise<void>((resolve, reject) => {
			this.critical.push({ bytes, resolve, reject });
			this.queuedBytes += bytes.length;
			this.pump();
		});
	}

	offerLatest(key: string, text: string): boolean {
		if (this.closedError) return false;
		const bytes = this.frame(text);
		const previous = this.coalesced.get(key);
		const nextBytes = this.queuedBytes - (previous?.bytes.length ?? 0) + bytes.length;
		if (nextBytes > this.options.maxQueuedBytes) return false;
		if (previous) this.queuedBytes -= previous.bytes.length;
		this.coalesced.set(key, { bytes, key });
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
		this.wakeCapacityWaiters();
	}

	private frame(text: string): Buffer {
		const bytes = Buffer.from(text, "utf8");
		const payloadBytes = bytes.at(-1) === 0x0a ? bytes.length - 1 : bytes.length;
		if (payloadBytes > this.options.maxFrameBytes) {
			throw new Error(`RPC frame exceeds ${this.options.maxFrameBytes} bytes`);
		}
		return bytes;
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
				this.wakeCapacityWaiters();
				await new Promise<void>((resolve, reject) => {
					this.stream.write(frame!.bytes, (error) => error ? reject(error) : resolve());
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

	private wakeCapacityWaiters(): void {
		for (const resolve of this.capacityWaiters) resolve();
		this.capacityWaiters.clear();
	}
}
