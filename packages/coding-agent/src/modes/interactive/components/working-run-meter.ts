export interface WorkingRunSnapshot {
	readonly elapsedMs: number;
	readonly outputTokens: number;
	readonly note?: string;
}

export interface MeteredMessage {
	readonly role: string;
	readonly usage?: { readonly output?: number } | undefined;
	readonly content?: readonly unknown[] | string;
}

const completedArgumentLengths = new WeakMap<object, number>();

function serializedArgumentsLength(args: unknown, completed: boolean): number {
	if (typeof args !== "object" || args === null) {
		return JSON.stringify(args)?.length ?? 0;
	}
	const cached = completedArgumentLengths.get(args);
	if (cached !== undefined) return cached;
	const length = JSON.stringify(args)?.length ?? 0;
	if (completed) completedArgumentLengths.set(args, length);
	return length;
}

export function estimatedOutputTokens(message: MeteredMessage, streaming = false): number {
	const content = message.content;
	if (typeof content === "string") return Math.ceil(content.length / 4);
	const blocks = content ?? [];
	let characters = 0;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (typeof block !== "object" || block === null) continue;
		const part = block as { text?: unknown; thinking?: unknown; arguments?: unknown };
		if (typeof part.text === "string") characters += part.text.length;
		if (typeof part.thinking === "string") characters += part.thinking.length;
		if (part.arguments !== undefined) {
			characters += serializedArgumentsLength(part.arguments, !streaming || i < blocks.length - 1);
		}
	}
	return Math.ceil(characters / 4);
}

export function meteredOutputTokens(message: MeteredMessage, streaming = false): number {
	const reported = message.usage?.output;
	const known = typeof reported === "number" && reported > 0 ? reported : 0;
	if (known > 0 && !streaming) return known;
	return Math.max(known, estimatedOutputTokens(message, streaming));
}

export class WorkingRunMeter {
	private startedAt: number | undefined;
	private settledTokens = 0;
	private streamingMessage: MeteredMessage | undefined;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	start(): void {
		this.startedAt = this.now();
		this.settledTokens = 0;
		this.streamingMessage = undefined;
	}

	streaming(message: MeteredMessage): void {
		if (message.role !== "assistant") return;
		this.streamingMessage = message;
	}

	settled(message: MeteredMessage): void {
		if (message.role !== "assistant") return;
		this.settledTokens += meteredOutputTokens(message);
		this.streamingMessage = undefined;
	}

	stop(): void {
		this.startedAt = undefined;
		this.streamingMessage = undefined;
	}

	snapshot(): WorkingRunSnapshot | undefined {
		if (this.startedAt === undefined) return undefined;
		const streamingTokens = this.streamingMessage ? meteredOutputTokens(this.streamingMessage, true) : 0;
		return {
			elapsedMs: Math.max(0, this.now() - this.startedAt),
			outputTokens: this.settledTokens + streamingTokens,
		};
	}
}

export function formatWorkingElapsed(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatWorkingTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 999_500) return `${(tokens / 1000).toFixed(tokens < 99_950 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(tokens < 99_950_000 ? 1 : 0)}M`;
}

export function formatWorkingMeta(snapshot: WorkingRunSnapshot): string {
	if (snapshot.elapsedMs < 1000 && snapshot.outputTokens <= 0 && !snapshot.note) return "";
	const parts = [formatWorkingElapsed(snapshot.elapsedMs)];
	if (snapshot.outputTokens > 0) parts.push(`↓ ${formatWorkingTokens(snapshot.outputTokens)} tokens`);
	if (snapshot.note) parts.push(snapshot.note);
	return parts.join(" · ");
}

export function compactionMeta(startedAt: number, cancelKey: string | undefined, now = Date.now()): WorkingRunSnapshot {
	return {
		elapsedMs: Math.max(0, now - startedAt),
		outputTokens: 0,
		...(cancelKey ? { note: `${cancelKey} to cancel` } : {}),
	};
}
