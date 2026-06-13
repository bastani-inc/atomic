import type { CursorAgentTransport, CursorRunRequest, CursorRunStream, CursorServerMessage, CursorToolResultMessage } from "../../packages/cursor/src/transport.js";
import type { CursorUsableModel } from "../../packages/cursor/src/model-mapper.js";

export class CursorMockRunStream implements CursorRunStream {
	readonly id: string;
	readonly messages: AsyncIterable<CursorServerMessage>;
	#onCancel: () => void;
	#onClose: () => void;
	#cancelled = false;
	#closed = false;
	readonly writtenToolResults: CursorToolResultMessage[] = [];

	constructor(id: string, messages: AsyncIterable<CursorServerMessage>, onCancel: () => void, onClose: () => void) {
		this.id = id;
		this.messages = messages;
		this.#onCancel = onCancel;
		this.#onClose = onClose;
	}

	get cancelled(): boolean {
		return this.#cancelled;
	}

	get closed(): boolean {
		return this.#closed;
	}

	async writeToolResult(result: CursorToolResultMessage): Promise<void> {
		this.writtenToolResults.push(result);
	}

	async cancel(): Promise<void> {
		if (this.#cancelled) return;
		this.#cancelled = true;
		this.#onCancel();
		if (!this.#closed) {
			this.#closed = true;
			this.#onClose();
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose();
	}
}

export interface CursorMockTransportRun {
	readonly request: CursorRunRequest;
	readonly stream: CursorMockRunStream;
}

export class CursorMockTransport implements CursorAgentTransport {
	readonly runs: CursorMockTransportRun[] = [];
	readonly modelRequests: string[] = [];
	#models: readonly CursorUsableModel[];
	#messages: readonly CursorServerMessage[];
	#openStreams = 0;
	#cancelledStreams = 0;
	#closedStreams = 0;

	constructor(options: { readonly models?: readonly CursorUsableModel[]; readonly messages?: readonly CursorServerMessage[] } = {}) {
		this.#models = options.models ?? [];
		this.#messages = options.messages ?? [];
	}

	setMessages(messages: readonly CursorServerMessage[]): void {
		this.#messages = messages;
	}

	async getUsableModels(accessToken: string, requestId: string, signal?: AbortSignal): Promise<readonly CursorUsableModel[]> {
		if (signal?.aborted) throw new Error("Cursor mock model discovery aborted");
		this.modelRequests.push(`${requestId}:${accessToken.length}`);
		return this.#models;
	}

	async run(request: CursorRunRequest): Promise<CursorRunStream> {
		if (request.signal?.aborted) throw new Error("Cursor mock stream aborted");
		this.#openStreams += 1;
		const stream = new CursorMockRunStream(
			request.requestId,
			this.createMessageIterable(),
			() => {
				this.#cancelledStreams += 1;
			},
			() => {
				this.#closedStreams += 1;
				this.#openStreams = Math.max(0, this.#openStreams - 1);
			},
		);
		this.runs.push({ request, stream });
		return stream;
	}

	async dispose(): Promise<void> {
		for (const run of this.runs) {
			await run.stream.cancel();
		}
	}

	getLifecycleSnapshot() {
		return { openStreams: this.#openStreams, cancelledStreams: this.#cancelledStreams, closedStreams: this.#closedStreams };
	}

	private async *createMessageIterable(): AsyncIterable<CursorServerMessage> {
		// Each item is yielded independently so tests can model tool calls split
		// across Connect frame/message boundaries.
		for (const message of this.#messages) {
			yield message;
		}
	}
}
