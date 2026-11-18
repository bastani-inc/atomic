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

/** An answer a turn goes on from with a retry or another model: a failed request, or an empty completion. */
function isFailedAnswer(message: AnswerLike): boolean {
	if (message.stopReason === "error") return true;
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return false;
	const content = message.content;
	if (typeof content === "string") return content.trim().length === 0;
	return !Array.isArray(content) || !content.some((block) => isContentBlock(block) && blockHasContent(block));
}

/**
 * When the stage's current turn sent its first request, while the turn is under way: a request runs, or a retry or a
 * model switch announced the next one. The stage moves a failed request to its next model in a new session, which
 * holds only the requests since the switch, so a stage chat opened then counts the turn from here, as one that stayed
 * open across the switch does.
 *
 * It reads the stage's events. A turn starts at an `agent_start` that no retry or model switch announced. A retry
 * (`auto_retry_start`), or a model switch after a failed answer (`model_fallback_start`), announces the next request of
 * the same turn; the turn ends with a request that nothing follows, or when the retry or switch ends without one
 * (`auto_retry_end`, `model_fallback_end`). A switch before a turn's first request (no key for the model) announces
 * nothing: that request starts its own turn.
 */
export class StageTurnStart {
	private startedAt: number | undefined;
	/** A request is under way: between an `agent_start` and its `agent_end`. */
	private running = false;
	/** A retry or a model switch announced the next request, which continues the turn. */
	private pending = false;
	private lastAnswerFailed = false;

	/**
	 * Take up a turn read elsewhere (a stage on a local worker): one under way since `turnStartedAt`, with a request
	 * running when `streaming`, and its next one announced otherwise.
	 */
	constructor(turnStartedAt?: number, streaming = false) {
		if (turnStartedAt === undefined) return;
		this.startedAt = turnStartedAt;
		this.running = streaming;
		this.pending = !streaming;
	}

	record(event: AgentSessionEvent, now = Date.now()): void {
		switch (event.type) {
			case "agent_start":
				if (!this.pending) this.startedAt = now;
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
				if (this.startedAt !== undefined && this.lastAnswerFailed && !this.running) this.pending = true;
				return;
			case "auto_retry_end":
			case "model_fallback_end":
				if (!event.success) this.pending = false;
				return;
		}
	}

	/** When the turn under way sent its first request; undefined between turns. */
	turnStartedAt(): number | undefined {
		return this.running || this.pending ? this.startedAt : undefined;
	}
}
