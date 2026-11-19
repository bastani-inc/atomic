import { clickableKeyTextHint } from "./nav-keys.ts";
import { formatTokenSegment } from "./token-segment.ts";

export interface WorkingRunSnapshot {
	readonly elapsedMs: number;
	readonly tokens: number;
	readonly requesting?: boolean;
	readonly note?: string;
}

export interface LegacyWorkingRunSnapshot {
	readonly elapsedMs: number;
	readonly outputTokens: number;
	readonly requesting?: boolean;
	readonly note?: string;
}

export type WorkingRunMetaInput = WorkingRunSnapshot | LegacyWorkingRunSnapshot;

export function normalizeWorkingRunSnapshot(meta: WorkingRunMetaInput): WorkingRunSnapshot {
	if ("tokens" in meta && typeof meta.tokens === "number") {
		return meta;
	}
	const legacy = meta as LegacyWorkingRunSnapshot;
	return {
		elapsedMs: legacy.elapsedMs,
		tokens: legacy.outputTokens,
		...(legacy.requesting === undefined ? {} : { requesting: legacy.requesting }),
		...(legacy.note === undefined ? {} : { note: legacy.note }),
	};
}

export interface MeteredMessage {
	readonly role: string;
	readonly stopReason?: string;
	readonly usage?:
		| {
				readonly input?: number;
				readonly output?: number;
				readonly cacheRead?: number;
				readonly cacheWrite?: number;
		  }
		| undefined;
	readonly content?: readonly unknown[] | string;
}

export interface MeteredRunMessage extends MeteredMessage {
	readonly timestamp?: number;
	readonly stopReason?: string;
}

const RUN_CONTINUING_STOP_REASONS: ReadonlySet<string> = new Set(["toolUse", "pending", "deferred"]);

export function runInProgress(
	messages: readonly MeteredRunMessage[],
	streaming?: MeteredRunMessage,
): { readonly startedAt: number | undefined; readonly settledTokens: number; readonly requesting: boolean } {
	let start = messages.length;
	while (start > 0) {
		const message = messages[start - 1]!;
		if (
			message.role === "assistant" &&
			message.stopReason !== undefined &&
			!RUN_CONTINUING_STOP_REASONS.has(message.stopReason)
		)
			break;
		start -= 1;
	}
	let startedAt: number | undefined;
	let settledTokens = 0;
	for (const message of messages.slice(start)) {
		if (startedAt === undefined && isTimestamp(message.timestamp)) startedAt = message.timestamp;
		if (message.role === "assistant") settledTokens += meteredOutputTokens(message);
	}
	if (startedAt === undefined && isTimestamp(streaming?.timestamp)) startedAt = streaming.timestamp;
	const last = messages.at(-1);
	const requesting =
		!hasContent(streaming) && start < messages.length && (last?.role === "user" || last?.role === "toolResult");
	return { startedAt, settledTokens, requesting };
}

function isTimestamp(value: number | undefined): value is number {
	return typeof value === "number" && value > 0;
}

function hasContent(message: MeteredMessage | undefined): boolean {
	const content = message?.content;
	if (typeof content === "string") return content.length > 0;
	return (content ?? []).some((block) => {
		if (typeof block !== "object" || block === null) return false;
		if ("type" in block && block.type === "toolCall") return true;
		return (
			("text" in block && typeof block.text === "string" && block.text.length > 0) ||
			("thinking" in block && typeof block.thinking === "string" && block.thinking.length > 0)
		);
	});
}

export class AgentTokenMeter {
	private outputTokens = 0;
	private latestInputTokens = 0;

	constructor(messages: readonly MeteredMessage[] = []) {
		for (const message of messages) this.settled(message);
	}

	settled(message: MeteredMessage): void {
		if (message.role !== "assistant") return;
		this.outputTokens += meteredOutputTokens(message);
		const usage = message.usage;
		if (usage && (usage.input !== undefined || usage.cacheRead !== undefined || usage.cacheWrite !== undefined)) {
			const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			const unbilledAbort = message.stopReason === "aborted" && inputTokens === 0 && (usage.output ?? 0) === 0;
			if (!unbilledAbort) this.latestInputTokens = inputTokens;
		}
	}

	total(streaming?: MeteredMessage): number {
		const live = streaming?.role === "assistant" ? meteredOutputTokens(streaming, true) : 0;
		return this.latestInputTokens + this.outputTokens + live;
	}
}

export function agentTokenTotal(messages: readonly MeteredMessage[], streaming?: MeteredMessage): number {
	return new AgentTokenMeter(messages).total(streaming);
}

