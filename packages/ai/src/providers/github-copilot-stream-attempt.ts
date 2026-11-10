/** What one GitHub Copilot streaming request observed, read when it fails after Copilot answered with HTTP success. */
export interface GitHubCopilotStreamSnapshot {
	/** The response's `x-request-id`, when Copilot sent one. */
	readonly requestId?: string;
	/** Milliseconds from sending the request to the failure. */
	readonly durationMs: number;
	/** Whether any provider stream event had arrived: a message start, a content block, a delta or a chunk. */
	readonly startedContent: boolean;
}

/**
 * Watches one streaming request to GitHub Copilot so a stream that ends early can say how long it ran, whether the
 * response had started, and which request it was. An adapter calls `begin()` each time it sends the request, `respond()`
 * with the HTTP success response's headers, and reads each provider event through `observe()`.
 */
export class GitHubCopilotStreamAttempt {
	readonly #now: () => number;
	#startedAt = 0;
	#requestId: string | undefined;
	#responded = false;
	#eventArrived = false;

	constructor(now: () => number = () => performance.now()) {
		this.#now = now;
	}

	/** The request is being sent. Anything observed for an earlier send is forgotten. */
	begin(): void {
		this.#startedAt = this.#now();
		this.#requestId = undefined;
		this.#responded = false;
		this.#eventArrived = false;
	}

	/** Copilot answered with HTTP success. */
	respond(headers: Headers): void {
		this.#requestId = headers.get("x-request-id") || undefined;
		this.#responded = true;
	}

	/** Pass every item of the provider's stream through, noting that the response has started. */
	async *observe<T>(source: AsyncIterable<T>): AsyncGenerator<T, void, undefined> {
		for await (const item of source) {
			this.#eventArrived = true;
			yield item;
		}
	}

	/** What the request observed so far; undefined until Copilot has answered with HTTP success. */
	snapshot(): GitHubCopilotStreamSnapshot | undefined {
		if (!this.#responded) return undefined;
		return {
			...(this.#requestId === undefined ? {} : { requestId: this.#requestId }),
			durationMs: Math.max(0, Math.round(this.#now() - this.#startedAt)),
			startedContent: this.#eventArrived,
		};
	}
}
