import type { AgentSessionEvent } from "@bastani/atomic";

interface AnswerLike {
	readonly role?: string;
	readonly stopReason?: string;
	readonly content?: unknown;
}

interface ContentBlockLike {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly thinking?: unknown;
}

function isContentBlock(block: unknown): block is ContentBlockLike {
	return typeof block === "object" && block !== null;
}

function blockHasContent(block: ContentBlockLike): boolean {
	if (block.type === "toolCall") return true;
	return (
		(typeof block.text === "string" && block.text.trim().length > 0) ||
		(typeof block.thinking === "string" && block.thinking.trim().length > 0)
	);
}

/** An answer a turn goes on from with a retry or another model: a failed request, or a completion that came back empty. */
function isFailedAnswer(message: AnswerLike): boolean {
	if (message.stopReason === "error") return true;
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return false;
	const content = message.content;
	if (typeof content === "string") return content.trim().length === 0;
	return !Array.isArray(content) || !content.some((block) => isContentBlock(block) && blockHasContent(block));
}

/**
 * When the stage's current turn sent its first request, while the turn goes on in another session than that request's:
 * the stage moves a failed request to its next model in a new session, which holds only the requests since the switch.
 * A stage chat opened then counts the turn from here, as one that stayed open across the switch does.
 *
 * It reads the stage's events. A turn starts at an `agent_start` that no retry or model switch announced. A model
 * switch after a failed answer (`model_fallback_start`) continues it in the next session, through that session's own
 * retries, until a new turn starts or the turn ends without its next request (`model_fallback_end`,
 * `auto_retry_end`). A switch before a turn's first request (no key for the model) continues nothing.
 */
export class StageTurnStart {
	private startedAt: number | undefined;
	/** A request is under way: between an `agent_start` and its `agent_end`. */
	private running = false;
	/** A retry or a model switch announced the next request, which continues the turn. */
	private pending = false;
	/** The turn went on in another session after a model switch. */
	private continued = false;
	private lastAnswerFailed = false;

	/**
	 * Take up a turn read elsewhere (a stage on a local worker): one that went on after a model switch and started at
	 * `continuedFrom`, with a request under way when `streaming`, and its next one announced otherwise.
	 */
	constructor(continuedFrom?: number, streaming = false) {
		if (continuedFrom === undefined) return;
		this.startedAt = continuedFrom;
		this.continued = true;
		this.running = streaming;
		this.pending = !streaming;
	}

	record(event: AgentSessionEvent, now = Date.now()): void {
		switch (event.type) {
			case "agent_start":
				if (!this.pending) {
					this.startedAt = now;
					this.continued = false;
				}
				this.running = true;
				this.pending = false;
				this.lastAnswerFailed = false;
				return;
			case "message_end":
				if (event.message.role === "assistant") this.lastAnswerFailed = isFailedAnswer(event.message);
				return;
			case "agent_end":
				this.running = false;
				return;
			case "auto_retry_start":
				this.pending = this.startedAt !== undefined;
				return;
			case "model_fallback_start":
				if (this.startedAt === undefined || !this.lastAnswerFailed) return;
				this.pending = true;
				this.continued = true;
				return;
			case "auto_retry_end":
			case "model_fallback_end":
				if (event.success) return;
				this.pending = false;
				this.continued = false;
				return;
		}
	}

	/**
	 * When the turn's first request started, while the turn goes on after a model switch: during a request, or while the
	 * next one is announced. Undefined for a turn that stayed in its session, and between turns.
	 */
	continuedTurnStartedAt(): number | undefined {
		return this.continued && (this.running || this.pending) ? this.startedAt : undefined;
	}
}
