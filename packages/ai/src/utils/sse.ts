/** One dispatched Server-Sent Event: its `event` field, its `data` lines joined by "\n", and the raw field lines. */
export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

/**
 * Incremental Server-Sent Events decoder that yields the same events however the byte stream is chunked.
 *
 * Lines end with CRLF, LF, or a lone CR. A CR at the end of a chunk is held until the next chunk (or the end of
 * the stream) shows whether an LF follows, so a CRLF split across chunks is one line ending, not a line ending
 * plus an empty line. Bytes are decoded in streaming mode, so a multibyte character split across chunks is kept
 * whole. An event pending at the end of the stream is dispatched.
 */
export class ServerSentEventDecoder {
	private readonly textDecoder = new TextDecoder();
	private buffer = "";
	private event: string | null = null;
	private data: string[] = [];
	private raw: string[] = [];

	/** Decodes one chunk of the stream and returns the events it completed. */
	decode(chunk: Uint8Array): ServerSentEvent[] {
		this.buffer += this.textDecoder.decode(chunk, { stream: true });
		return this.consumeLines(false);
	}

	/** Ends the stream and returns the events still pending in it. */
	end(): ServerSentEvent[] {
		this.buffer += this.textDecoder.decode();
		const events = this.consumeLines(true);
		this.decodeLine(this.buffer, events);
		this.dispatch(events);
		return events;
	}

	private consumeLines(final: boolean): ServerSentEvent[] {
		const events: ServerSentEvent[] = [];
		const text = this.buffer;
		let start = 0;
		for (const lineBreak of text.matchAll(/\r\n|\r|\n/g)) {
			if (lineBreak[0] === "\r" && lineBreak.index + 1 === text.length && !final) break;
			this.decodeLine(text.slice(start, lineBreak.index), events);
			start = lineBreak.index + lineBreak[0].length;
		}
		this.buffer = text.slice(start);
		return events;
	}

	private decodeLine(line: string, events: ServerSentEvent[]): void {
		if (line === "") {
			this.dispatch(events);
			return;
		}

		// A comment line (":...") has an empty field name, which is ignored like any unknown field.
		this.raw.push(line);
		const delimiterIndex = line.indexOf(":");
		const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
		let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
		if (value.startsWith(" ")) value = value.slice(1);

		if (fieldName === "event") {
			this.event = value;
		} else if (fieldName === "data") {
			this.data.push(value);
		}
	}

	private dispatch(events: ServerSentEvent[]): void {
		if (!this.event && this.data.length === 0) {
			// Comment-only blocks carry nothing to dispatch.
			this.event = null;
			this.raw = [];
			return;
		}
		events.push({ event: this.event, data: this.data.join("\n"), raw: this.raw });
		this.event = null;
		this.data = [];
		this.raw = [];
	}
}

const CR = 0x0d;
const LF = 0x0a;
const DONE_LINES = ["data: [DONE]", "data:[DONE]"].map((line) => new TextEncoder().encode(line));
const DATA_FIELD = new TextEncoder().encode("data");
const COLON = 0x3a;
/** The longest line that can be a `[DONE]` data line; only that much of each line is kept. */
const KEPT_LINE_BYTES = Math.max(...DONE_LINES.map((line) => line.length));

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
	return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * Finds the `data: [DONE]` event of a Server-Sent Events stream as `ServerSentEventDecoder` would decode it: an event
 * whose only data line is `[DONE]`. Keeps at most the first bytes of each line, so a long event costs one pass.
 */
class DoneEventScanner {
	found = false;
	readonly #line = new Uint8Array(KEPT_LINE_BYTES);
	#lineLength = 0;
	/** The previous chunk ended with CR, so an LF that starts this one ends the same line. */
	#afterCR = false;
	#dataLines = 0;
	#doneData = false;

	push(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		let start = this.#afterCR && chunk[0] === LF ? 1 : 0;
		this.#afterCR = false;
		let nextCR = chunk.indexOf(CR, start);
		let nextLF = chunk.indexOf(LF, start);
		while (start < chunk.length && !this.found) {
			if (nextCR !== -1 && nextCR < start) nextCR = chunk.indexOf(CR, start);
			if (nextLF !== -1 && nextLF < start) nextLF = chunk.indexOf(LF, start);
			const end = nextCR === -1 ? nextLF : nextLF === -1 ? nextCR : Math.min(nextCR, nextLF);
			if (end === -1) {
				this.#keep(chunk, start, chunk.length);
				return;
			}
			this.#keep(chunk, start, end);
			this.#endLine();
			start = end + 1;
			if (chunk[end] === CR) {
				if (start === chunk.length) this.#afterCR = true;
				else if (chunk[start] === LF) start += 1;
			}
		}
	}

	/** The stream ended: a pending line and event are dispatched, as the SDK does. */
	end(): void {
		if (this.#lineLength > 0) this.#endLine();
		this.#endLine();
	}

	#keep(chunk: Uint8Array, start: number, end: number): void {
		const room = KEPT_LINE_BYTES - this.#lineLength;
		if (room > 0) this.#line.set(chunk.subarray(start, Math.min(end, start + room)), this.#lineLength);
		this.#lineLength += end - start;
	}

	#endLine(): void {
		const length = this.#lineLength;
		this.#lineLength = 0;
		if (length === 0) {
			if (this.#dataLines === 1 && this.#doneData) this.found = true;
			this.#dataLines = 0;
			this.#doneData = false;
			return;
		}
		const kept = this.#line.subarray(0, Math.min(length, KEPT_LINE_BYTES));
		const isData =
			startsWith(kept, DATA_FIELD) && (length === DATA_FIELD.length || kept[DATA_FIELD.length] === COLON);
		if (!isData) return;
		this.#dataLines += 1;
		this.#doneData = DONE_LINES.some((line) => line.length === length && startsWith(kept, line));
	}
}

/**
 * Watches streamed responses for the `data: [DONE]` event that ends a complete Chat Completions stream, which the
 * OpenAI SDK consumes without passing on. A stream that is cut off never delivers it. Bodies pass through unchanged.
 */
export class DoneEventWatch {
	#received = false;

	/** Whether the body of the latest response delivered `[DONE]`. */
	get received(): boolean {
		return this.#received;
	}

	/** `send`, with the body of each successful response watched. Each request starts with nothing received. */
	watch(send: typeof globalThis.fetch): typeof globalThis.fetch {
		return Object.assign(async (...args: Parameters<typeof globalThis.fetch>) => {
			this.#received = false;
			return this.#watchBody(await send(...args));
		}, send);
	}

	#watchBody(response: Response): Response {
		if (!response.ok || !response.body) return response;
		const scanner = new DoneEventScanner();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		// The body is locked only once it is read, and these callbacks hold `response` itself: a response nobody reads
		// is collected with its body unlocked, which lets the runtime release its connection.
		const body = new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					reader ??= response.body!.getReader();
					const { done, value } = await reader.read();
					if (done) {
						if (!scanner.found) scanner.end();
						this.#received ||= scanner.found;
						controller.close();
						return;
					}
					if (!scanner.found) scanner.push(value);
					this.#received ||= scanner.found;
					controller.enqueue(value);
				},
				cancel: (reason) => (reader ? reader.cancel(reason) : response.body?.cancel(reason)),
			},
			{ highWaterMark: 0 },
		);
		const watched = new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		Object.defineProperty(watched, "url", { value: response.url });
		return watched;
	}
}
