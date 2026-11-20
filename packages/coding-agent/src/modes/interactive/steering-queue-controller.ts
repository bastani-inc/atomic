import type { ClearedQueue, PromptDisposition } from "../../core/agent-session-types.js";
import { isRpcRequestAcceptedFailure } from "../rpc/rpc-transport-error.ts";
import { combineQueuedMessagesForEditor } from "./chat-input-actions.ts";

/**
 * One chat's steering: what a message typed while the agent works does, how the chat shows it as queued until the
 * agent's session confirms it, and how every queued message comes back to the editor. The same controller serves the
 * main chat and a subagent chat, so a message is queued, listed, restored and delivered the same way in both. Each
 * chat supplies its agent as a {@link SteeringTarget} and its editor's own queue as a {@link SteeringEditorQueue}.
 */

/** The lane a queued message waits in: a steering message goes in at the next turn boundary, a follow-up after the run. */
export type SteeringLane = "steer" | "followUp";

/** How a submission asks to be sent: `auto` lets the controller choose from what the target is doing. */
export type SteeringSubmitLane = "auto" | SteeringLane;

/** A message held for the target, before it lists it as queued. Its identity is the copy's identity. */
export interface SteeringQueuedMessage {
	text: string;
	mode: SteeringLane;
}

/** The target's own queue, in the order it delivers each lane. */
export interface SteeringQueueLists {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}

export interface SteeringPromptOptions {
	/** Queue the message in this lane instead of starting a turn. Left out, the message starts a turn. */
	streamingBehavior?: SteeringLane;
	/** Called once when the target accepts (`true`, with how it dispatched the message) or refuses (`false`) it. */
	preflightResult?: (success: boolean, disposition?: PromptDisposition) => void;
}

export interface SteeringClearOptions {
	preserveUnprotectedCustomMessages?: boolean;
}

/**
 * The agent session a chat steers: the main chat's session, or a subagent's. Delivery happens inside the target, so
 * every message it accepts reaches its model as typed, one per turn boundary, steering messages before follow-ups.
 */
export interface SteeringTarget {
	/** Whether the target is working: streaming, retrying, or running a tool. */
	readonly busy: boolean;
	/** Whether the target holds its queue until the user sends again: an interrupted main chat, a paused subagent. */
	readonly paused: boolean;
	/** The target's queue as it last listed it. */
	queued(): SteeringQueueLists;
	/** Send `text`: queued in `streamingBehavior`'s lane, or starting a turn without one. */
	prompt(text: string, options?: SteeringPromptOptions): Promise<void>;
	/**
	 * Remove every queued message and answer with what was removed. The answer is the target's own: a queue listed
	 * across a process boundary trails it, so the controller never restores from its listed copy (#4257).
	 */
	clearQueue(options?: SteeringClearOptions): Promise<ClearedQueue> | ClearedQueue;
	/** Continue a paused or finished target with `text` as its next message. Left out, a paused target is prompted. */
	resume?(text: string, lane: SteeringSubmitLane): Promise<void>;
	/**
	 * Report each queue the target lists. Left out by a host that routes the target's `queue_update` events itself
	 * and calls {@link SteeringQueueController.reconcile}.
	 */
	subscribeQueue?(listener: (queue: SteeringQueueLists) => void): () => void;
}

/**
 * The chat's editor side of its queue: messages the editor holds back from the target (input typed while compaction
 * runs), listed after the target's own, and the notifications the controller sends when the rows change.
 */
export interface SteeringEditorQueue {
	/** Messages the editor holds back from the target, oldest first. */
	held(): readonly SteeringQueuedMessage[];
	/** Take every held message for a restore. `putBack` returns them when the target cannot be reached. */
	takeHeld(): { readonly messages: readonly SteeringQueuedMessage[]; putBack(): void };
	/** The queued rows changed; rebuild them. */
	changed(): void;
	/** Draw the chat again. */
	requestRender(): void;
}

/** How the controller sends a submission. A host whose input path tracks more than the target reports decides itself. */
export type SteeringRoute = "queue" | "start" | "resume";

export interface SteeringSubmitOptions {
	/** Send this way regardless of what the target reports. Left out, the target's `busy` and `paused` decide. */
	route?: SteeringRoute;
	/** Show the message as queued from submit until the target answers. Off for input that runs at once. */
	showAsQueued?: boolean;
	/** Called when the target answers the submission, before `submit` settles. */
	onAnswered?: (success: boolean, disposition?: PromptDisposition) => void;
}

