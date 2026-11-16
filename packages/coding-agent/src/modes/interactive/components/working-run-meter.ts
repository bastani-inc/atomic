/** What a working line reports about the run it belongs to. */
export interface WorkingRunSnapshot {
	readonly elapsedMs: number;
	readonly outputTokens: number;
	/** A short note after the time, such as `esc to cancel`. */
	readonly note?: string;
}

/** The parts of an assistant message the meter reads: its usage once known, its content while it streams. */
export interface MeteredMessage {
	readonly role: string;
	readonly usage?: { readonly output?: number } | undefined;
	readonly content?: readonly unknown[] | string;
}

/** Output tokens a message's content amounts to, at about four characters per token. */
export function estimatedOutputTokens(message: MeteredMessage): number {
	const content = message.content;
	if (typeof content === "string") return Math.ceil(content.length / 4);
	let characters = 0;
	for (const block of content ?? []) {
		if (typeof block !== "object" || block === null) continue;
		const part = block as { text?: unknown; thinking?: unknown; arguments?: unknown };
		if (typeof part.text === "string") characters += part.text.length;
		if (typeof part.thinking === "string") characters += part.thinking.length;
		if (part.arguments !== undefined) characters += JSON.stringify(part.arguments)?.length ?? 0;
	}
	return Math.ceil(characters / 4);
}

/**
 * Output tokens of a message. A finished message reports its usage; a streaming one may report only what the provider
 * counted when it started, so it counts as the larger of that and its estimate.
 */
export function meteredOutputTokens(message: MeteredMessage, streaming = false): number {
	const reported = message.usage?.output;
	const known = typeof reported === "number" && reported > 0 ? reported : 0;
	if (known > 0 && !streaming) return known;
	return Math.max(known, estimatedOutputTokens(message));
}

/**
 * Counts one run of the agent for its working line: the time since the run started and the output tokens its
 * assistant messages produced, the finished ones by their reported usage and the one streaming now by its estimate.
 */
export class WorkingRunMeter {
	private startedAt: number | undefined;
	private settledTokens = 0;
	private streamingTokens = 0;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** A new run starts: time and tokens count from zero. */
	start(): void {
		this.startedAt = this.now();
		this.settledTokens = 0;
		this.streamingTokens = 0;
	}

	/** The assistant message being streamed changed. */
	streaming(message: MeteredMessage): void {
		if (message.role !== "assistant") return;
		this.streamingTokens = meteredOutputTokens(message, true);
	}

	/** An assistant message finished; its usage replaces its estimate. */
	settled(message: MeteredMessage): void {
		if (message.role !== "assistant") return;
		this.settledTokens += meteredOutputTokens(message);
		this.streamingTokens = 0;
	}

	/** The run ended; nothing is reported until the next one starts. */
	stop(): void {
		this.startedAt = undefined;
	}

	snapshot(): WorkingRunSnapshot | undefined {
		if (this.startedAt === undefined) return undefined;
		return {
			elapsedMs: Math.max(0, this.now() - this.startedAt),
			outputTokens: this.settledTokens + this.streamingTokens,
		};
	}
}

/** `3s`, `2m 14s`, `1h 5m`. */
export function formatWorkingElapsed(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `950`, `18.4k`, `1.2M`. */
export function formatWorkingTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** The parenthesised part of a working line: `2m 14s · ↓ 18.4k tokens`, or only the time before any token. */
export function formatWorkingMeta(snapshot: WorkingRunSnapshot): string {
	const parts = [formatWorkingElapsed(snapshot.elapsedMs)];
	if (snapshot.outputTokens > 0) parts.push(`↓ ${formatWorkingTokens(snapshot.outputTokens)} tokens`);
	if (snapshot.note) parts.push(snapshot.note);
	return parts.join(" · ");
}

/** A compaction's status after its message: how long it has run and the key that cancels it. */
export function compactionMeta(startedAt: number, cancelKey: string | undefined, now = Date.now()): WorkingRunSnapshot {
	return {
		elapsedMs: Math.max(0, now - startedAt),
		outputTokens: 0,
		...(cancelKey ? { note: `${cancelKey} to cancel` } : {}),
	};
}
