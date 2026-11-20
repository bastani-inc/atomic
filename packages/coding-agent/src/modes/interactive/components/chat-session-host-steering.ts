import {
	type SteeringEditorQueue,
	SteeringQueueController,
	type SteeringQueuedMessage,
	type SteeringTarget,
} from "../steering-queue-controller.ts";
import { isChatSessionStreaming } from "./chat-session-host-runtime.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import type { ChatSessionSubmitMode } from "./chat-session-host-types.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";
import { keyDisplayText } from "./keybinding-hints.js";
import { QueuedMessagesView, queuedMessageRows } from "./queued-messages-view.ts";

/**
 * The agent a chat steers through the shared steering controller, as the main chat steers its own session. `prompt`
 * hands it a message: queued in `streamingBehavior`'s lane while it works, otherwise its next turn. `clearQueue` takes
 * back every message it holds, in its own answer. The chat supplies whether it is busy and what it lists as queued
 * from the session's own events.
 */
export type ChatSteeringTarget = Pick<SteeringTarget, "prompt" | "clearQueue"> &
	Pick<Partial<SteeringTarget>, "resume">;

function heldLane(mode: ChatSessionSubmitMode): SteeringQueuedMessage["mode"] {
	return mode === "followUp" ? "followUp" : "steer";
}

/** The steering controller of a chat whose messages go to `target`. */
export function createChatSessionSteering<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	target: ChatSteeringTarget,
): SteeringQueueController {
	const steered: SteeringTarget = {
		get busy() {
			return isChatSessionStreaming(state);
		},
		get paused() {
			return state.isPaused?.() === true;
		},
		queued: () => ({ steering: state.pendingSteeringMessages, followUp: state.pendingFollowUpMessages }),
		prompt: (text, options) => target.prompt(text, options),
		clearQueue: (options) => target.clearQueue(options),
		// A paused agent is continued, not only prompted, by the user's next message.
		...(target.resume === undefined ? {} : { resume: target.resume }),
	};
	const editor: SteeringEditorQueue = {
		// Input typed while the agent compacts waits here, listed in its lane after the agent's own queue.
		held: () =>
			state.compactionQueuedMessages.map((message) => ({ text: message.text, mode: heldLane(message.mode) })),
		takeHeld: () => {
			const taken = state.compactionQueuedMessages;
			state.compactionQueuedMessages = [];
			return {
				messages: taken.map((message) => ({ text: message.text, mode: heldLane(message.mode) })),
				putBack: () => {
					state.compactionQueuedMessages = [...taken, ...state.compactionQueuedMessages];
				},
			};
		},
		changed: () => {},
		requestRender: () => state.requestRender?.(),
	};
	return new SteeringQueueController(steered, editor);
}

/** The queued rows of a steered chat, drawn as the main chat draws its own. */
export function renderSteeredPendingMessages<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	controller: SteeringQueueController,
	width: number,
): string[] {
	const dequeueKey = state.getActionKeyDisplay?.("app.message.dequeue") ?? keyDisplayText("app.message.dequeue");
	return new QueuedMessagesView(queuedMessageRows(controller.allQueued()), dequeueKey, (text) =>
		state.style.dim(text),
	).render(width);
}