/**
 * What became of a submission.
 * - `started`, `queued`, `handled`: the target accepted it, and how.
 * - `refused`: the target did not accept it; the caller gives the text back to the editor.
 * - `lost`: the target received it but its answer did not arrive; the caller reports it and gives nothing back.
 * - `failed`: the target accepted it and the turn it started failed afterwards; nothing goes back to the editor.
 */
export type SteeringSubmitResult =
	| { readonly kind: "started" | "queued" | "handled" }
	| { readonly kind: "refused" | "lost" | "failed"; readonly error: unknown };

/** Every queued message, per lane: the target's, then unconfirmed submissions, then the editor's held ones. */
export interface SteeringQueuedTexts {
	steering: string[];
	followUp: string[];
}

/** The messages a restore took back, and the editor text with them in front of what was typed. */
export interface SteeringRestore {
	readonly messages: readonly string[];
	readonly text: string;
}

export class SteeringQueueController {
	/** Submissions the target has not confirmed yet, shown as queued meanwhile, in submit order. */
	private unconfirmed: SteeringQueuedMessage[] = [];
	/** The target's queue as the last listing showed it, so the next one shows which messages it added. */
	private lastListed: SteeringQueueLists = { steering: [], followUp: [] };
	private unsubscribeQueue: (() => void) | undefined;
	readonly target: SteeringTarget;
	private readonly editor: SteeringEditorQueue;