const serializedArgumentLengths = new WeakMap<object, number>();

function serializedArgumentsLength(args: unknown): number {
	if (typeof args !== "object" || args === null) {
		return JSON.stringify(args)?.length ?? 0;
	}
	const cached = serializedArgumentLengths.get(args);
	if (cached !== undefined) return cached;
	const length = JSON.stringify(args)?.length ?? 0;
	serializedArgumentLengths.set(args, length);
	return length;
}

export function estimatedOutputTokens(message: MeteredMessage): number {
	const content = message.content;
	if (typeof content === "string") return Math.ceil(content.length / 4);
	let characters = 0;
	for (const block of content ?? []) {
		if (typeof block !== "object" || block === null) continue;
		const part = block as { text?: unknown; thinking?: unknown; arguments?: unknown };
		if (typeof part.text === "string") characters += part.text.length;
		if (typeof part.thinking === "string") characters += part.thinking.length;
		if (part.arguments !== undefined) {
			characters += serializedArgumentsLength(part.arguments);
		}
	}
	return Math.ceil(characters / 4);
}

export function meteredOutputTokens(message: MeteredMessage, streaming = false): number {
	const reported = message.usage?.output;
	const known = typeof reported === "number" && reported > 0 ? reported : 0;
	if (known > 0 && !streaming) return known;
	return Math.max(known, estimatedOutputTokens(message));
}

export class WorkingRunMeter {
	private startedAt: number | undefined;
	private settledTokens = 0;
	private streamingMessage: MeteredMessage | undefined;
	private cachedStreamingTokens: number | undefined;
	private requesting = false;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	start(): void {
		this.startedAt = this.now();
		this.settledTokens = 0;
		this.streamingMessage = undefined;
		this.cachedStreamingTokens = 0;
		this.requesting = false;
	}

	requestStarted(): void {
		this.requesting = true;
	}

	streaming(message: MeteredMessage): void {
		if (message.role !== "assistant") return;
		this.streamingMessage = message;
		this.cachedStreamingTokens = undefined;
		if (hasContent(message)) this.requesting = false;
	}

	settled(message: MeteredMessage): void {
		if (message.role !== "assistant") return;
		this.settledTokens += meteredOutputTokens(message);
		this.streamingMessage = undefined;
		this.cachedStreamingTokens = 0;
		this.requesting = false;
	}

	resume(startedAt: number | undefined, settledTokens: number, requesting = false): void {
		this.startedAt = Math.min(startedAt ?? this.now(), this.now());
		this.settledTokens = settledTokens;
		this.streamingMessage = undefined;
		this.cachedStreamingTokens = 0;
		this.requesting = requesting;
	}

	stop(): void {
		this.startedAt = undefined;
		this.streamingMessage = undefined;
		this.cachedStreamingTokens = undefined;
	}

	snapshot(): WorkingRunSnapshot | undefined {
		if (this.startedAt === undefined) return undefined;
		if (this.cachedStreamingTokens === undefined) {
			this.cachedStreamingTokens = this.streamingMessage ? meteredOutputTokens(this.streamingMessage, true) : 0;
		}
		return {
			elapsedMs: Math.max(0, this.now() - this.startedAt),
			tokens: this.settledTokens + this.cachedStreamingTokens,
			...(this.requesting ? { requesting: true } : {}),
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
	if (tokens < 999_500_000) return `${(tokens / 1_000_000).toFixed(tokens < 99_950_000 ? 1 : 0)}M`;
	return `${(tokens / 1_000_000_000).toFixed(tokens < 99_950_000_000 ? 1 : 0)}B`;
}

export function formatWorkingMeta(input: WorkingRunMetaInput): string {
	const snapshot = normalizeWorkingRunSnapshot(input);
	if (snapshot.elapsedMs < 1000 && snapshot.tokens <= 0 && !snapshot.note) return "";
	const parts = [formatWorkingElapsed(snapshot.elapsedMs)];
	const tokens = formatTokenSegment({
		mode: snapshot.requesting ? "requesting" : "receiving",
		count: snapshot.tokens,
	});
	if (tokens) parts.push(tokens);
	if (snapshot.note) parts.push(snapshot.note);
	return parts.join(" · ");
}

export function compactionMeta(startedAt: number, cancelKey: string | undefined, now = Date.now()): WorkingRunSnapshot {
	return {
		elapsedMs: Math.max(0, now - startedAt),
		tokens: 0,
		...(cancelKey ? { note: clickableKeyTextHint(cancelKey, " to cancel") } : {}),
	};
}
