import type { Writable } from "node:stream";
import { markRpcTransportFailure, rpcTransportError } from "./rpc-transport-error.ts";

interface PendingFrame {
	bytes: Buffer;
	resolve?: () => void;
	reject?: (error: Error) => void;
}

/** A one-write-at-a-time stream writer with replaceable updates. */
export class QueuedWriter {
	private readonly critical: PendingFrame[] = [];
	private readonly coalesced = new Map<string, PendingFrame>();
	/**
	 * The frame currently being written. It has already left the queue, so
	 * `close()` would not see it; without this a stream callback failure (EPIPE
	 * on a dying engine) leaves its `write()` promise pending forever and the
	 * caller — a prompt, an abort — never learns the send failed.
	 */
	private active: PendingFrame | undefined;
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

	/**
	 * Reject the in-flight frame and everything queued behind it.
	 *
	 * The error is classified as a transport failure before it is stored, so the
	 * active frame, the queued frames, and every later `write()` all reject with
	 * the same classified value — a raw stream `EPIPE` included.
	 */
	close(error: Error = rpcTransportError("RPC writer closed")): void {
		if (this.closedError) return;
		this.closedError = markRpcTransportFailure(error);
		const closedError = this.closedError;
		// The in-flight frame first: it is no longer in either queue.
		const active = this.active;
		this.active = undefined;
		active?.reject?.(closedError);
		for (const frame of this.critical.splice(0)) frame.reject?.(closedError);
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
			for (;;) {
				if (this.closedError) break;
				const frame = this.next();
				if (frame === undefined) break;
				this.active = frame;
				this.queuedBytes -= frame.bytes.length;
				await new Promise<void>((resolve, reject) => {
					this.stream.write(frame.bytes, (error) => (error ? reject(error) : resolve()));
				});
				this.active = undefined;
				frame.resolve?.();
			}
		} catch (error) {
			// Any callback failure means the frame never reached the child, so it is
			// a transport failure whatever the stream chose to call it. The frame
			// that failed is still `active`, so close() rejects it along with
			// everything still queued. Nothing is left pending.
			this.close(markRpcTransportFailure(error));
		} finally {
			this.pumping = false;
			if (!this.closedError && (this.critical.length > 0 || this.coalesced.size > 0)) this.pump();
		}
	}
}