	constructor(target: SteeringTarget, editor: SteeringEditorQueue) {
		this.target = target;
		this.editor = editor;
		this.unsubscribeQueue = target.subscribeQueue?.((queue) => {
			this.reconcile(queue);
			editor.changed();
			editor.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribeQueue?.();
		this.unsubscribeQueue = undefined;
	}

	/** Every queued message, per lane: the target's, then unconfirmed submissions, then the editor's held ones. */
	allQueued(): SteeringQueuedTexts {
		const held = [...this.unconfirmed, ...this.editor.held()];
		const queued = this.target.queued();
		return {
			steering: [...queued.steering, ...held.filter((msg) => msg.mode === "steer").map((msg) => msg.text)],
			followUp: [...queued.followUp, ...held.filter((msg) => msg.mode === "followUp").map((msg) => msg.text)],
		};
	}

	/** Whether any message is queued, shown or held. */
	hasQueued(): boolean {
		const { steering, followUp } = this.allQueued();
		return steering.length > 0 || followUp.length > 0;
	}

	/**
	 * Show `message` as queued until the target answers it or lists it (#4696). Delivery waits on the target: across
	 * a process boundary that is a round trip through an event loop the agent's own work shares.
	 */
	showAsQueued(message: SteeringQueuedMessage): SteeringQueuedMessage {
		this.track([message]);
		this.editor.changed();
		this.editor.requestRender();
		return message;
	}

	/**
	 * Count `messages` as handed to the target and unconfirmed, without redrawing. They are the target's from the moment
	 * they are sent, so a restore takes them from the target's own answer and never from these copies.
	 */
	track(messages: readonly SteeringQueuedMessage[]): void {
		this.unconfirmed = [...this.unconfirmed, ...messages];
	}

	/**
	 * Stop showing `message` once the target answered it: queued, it lists the message itself; started or handled, it
	 * is no longer queued; refused, the caller gives it back. Answers whether it was still shown.
	 */
	settle(message: SteeringQueuedMessage): boolean {
		const index = this.unconfirmed.indexOf(message);
		if (index === -1) return false;
		this.unconfirmed = [...this.unconfirmed.slice(0, index), ...this.unconfirmed.slice(index + 1)];
		this.editor.changed();
		return true;
	}

	/**
	 * Stop showing copies of messages the target's queue now lists, so a confirmed message is never shown twice
	 * (#4696). Only a message this listing added confirms a copy, oldest copy first, so an identical message queued
	 * earlier does not.
	 */
	reconcile(queue: SteeringQueueLists): void {
		const previous = this.lastListed;
		this.lastListed = { steering: [...queue.steering], followUp: [...queue.followUp] };
		if (this.unconfirmed.length === 0) return;
		const added = {
			steer: addedMessages(previous.steering, queue.steering),
			followUp: addedMessages(previous.followUp, queue.followUp),
		};
		this.unconfirmed = this.unconfirmed.filter((message) => !takeCopy(added[message.mode], message.text));
	}

	/** How a submission is sent while the target is in its current state. */
	route(): SteeringRoute {
		if (this.target.busy && !this.target.paused) return "queue";
		if (this.target.paused && this.target.resume !== undefined) return "resume";
		return "start";
	}

	/**
	 * Send `text`. While the target works it is queued in `lane` (`auto` steers) and shown as queued until the target
	 * answers; a paused target resumes with it; an idle one starts a turn with it.
	 */
	async submit(
		text: string,
		lane: SteeringSubmitLane,
		options: SteeringSubmitOptions = {},
	): Promise<SteeringSubmitResult> {
		const route = options.route ?? this.route();
		if (route === "resume" && this.target.resume !== undefined) {
			try {
				await this.target.resume(text, lane);
				return { kind: "started" };
			} catch (error) {
				return { kind: "refused", error };
			}
		}
		const queueLane: SteeringLane | undefined = route === "queue" ? (lane === "auto" ? "steer" : lane) : undefined;
		const shown =
			queueLane !== undefined && options.showAsQueued !== false
				? this.showAsQueued({ text, mode: queueLane })
				: undefined;
		const settle = () => {
			if (shown && this.settle(shown)) this.editor.requestRender();
		};
		let accepted = false;
		let disposition: PromptDisposition | undefined;
		try {
			await this.target.prompt(text, {
				...(queueLane !== undefined ? { streamingBehavior: queueLane } : {}),
				preflightResult: (success, answered) => {
					accepted = success;
					disposition = answered;
					settle();
					options.onAnswered?.(success, answered);
				},
			});
		} catch (error) {
			settle();
			if (accepted) return { kind: "failed", error };
			if (isRpcRequestAcceptedFailure(error)) return { kind: "lost", error };
			return { kind: "refused", error };
		}
		settle();
		return { kind: disposition ?? (queueLane !== undefined ? "queued" : "started") };
	}

	/**
	 * Take every queued message back from the target and the editor. What the target removed is its own answer, not a
	 * listed copy of its queue (#4257); the editor's held messages follow it. A submission the target has not confirmed
	 * yet is the target's: it either lists it or reports its refusal. When the target cannot be reached nothing is
	 * removed, the held messages stay queued, and the error is thrown.
	 */
	async clearAll(options?: SteeringClearOptions): Promise<SteeringQueuedTexts> {
		// Leave the editor queue now, so nothing sends these messages while the target answers.
		const held = this.editor.takeHeld();
		let removed: ClearedQueue;
		try {
			const clearing = Promise.resolve(this.target.clearQueue(options));
			this.editor.changed();
			removed = await clearing;
		} catch (error) {
			held.putBack();
			this.editor.changed();
			throw error;
		}
		// Each message goes back as it was typed, so sending it again runs `input` hooks and expansions once (#4284).
		// A session from before `typed` was added gives back only the text it queued.
		const typed = removed.typed ?? removed;
		return {
			steering: [...typed.steering, ...held.messages.filter((msg) => msg.mode === "steer").map((msg) => msg.text)],
			followUp: [
				...typed.followUp,
				...held.messages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Take every queued message back (Alt+Up, Escape with a queue) and put them in front of the editor's text, read
	 * once the target answered. Steering messages come first, then follow-ups, each lane in order. Answers `undefined`
	 * when nothing was queued.
	 */
	async restoreAll(editorText: () => string, options?: SteeringClearOptions): Promise<SteeringRestore | undefined> {
		const { steering, followUp } = await this.clearAll(options);
		const messages = [...steering, ...followUp];
		if (messages.length === 0) return undefined;
		return { messages, text: combineQueuedMessagesForEditor(messages, editorText()) };
	}
}

function addedMessages(before: readonly string[], after: readonly string[]): Map<string, number> {
	const unmatched = new Map<string, number>();
	for (const text of before) unmatched.set(text, (unmatched.get(text) ?? 0) + 1);
	const added = new Map<string, number>();
	for (const text of after) {
		if (!takeCopy(unmatched, text)) added.set(text, (added.get(text) ?? 0) + 1);
	}
	return added;
}

function takeCopy(copies: Map<string, number>, text: string): boolean {
	const count = copies.get(text) ?? 0;
	if (count === 0) return false;
	copies.set(text, count - 1);
	return true;
}
