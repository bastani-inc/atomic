/**
 * User-decision block types.
 *
 * A block is the single way the agent enters a "blocked on the user" state. It
 * is opened with {@link ExtensionAPI.awaitUserDecision} and ends only through
 * the handle that opened it, so no caller can end another caller's block.
 */

/**
 * Why the agent is waiting on a user decision.
 *
 * `workflow_prompt` and `supervisor_ask` are reserved for later phases; nothing
 * in the current host mints them.
 */
export type UserBlockReason = "dialog" | "project_trust" | "workflow_prompt" | "supervisor_ask";

/**
 * A handle for one open user-decision block.
 *
 * The block stays open until {@link UserBlock.release} is called. `release()`
 * is idempotent, so it is safe in a `finally`.
 */
export interface UserBlock {
	/** Process-unique identifier for this block. */
	readonly id: number;
	/** Short label describing what the user is deciding. */
	readonly label: string;
	/** Why the agent is waiting. */
	readonly reason: UserBlockReason;
	/** Whether this block has already been released. */
	readonly released: boolean;
	/** End this block. Idempotent. */
	release(): void;
}

/** Read-only view of one open block. */
export interface UserBlockSnapshot {
	readonly id: number;
	readonly label: string;
	readonly reason: UserBlockReason;
}

/** Fired when a user-decision block opens. */
export interface AgentBlockedEvent {
	type: "agent_blocked";
	/** Identifier of the block that opened. */
	blockId: number;
	/** Short label of the block that opened. */
	label: string;
	/** Why the agent is waiting. */
	reason: UserBlockReason;
	/** Number of blocks open after this one opened (always >= 1). */
	openBlocks: number;
	/** Label of the oldest open block, which is the one the agent is presenting. */
	activeLabel: string;
}

/** Fired when a user-decision block is released. */
export interface AgentUnblockedEvent {
	type: "agent_unblocked";
	/** Identifier of the block that closed. */
	blockId: number;
	/** Short label of the block that closed. */
	label: string;
	/** Why the agent had been waiting. */
	reason: UserBlockReason;
	/** Number of blocks still open after this one closed. */
	openBlocks: number;
	/** Label of the oldest still-open block, or undefined when none remain. */
	activeLabel: string | undefined;
}

/** Change notification delivered to user-block subscribers. */
export type UserBlockChange = AgentBlockedEvent | AgentUnblockedEvent;

/** Subscriber invoked synchronously when a block opens or closes. */
export type UserBlockListener = (change: UserBlockChange) => void;
