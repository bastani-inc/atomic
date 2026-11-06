import type { DetachedToolResult } from "@bastani/atomic";
import { asAgentSession } from "./stage-runner-session.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

/**
 * The stage's transcript as its session store holds it. An `AgentSession`'s `messages` is the context its model sees:
 * a session reopened on a turn that ends on a call without a result closes that call there with an "interrupted"
 * result of its own, so read from `messages`, a call still waiting on its result looks answered (#4309). A runtime that
 * is not an `AgentSession` reports its transcript as `messages`.
 */
export function storedTranscript(session: StageSessionRuntime): StageSessionRuntime["messages"] {
	return asAgentSession(session)?.sessionManager.buildSessionProjection().messages ?? session.messages;
}

/** The ids of the tool calls the transcript's last assistant message issued that have no result yet, in call order. */
export function unansweredToolCallIds(messages: StageSessionRuntime["messages"]): string[] {
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role !== "assistant") index--;
	const assistant = messages[index];
	if (assistant?.role !== "assistant") return [];
	const answered = new Set(
		messages.slice(index + 1).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
	);
	return assistant.content.flatMap((block) =>
		block.type === "toolCall" && !answered.has(block.id) ? [block.id] : [],
	);
}

type TranscriptMessage = StageSessionRuntime["messages"][number];
type AssistantTranscriptMessage = Extract<TranscriptMessage, { readonly role: "assistant" }>;
type UserTranscriptMessage = Extract<TranscriptMessage, { readonly role: "user" }>;

/**
 * The model's final answer to `prompt` that the transcript ends on: an assistant message that stopped on its own and
 * called no tool, with nothing after it, closing a turn that the user message `prompt` opened and that asked the user
 * nothing. Undefined for any other transcript, such as one that ends on a call, a cut-off or failed answer, or a notice;
 * one whose last turn another message opened, as in a conversation a forked stage inherited, a delivery or another
 * prompt; and one whose last turn called `ask_user_question`, after which the stage still asks whether it may move on.
 * `messages` is the transcript the store holds ({@link storedTranscript}).
 */
export function finalAnswerTo(
	messages: StageSessionRuntime["messages"],
	prompt: string,
): AssistantTranscriptMessage | undefined {
	const answer = messages.at(-1);
	if (answer?.role !== "assistant" || answer.stopReason !== "stop" || callsTool(answer)) return undefined;
	// Back from the answer, over the turn's own messages, to the message that opened the turn.
	for (let index = messages.length - 2; ; index--) {
		const message = messages[index];
		if (message?.role === "user") return sentText(message) === prompt ? answer : undefined;
		if (message?.role === "toolResult") continue;
		if (message?.role !== "assistant" || callsTool(message, "ask_user_question")) return undefined;
	}
}

/** The text a user message sent: its text parts, one per line. */
function sentText(message: UserTranscriptMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** Whether `message` calls a tool, or the tool `name` when given. */
function callsTool(message: AssistantTranscriptMessage, name?: string): boolean {
	return message.content.some((block) => block.type === "toolCall" && (name === undefined || block.name === name));
}

/**
 * The recorded results that answer every call the transcript ends on without a result, in call order; undefined when
 * any such call has none, so the calls without one run again rather than leaving the turn unanswered. `messages` is
 * the transcript the store holds ({@link storedTranscript}), not the context the model sees.
 */
export function resultsAnsweringTranscript(
	recorded: readonly DetachedToolResult[],
	messages: StageSessionRuntime["messages"],
): DetachedToolResult[] | undefined {
	const byCall = new Map(recorded.map((result) => [result.toolCallId, result]));
	const results: DetachedToolResult[] = [];
	for (const toolCallId of unansweredToolCallIds(messages)) {
		const result = byCall.get(toolCallId);
		if (result === undefined) return undefined;
		results.push(result);
	}
	return results;
}

/**
 * The session threw while it saved the results its turn continues from, and its transcript does not hold them: the
 * stage is still bringing its session back. Internal to the stage runner, which reopens the session and hands the
 * results over again; `failure` is what the session threw.
 */
export class DetachedResultsNotSaved extends Error {
	override readonly name = "DetachedResultsNotSaved";
	constructor(readonly failure: unknown) {
		super("atomic-workflows: the stage's session did not save the results its turn continues from", {
			cause: failure,
		});
	}
}
