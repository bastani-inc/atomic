import type { Component } from "@bastani/atomic-tui";
import type { QueuedMessageReceipt } from "../../../core/queued-message-delivery.ts";
import type { TaskId } from "../../../core/tasks/contracts.js";
import type { QueuedTaskMessages } from "../../../core/tasks/supervisor.js";
import type { TaskViewResult } from "../../../core/tasks/task-view-source.js";
import type { SteeringQueueLists, SteeringTarget } from "../steering-queue-controller.ts";

/**
 * The single chat screen shows the main chat or one subagent. While it shows a subagent, its transcript takes the
 * transcript area and the main prompt is retargeted to it; the agent panel and `/tasks` stay as they are.
 */

/** What the screen shows: the main chat, or one subagent through its port. */
export type ViewedTarget = { readonly kind: "main" } | { readonly kind: "agent"; readonly port: AgentViewPort };

export const VIEWING_MAIN: ViewedTarget = Object.freeze({ kind: "main" });

export type AgentViewState =
	| "running"
	| "queued"
	| "input"
	| "paused"
	| "stopping"
	| "waiting"
	| "done"
	| "failed"
	| "stopped";

/** A viewed subagent as the prompt, its rule, the footer and the panel show it. Plain data: it crosses the engine. */
export interface AgentViewStatus {
	/** The attempt messages go to now: the latest one, which a resume moves. */
	readonly taskId: TaskId;
	/** The subagent across resumes: its first attempt's task id. Per-agent prompt state is keyed by it. */
	readonly agentKey: string;
	/** The subagent's own session id, when known: identifies the same child conversation across engine restarts. */
	readonly sessionId?: string;
	/** The file the subagent's session is kept in, when it has its own. */
	readonly sessionFile?: string;
	/** Display name without "@", such as "worker". */
	readonly name: string;
	/** The prompt's top-rule label, such as "worker · Fix the parser · running". */
	readonly ruleLabel: string;
	/** The empty prompt's placeholder, such as "Message @worker…", or the paused, stopped, answer or wake text. */
	readonly placeholder: string;
	readonly state: AgentViewState;
	/** Streaming, retrying or running a tool: Enter queues the message. */
	readonly busy: boolean;
	/** Esc paused it: the next message sent continues it. */
	readonly paused: boolean;
	readonly retrying: boolean;
	/** The subagent's own queue as it last listed it. */
	readonly queued: SteeringQueueLists;
	/**
	 * Messages it took from its queue whose own row its transcript does not show yet: drawn as queued rows ahead of
	 * `queued` until it does, so a message is never off screen. Drawing only; left out when there are none.
	 */
	readonly delivering?: SteeringQueueLists;
	/**
	 * Queued messages it took whose own row its transcript shows and whose save has not been seen yet, oldest first.
	 * Drawn as nothing more than their row; if the engine running it is lost meanwhile, they are listed as unconfirmed.
	 * Left out when there are none.
	 */
	readonly unsaved?: readonly string[];
	/**
	 * How the saves of the messages it took and was not seen to save can be found in its session's store after its engine
	 * is lost: its session, and each message's receipt (null for one without), in the order of `unsaved`, then
	 * `delivering`'s steering and follow-up lanes. Left out when it has none to find.
	 */
	readonly receipts?: AgentViewReceipts;
	/** Why messages cannot reach it any more; undefined while they can. */
	readonly readOnlyReason?: string;
	/** It waits on a question form, drawn in the transcript area, which takes the keys meanwhile. */
	readonly heldPrompt: boolean;
	/** The working line under its transcript, as its chat would draw it; undefined when it shows none. */
	readonly working?: AgentWorkingLine;
	/** The subagent is gone (dismissed, removed, or its engine was lost): the screen shows main again. */
	readonly gone: boolean;
}

/** See {@link AgentViewStatus.receipts}. */
export interface AgentViewReceipts {
	readonly sessionId: string;
	/** The file the session is kept in, when it has its own, as a subagent's session does. */
	readonly sessionFile?: string;
	readonly taken: readonly (QueuedMessageReceipt | null)[];
}

/**
 * A subagent's working line as plain data: what it is doing (`working` streams, `busy` waits or retries,
 * `compacting`), or the `worked` row its last turn left. The host draws and animates it as the main chat's.
 */
export interface AgentWorkingLine {
	readonly kind: "working" | "busy" | "compacting" | "worked";
	readonly message: string;
	readonly elapsedMs?: number;
	readonly tokens?: number;
	readonly worked?: { readonly elapsedMs: number; readonly tokens?: number };
}

/** The viewed subagent's transcript, drawn where the main transcript is. */
export interface AgentTranscriptComponent extends Component {
	/** Scroll and paging keys while it is shown (page keys, wheel, top/bottom, half page, prompt jumps, jump to latest). */
	handleViewKey(data: string): boolean;
	/** Whether its question form is open and takes the keys; focus moves to the transcript area meanwhile. */
	capturesInput(): boolean;
	handleInput(data: string): void;
	invalidate(): void;
}

/** A slash command the viewed agent's own session runs. */
export interface AgentViewCommand {
	readonly name: string;
	readonly description?: string;
}

/** The slash commands the viewed agent's own session runs: completion and routing of skills and templates. */
export interface AgentViewCommands {
	readonly cwd: string;
	readonly skillCommands: readonly AgentViewCommand[];
	readonly promptTemplates: readonly AgentViewCommand[];
	readonly extensionCommands: readonly AgentViewCommand[];
}

/** What a pause took back from the subagent's queue, and why a restart would not keep the pause, when it would not. */
export type PausedTaskMessages = QueuedTaskMessages & { readonly warning?: string };

/** The steering half of a port. */
export interface AgentSteeringPort {
	/** Where the prompt's messages go: busy, paused and queued follow `status()`; the calls reach the subagent. */
	readonly steering: SteeringTarget;
	/** Esc: pause the subagent, answering the messages taken back from its queue, steering first. */
	pause(): Promise<TaskViewResult<PausedTaskMessages>>;
}

/** One subagent, reachable from the host whether it runs in this process or in the isolated engine. */
export interface AgentViewPort extends AgentSteeringPort {
	readonly agentKey: string;
	status(): AgentViewStatus;
	subscribe(listener: () => void): () => void;
	readonly transcript: AgentTranscriptComponent;
	/** Its own delivered user messages, oldest first. */
	prompts(): Promise<readonly string[]>;
	commands(): Promise<AgentViewCommands | undefined>;
	/** The text of its last assistant message, for `/copy` while it is shown. */
	lastAgentMessageText(): Promise<string | undefined>;
	/** Keep the port alive while it is shown or has messages on their way. The last release disposes it. */
	retain(): () => void;
}

export interface AgentViewChange {
	readonly from: ViewedTarget;
	readonly to: ViewedTarget;
}
