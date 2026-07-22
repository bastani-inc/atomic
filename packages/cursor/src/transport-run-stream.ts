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
import type { CursorErrorRouteContext } from "./errors.js";
import { CursorTransportError, sanitizeCursorTransportError, throwIfCursorEndStreamError, toError } from "./transport-errors.js";
import { CursorConnectFrameDecoder, encodeCursorConnectFrame } from "./transport-frame.js";

const DEFAULT_CANCEL_WRITE_TIMEOUT_MS = 1_000;

function isCursorControlMessage(message: CursorProtocolMessage): message is CursorControlMessage {
	return message.type === "kvGetBlob" || message.type === "kvSetBlob" || message.type === "conversationCheckpoint" || message.type === "requestContext";
}

export class Http2CursorRunStream implements CursorRunStream {
	readonly messages: AsyncIterable<CursorServerMessage>;
	#closed = false;
	#cancelled = false;
	#codecReleased = false;
	#handleTerminal: Promise<void> | undefined;
	readonly failure: Promise<Error>;
	readonly #signalFailure: (error: Error) => void;
	readonly #heartbeatWrites = new Set<Promise<void>>();
	readonly #heartbeatTimer?: ReturnType<typeof setInterval>;
	readonly #messageQueue: CursorServerMessage[] = [];
	readonly #withheldMessages: CursorServerMessage[] = [];
	#pendingToolResults = 0;
	#cleanEndStreamValidated = false;
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
		readonly route: CursorErrorRouteContext,
		heartbeatIntervalMs: number,
		readonly onCancel: () => void,
		readonly onClose: () => void,
	) {
		let signalFailure = (_error: Error): void => undefined;
		this.failure = new Promise<Error>((resolve) => { signalFailure = resolve; });
		this.#signalFailure = signalFailure;
		this.messages = this.createMessages();
		void this.pumpMessages();
		if (heartbeatIntervalMs > 0) {
			this.#heartbeatTimer = setInterval(() => {
				const heartbeat = this.handle.write(encodeCursorConnectFrame(this.codec.encodeHeartbeatRequest())).catch(() => this.cancel().catch(() => undefined));
				this.#heartbeatWrites.add(heartbeat);
				void heartbeat.finally(() => this.#heartbeatWrites.delete(heartbeat));
			}, heartbeatIntervalMs);
			this.#heartbeatTimer.unref?.();
		}
	}

	async writeToolResult(result: CursorToolResultMessage, options?: CursorWriteOptions): Promise<void> {
		if (this.#closed) throw new CursorTransportError("ProtocolError", "Cannot write Cursor tool result to a closed stream.", "request", this.route);
		try {
			await this.handle.write(encodeCursorConnectFrame(this.codec.encodeToolResult(result)), options);
			if (this.#pendingToolResults > 0) this.#pendingToolResults -= 1;
			if (this.#pendingToolResults === 0) this.publishWithheldMessages();
		} catch (error) {
			await this.cancel().catch(() => undefined);
			throw sanitizeCursorTransportError(toError(error), this.secrets, { operation: "request", route: this.route });
		}
	}

	async cancel(): Promise<void> {
		if (this.#cancelled || this.#closed) return;
		this.#cancelled = true;
		this.clearHeartbeat();
		let cancelError: Error | undefined;
		try {
			await this.handle.write(encodeCursorConnectFrame(this.codec.encodeCancelRequest()), { timeoutMs: DEFAULT_CANCEL_WRITE_TIMEOUT_MS }).catch(() => undefined);
		} finally {
			this.onCancel();
			try {
				await this.terminateHandle("cancel");
			} catch (error) {
				cancelError = toError(error);
			} finally {
				this.finishMessageQueue();
				if (!this.#closed) {
					this.#closed = true;
					this.releaseCodec(true);
					this.onClose();
				}
			}
		}
		if (cancelError) throw cancelError;
	}

	async close(): Promise<void> {
		if (this.#closed || this.#cancelled) return;
		this.#closed = true;
		this.clearHeartbeat();
		let closeError: Error | undefined;
		try {
			await this.closeHandleOrAbandon();
			await this.waitForHeartbeatWrites();
		} catch (error) {
			closeError = sanitizeCursorTransportError(toError(error), this.secrets, { operation: "stream", route: this.route });
		} finally {
			try {
				// Retain continuation only for a validated clean end-stream; any other
				// termination (including a close-time failure) discards it.
				this.releaseCodec(!(this.#cleanEndStreamValidated && closeError === undefined));
			} finally {
				this.onClose();
			}
		}
		if (!closeError && this.#cleanEndStreamValidated) this.publishWithheldMessages(true);
		else this.#withheldMessages.length = 0;
		this.finishMessageQueue(closeError);
		if (closeError) throw closeError;
	}

	private clearHeartbeat(): void {
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
	}

	private terminateHandle(kind: "close" | "cancel"): Promise<void> {
		if (this.#handleTerminal) return this.#handleTerminal;
		this.#handleTerminal = Promise.resolve().then(() => kind === "close" ? this.handle.close() : this.handle.cancel());
		return this.#handleTerminal;
	}

	private async closeHandleOrAbandon(): Promise<void> {
		const closeAttempt = this.terminateHandle("close");
		try {
			await closeAttempt;
		} catch {
			if (this.#handleTerminal === closeAttempt) this.#handleTerminal = undefined;
			await this.terminateHandle("cancel");
		}
	}

	private async waitForHeartbeatWrites(): Promise<void> {
		while (this.#heartbeatWrites.size > 0) {
			await Promise.allSettled([...this.#heartbeatWrites]);
		}
	}

	private releaseCodec(discard = false): void {
		if (this.#codecReleased) return;
		this.#codecReleased = true;
		if (discard && this.codec.discardRun) this.codec.discardRun(this.id);
		else this.codec.disposeRun?.(this.id);
	}

	private async pumpMessages(): Promise<void> {
		const decoder = new CursorConnectFrameDecoder();
		let cleanEndStreamSeen = false;
		try {
			for await (const raw of this.handle.frames) {
				if (this.#closed || this.#cancelled) break;
				for (const frame of decoder.push(raw)) {
					if (this.#closed || this.#cancelled) break;
					if (cleanEndStreamSeen) {
						this.releaseCodec(true);
						throw new CursorTransportError("ProtocolMalformed", "Cursor stream delivered a frame after Connect end-stream.", "stream", this.route);
					}
					if (frame.endStream) {
						try {
							throwIfCursorEndStreamError(frame.data, this.secrets);
						} catch (error) {
							this.releaseCodec(true);
							throw error;
						}
						cleanEndStreamSeen = true;
						continue;
					}
					for (const message of this.codec.decodeRunFrame(frame)) {
						if (this.#closed || this.#cancelled) break;
						const response = this.codec.encodeServerResponse?.(message, this.id);
						if (response) {
							await this.handle.write(encodeCursorConnectFrame(response));
							continue;
						}
						if (!isCursorControlMessage(message)) this.publishOrWithholdMessage(message);
					}
				}
			}
			decoder.finish();
			if (cleanEndStreamSeen) {
				this.#cleanEndStreamValidated = true;
				await this.close();
			}
			else {
				// Let an explicit cancellation issued as soon as run() resolves own the terminal transition.
				await Promise.resolve();
				if (this.#closed || this.#cancelled) return;
				this.releaseCodec(true);
				throw new CursorTransportError("ProtocolMalformed", "Cursor Run stream ended before a Connect end-stream terminal frame.", "stream", this.route);
			}
		} catch (error) {
			const failure = sanitizeCursorTransportError(toError(error), this.secrets, { operation: "stream", route: this.route });
			this.#signalFailure(failure);
			await this.failMessageQueue(failure);
		}
	}

	private async failMessageQueue(error: Error): Promise<void> {
		if (this.#closed) return;
		const notifyCancel = !this.#cancelled;
		this.#cancelled = true;
		this.clearHeartbeat();
		await this.terminateHandle("cancel").catch(() => undefined);
		await this.waitForHeartbeatWrites();
		if (notifyCancel) this.onCancel();
		this.#withheldMessages.length = 0;
		if (!this.#closed) {
			this.#closed = true;
			try {
				// A generic mid-stream transport failure discards continuation state.
				this.releaseCodec(true);
			} finally {
				this.onClose();
			}
		}
		this.finishMessageQueue(error);
	}
	private publishOrWithholdMessage(message: CursorServerMessage): void {
		if (this.#withheldMessages.length > 0
			|| message.type === "done"
			|| (this.#pendingToolResults > 0 && message.type !== "toolCall" && message.type !== "usage")) {
			this.#withheldMessages.push(message);
			return;
		}
		if (message.type === "toolCall") this.#pendingToolResults += 1;
		this.enqueueMessage(message);
	}

	private publishWithheldMessages(cleanTerminal = false): void {
		while (this.#withheldMessages.length > 0) {
			const message = this.#withheldMessages[0];
			if (!message) return;
			if (!cleanTerminal && (message.type === "done"
				|| (this.#pendingToolResults > 0 && message.type !== "toolCall" && message.type !== "usage"))) return;
			this.#withheldMessages.shift();
			if (message.type === "toolCall") this.#pendingToolResults += 1;
			this.enqueueMessage(message);
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
