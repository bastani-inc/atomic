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
		const decoder = new ServerSentEventDecoder();
		const see = (events: readonly ServerSentEvent[]): void => {
			if (events.some((event) => event.data === "[DONE]")) this.#received = true;
		};
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform: (chunk, controller) => {
					if (!this.#received) see(decoder.decode(chunk));
					controller.enqueue(chunk);
				},
				// Like the SDK, an event the stream ends without its blank line still counts.
				flush: () => {
					if (!this.#received) see(decoder.end());
				},
			}),
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}
}
