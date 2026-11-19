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

/** A stage's turn as a local worker's watch hands it to the root: what {@link StageTurnStart} knows about it. */
export interface StageTurnState {
	/** When the turn's first request started. */
	readonly startedAt: number;
	/** A request of the turn runs. */
	readonly running: boolean;
	/** A retry or a model switch announced the turn's next request. */
	readonly pending: boolean;
	/** The turn's last answer failed: the stage may still move it to its next model. */
	readonly lastAnswerFailed: boolean;
}

/**
 * When the stage's current turn sent its first request, while the turn is under way: a request runs, or a retry or a
 * model switch announced the next one. The stage moves a failed request to its next model in a new session, which
 * holds only the requests since the switch, so a stage chat opened then counts the turn from here, as one that stayed
 * open across the switch does.
 *
 * It reads the stage's events. A turn starts at an `agent_start` that no retry or model switch announced. A retry
 * (`auto_retry_start`), or a model switch after a failed answer (`model_fallback_start`), announces the next request of
 * the same turn. The turn ends with an answer that nothing follows, or when a switch ends without its request
 * (`model_fallback_end`); a retry that ends without one (`auto_retry_end`) still leaves the stage free to move the failed
 * request to its next model. A switch before a turn's first request (no key for the model) announces nothing: that
 * request starts its own turn.
 */
export class StageTurnStart {
	private startedAt: number | undefined;
	/** A request is under way: between an `agent_start` and its `agent_end`. */
	private running = false;
	/** A retry or a model switch announced the next request, which continues the turn. */
	private pending = false;
	private lastAnswerFailed = false;

	/** Take up a turn read elsewhere: a stage on a local worker, as its watch's snapshot hands it over. */
	constructor(state?: StageTurnState) {
		if (state === undefined) return;
		this.startedAt = state.startedAt;
		this.running = state.running;
		this.pending = state.pending;
		this.lastAnswerFailed = state.lastAnswerFailed;
	}

	record(event: AgentSessionEvent, now = Date.now()): void {
		switch (event.type) {
			case "agent_start":
				if (!this.pending) this.startedAt = event.turnStartedAt ?? now;
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
				// The session stops retrying. The stage may still move the failed request to its next model.
				if (!event.success) this.pending = false;
				return;
			case "model_fallback_end":
				// The switch ends without its next request: the turn is over, and nothing after it continues it.
				if (event.success) return;
				this.pending = false;
				this.lastAnswerFailed = false;
				return;
		}
	}

	/** When the turn under way sent its first request; undefined between turns. */
	turnStartedAt(): number | undefined {
		return this.running || this.pending ? this.startedAt : undefined;
	}

	/**
	 * The turn, while it may still go on: under way, or ended on a failed answer the stage may yet move to its next
	 * model. Undefined otherwise.
	 */
	state(): StageTurnState | undefined {
		if (this.startedAt === undefined || !(this.running || this.pending || this.lastAnswerFailed)) return undefined;
		return {
			startedAt: this.startedAt,
			running: this.running,
			pending: this.pending,
			lastAnswerFailed: this.lastAnswerFailed,
		};
	}
}
