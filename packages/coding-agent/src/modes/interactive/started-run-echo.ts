import type { AgentSessionEvent } from "../../core/agent-session.js";

/**
 * The echo of a sent message (the copy the chat shows as soon as it is sent) once the session answers that it started
 * a run for it. The run shows the message itself, and its user `message_start` takes the echo's place; a run that
 * repeats input the chat already shows as unsaved shows no message of its own, and its echo goes (#5135).
 *
 * The answer and the run's first events arrive in either order: an engine answers as the run starts, and can send the
 * run's events after it. So only the run's own events decide: its user message keeps the echo, and the run getting past
 * where that message would be (its first assistant message, its turn's end or its end) without one drops it.
 *
 * - `awaiting-answer`: sent, not answered yet. Events seen meanwhile are remembered.
 * - `awaiting-run-message`: answered "started" before the run showed or skipped its message.
 * - `settled`: decided. `left` leaves the echo to the rest of the chat (shown by the run, or answered other than
 *   started); `dropped` removes it; `never-ran` removes it too, for a run that settled or lost its engine before it
 *   started, which also leaves the working row the send showed with nothing to replace it.
 */
export type StartedRunEcho =
	| {
			readonly kind: "awaiting-answer";
			/** A run started after the message was sent. */
			readonly runStarted: boolean;
			/** The session showed a user message after the message was sent. */
			readonly userMessageShown: boolean;
			/** A run that started after the message was sent got past its prompt messages. */
			readonly runPastPrompt: boolean;
	  }
	| { readonly kind: "awaiting-run-message"; readonly runStarted: boolean }
	| { readonly kind: "settled"; readonly echo: "left" | "dropped" | "never-ran" };

export type StartedRunEchoEvent =
	/** The session answered the prompt; `started` when it started a run for it. */
	| { readonly type: "answer"; readonly started: boolean }
	/** `agent_start`. */
	| { readonly type: "run-start" }
	/** `message_start` of a user message. */
	| { readonly type: "user-message" }
	/** `message_start` of an assistant message, `turn_end` or `agent_end`: a run is past its prompt messages. */
	| { readonly type: "past-prompt" }
	/** `agent_settled`: a prompt's run is over, whether or not it started. */
	| { readonly type: "run-settled" }
	/** The engine that would run it went away. */
	| { readonly type: "lost" };

export const STARTED_RUN_ECHO_SENT: StartedRunEcho = {
	kind: "awaiting-answer",
	runStarted: false,
	userMessageShown: false,
	runPastPrompt: false,
};

const LEFT: StartedRunEcho = { kind: "settled", echo: "left" };
const DROPPED: StartedRunEcho = { kind: "settled", echo: "dropped" };
const NEVER_RAN: StartedRunEcho = { kind: "settled", echo: "never-ran" };

export function nextStartedRunEcho(state: StartedRunEcho, event: StartedRunEchoEvent): StartedRunEcho {
	switch (state.kind) {
		case "settled":
			return state;
		case "awaiting-answer":
			switch (event.type) {
				case "run-start":
					return { ...state, runStarted: true };
				case "user-message":
					return { ...state, userMessageShown: true };
				case "past-prompt":
					return state.runStarted ? { ...state, runPastPrompt: true } : state;
				case "run-settled":
					// An earlier prompt's run: this one's is answered before it settles.
					return state;
				case "lost":
					// The prompt fails with the engine, and its failure handles the echo.
					return LEFT;
				case "answer":
					if (!event.started || state.userMessageShown) return LEFT;
					if (state.runPastPrompt) return DROPPED;
					return { kind: "awaiting-run-message", runStarted: state.runStarted };
			}
			break;
		case "awaiting-run-message":
			switch (event.type) {
				case "run-start":
					return { kind: "awaiting-run-message", runStarted: true };
				case "user-message":
					return LEFT;
				case "past-prompt":
					return state.runStarted ? DROPPED : state;
				case "run-settled":
				case "lost":
					return state.runStarted ? DROPPED : NEVER_RAN;
				case "answer":
					return state;
			}
	}
	return state;
}

/** What a session event tells a `StartedRunEcho`, if anything. */
export function startedRunEchoEvent(event: AgentSessionEvent): StartedRunEchoEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { type: "run-start" };
		case "message_start":
			if (event.message.role === "user") return { type: "user-message" };
			return event.message.role === "assistant" ? { type: "past-prompt" } : undefined;
		case "turn_end":
		case "agent_end":
			return { type: "past-prompt" };
		case "agent_settled":
			return { type: "run-settled" };
		default:
			return undefined;
	}
}
