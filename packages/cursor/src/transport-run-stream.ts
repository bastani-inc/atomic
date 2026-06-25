import type {
	CursorControlMessage,
	CursorHttp2StreamHandle,
	CursorProtocolCodec,
	CursorProtocolMessage,
	CursorRunStream,
	CursorServerMessage,
	CursorToolResultMessage,
	CursorWriteOptions,
} from "./transport-types.js";
import { CursorTransportError, throwIfCursorEndStreamError, toError } from "./transport-errors.js";
import { CursorConnectFrameDecoder, encodeCursorConnectFrame } from "./transport-frame.js";

const DEFAULT_CANCEL_WRITE_TIMEOUT_MS = 1_000;

function isCursorControlMessage(message: CursorProtocolMessage): message is CursorControlMessage {
	return message.type === "kvGetBlob" || message.type === "kvSetBlob" || message.type === "conversationCheckpoint" || message.type === "requestContext";
}

export class Http2CursorRunStream implements CursorRunStream {
	readonly messages: AsyncIterable<CursorServerMessage>;
	#closed = false;
	#cancelled = false;
	readonly #heartbeatTimer?: ReturnType<typeof setInterval>;
	readonly #messageQueue: CursorServerMessage[] = [];
	readonly #messageReaders: Array<{
		readonly resolve: (value: IteratorResult<CursorServerMessage>) => void;
		readonly reject: (error: unknown) => void;
	}> = [];
	#messageQueueFinished = false;
	#messageQueueError: Error | undefined;

	constructor(
		readonly id: string,
		readonly handle: CursorHttp2StreamHandle,
		readonly codec: CursorProtocolCodec,
		readonly secrets: readonly string[],
		heartbeatIntervalMs: number,
		readonly onCancel: () => void,
		readonly onClose: () => void,
	) {
		this.messages = this.createMessages();
		void this.pumpMessages();
		if (heartbeatIntervalMs > 0) {
			this.#heartbeatTimer = setInterval(() => {
				this.handle.write(encodeCursorConnectFrame(this.codec.encodeHeartbeatRequest())).catch(() => {
					this.cancel().catch(() => undefined);
				});
			}, heartbeatIntervalMs);
			this.#heartbeatTimer.unref?.();
		}
	}

	async writeToolResult(result: CursorToolResultMessage, options?: CursorWriteOptions): Promise<void> {
		if (this.#closed) throw new CursorTransportError("ProtocolError", "Cannot write Cursor tool result to a closed stream.");
		try {
			await this.handle.write(encodeCursorConnectFrame(this.codec.encodeToolResult(result)), options);
		} catch (error) {
			await this.cancel().catch(() => undefined);
			throw error;
		}
	}

	async cancel(): Promise<void> {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.clearHeartbeat();
		let cancelError: Error | undefined;
		try {
			await this.handle.write(encodeCursorConnectFrame(this.codec.encodeCancelRequest()), { timeoutMs: DEFAULT_CANCEL_WRITE_TIMEOUT_MS }).catch(() => undefined);
		} finally {
			this.onCancel();
			try {
				await this.handle.cancel();
			} catch (error) {
				cancelError = toError(error);
			} finally {
				this.finishMessageQueue();
				if (!this.#closed) {
					this.#closed = true;
					this.codec.disposeRun?.(this.id);
					this.onClose();
				}
			}
		}
		if (cancelError) throw cancelError;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.clearHeartbeat();
		try {
			await this.handle.close();
		} finally {
			this.finishMessageQueue();
			this.codec.disposeRun?.(this.id);
			this.onClose();
		}
	}

	private clearHeartbeat(): void {
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
	}

	private async pumpMessages(): Promise<void> {
		const decoder = new CursorConnectFrameDecoder();
		try {
			for await (const raw of this.handle.frames) {
				if (this.#closed || this.#cancelled) break;
				for (const frame of decoder.push(raw)) {
					if (this.#closed || this.#cancelled) break;
					if (frame.endStream) {
						try {
							throwIfCursorEndStreamError(frame.data, this.secrets);
						} catch (error) {
							this.codec.discardRun?.(this.id);
							throw error;
						}
						continue;
					}
					for (const message of this.codec.decodeRunFrame(frame)) {
						if (this.#closed || this.#cancelled) break;
						const response = this.codec.encodeServerResponse?.(message, this.id);
						if (response) {
							await this.handle.write(encodeCursorConnectFrame(response));
							continue;
						}
						if (!isCursorControlMessage(message)) this.enqueueMessage(message);
					}
				}
			}
			decoder.finish();
			this.finishMessageQueue();
		} catch (error) {
			this.finishMessageQueue(toError(error));
		}
	}

	private enqueueMessage(message: CursorServerMessage): void {
		if (this.#messageQueueFinished) return;
		this.#messageQueue.push(message);
		this.flushMessageReaders();
	}

	private finishMessageQueue(error?: Error): void {
		if (this.#messageQueueFinished) return;
		this.#messageQueueFinished = true;
		this.#messageQueueError = error;
		this.flushMessageReaders();
	}

	private flushMessageReaders(): void {
		while (this.#messageReaders.length > 0) {
			const reader = this.#messageReaders.shift();
			if (!reader) return;
			const message = this.#messageQueue.shift();
			if (message !== undefined) {
				reader.resolve({ value: message, done: false });
			} else if (this.#messageQueueError) {
				reader.reject(this.#messageQueueError);
			} else if (this.#messageQueueFinished) {
				reader.resolve({ value: undefined, done: true });
			} else {
				this.#messageReaders.unshift(reader);
				return;
			}
		}
	}

	private nextMessage(): Promise<IteratorResult<CursorServerMessage>> {
		const message = this.#messageQueue.shift();
		if (message !== undefined) return Promise.resolve({ value: message, done: false });
		if (this.#messageQueueError) return Promise.reject(this.#messageQueueError);
		if (this.#messageQueueFinished) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve, reject) => {
			this.#messageReaders.push({ resolve, reject });
		});
	}

	private async *createMessages(): AsyncIterable<CursorServerMessage> {
		while (true) {
			const next = await this.nextMessage();
			if (next.done) return;
			yield next.value;
		}
	}
}
