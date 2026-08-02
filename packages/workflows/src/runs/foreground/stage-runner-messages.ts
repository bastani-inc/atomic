import type { AgentSession } from "@bastani/atomic";
import { errorMessage } from "../shared/model-fallback.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

// Twenty-six UTF-8 bytes is the shortest reviewer-probed genuine deliverable ("short but real deliverable") and sits
// just above the normal terse ACK forms. A 3:2 byte ratio then requires a 50% gap, so marginal formatting growth cannot
// displace the pre-admission turn while report-scale growth can. Both are deliberately content-agnostic heuristics.
const SUBSTANTIVE_ASSISTANT_TEXT_MIN_BYTES = 26;
const SUBSTANTIALLY_LARGER_RATIO_NUMERATOR = 3;
const SUBSTANTIALLY_LARGER_RATIO_DENOMINATOR = 2;

type TextLikeContent = {
	readonly type?: string;
	readonly text?: string;
};

type MessageWithTextContent = {
	readonly content?: string | readonly TextLikeContent[];
};

type MessageWithAdmissionKey = {
	readonly role?: string;
	readonly stageAdmissionKey?: string;
};

function isAdmittedExternalMessage(message: AgentSession["messages"][number]): boolean {
	const record = message as MessageWithAdmissionKey;
	return (
		record.role === "custom" && typeof record.stageAdmissionKey === "string" && record.stageAdmissionKey.length > 0
	);
}

export type AssistantTextNomination = {
	readonly text: string;
	readonly source: "pre-admission" | "post-admission-fallback" | "post-admission-override";
	readonly discardedPlausiblySubstantiveText: boolean;
};

type AssistantTextCandidate = {
	readonly index: number;
	readonly text: string;
	readonly utf8Bytes: number;
};

function isPlausiblySubstantive(candidate: AssistantTextCandidate): boolean {
	return candidate.utf8Bytes >= SUBSTANTIVE_ASSISTANT_TEXT_MIN_BYTES;
}

function isSubstantiallyLarger(candidate: AssistantTextCandidate, reference: AssistantTextCandidate): boolean {
	return (
		isPlausiblySubstantive(candidate) &&
		candidate.utf8Bytes * SUBSTANTIALLY_LARGER_RATIO_DENOMINATOR >=
			reference.utf8Bytes * SUBSTANTIALLY_LARGER_RATIO_NUMERATOR
	);
}

/**
 * With an admission in the prompt window, first identify the last pre-admission assistant text. Preserve it unless
 * the largest post-admission candidate is both plausibly substantive (at least 26 UTF-8 bytes) and at least 3:2 larger.
 * Without pre-admission text, choose the latest post-admission candidate at that floor, falling back to the latest
 * non-empty turn when every candidate is terse. With no admission, return undefined so existing latest-assistant
 * behavior is unchanged.
 *
 * This cannot infer intent: a terse genuine deliverable followed by a verbose acknowledgement can still be nominated
 * incorrectly. The receipt warning and companion transcript make that accepted residual visible.
 */
export function nominatedAssistantOutput(
	messages: AgentSession["messages"],
	startIndex = 0,
): AssistantTextNomination | undefined {
	const firstIndex = Math.max(0, startIndex);
	let firstAdmissionIndex: number | undefined;
	for (let index = firstIndex; index < messages.length; index += 1) {
		const message = messages[index];
		if (message && isAdmittedExternalMessage(message)) {
			firstAdmissionIndex = index;
			break;
		}
	}
	if (firstAdmissionIndex === undefined) return undefined;

	const postAdmissionCandidates: AssistantTextCandidate[] = [];
	for (let index = firstAdmissionIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = extractMessageText(message).trim();
		if (text) {
			postAdmissionCandidates.push({
				index,
				text,
				utf8Bytes: new TextEncoder().encode(text).byteLength,
			});
		}
	}
	let preAdmissionCandidate: AssistantTextCandidate | undefined;
	for (let index = firstAdmissionIndex - 1; index >= firstIndex; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = extractMessageText(message).trim();
		if (!text) continue;
		preAdmissionCandidate = {
			index,
			text,
			utf8Bytes: new TextEncoder().encode(text).byteLength,
		};
		break;
	}

	if (preAdmissionCandidate === undefined) {
		const fallback = postAdmissionCandidates.findLast(isPlausiblySubstantive) ?? postAdmissionCandidates.at(-1);
		return fallback === undefined
			? undefined
			: {
					text: fallback.text,
					source: "post-admission-fallback",
					discardedPlausiblySubstantiveText: postAdmissionCandidates.some(
						(candidate) => candidate.index !== fallback.index && isPlausiblySubstantive(candidate),
					),
				};
	}

	const largestPostAdmissionCandidate = postAdmissionCandidates.reduce<AssistantTextCandidate | undefined>(
		(largest, candidate) => (largest === undefined || candidate.utf8Bytes >= largest.utf8Bytes ? candidate : largest),
		undefined,
	);
	if (
		largestPostAdmissionCandidate !== undefined &&
		isSubstantiallyLarger(largestPostAdmissionCandidate, preAdmissionCandidate)
	) {
		return {
			text: largestPostAdmissionCandidate.text,
			source: "post-admission-override",
			discardedPlausiblySubstantiveText: true,
		};
	}
	return {
		text: preAdmissionCandidate.text,
		source: "pre-admission",
		discardedPlausiblySubstantiveText: postAdmissionCandidates.some(isPlausiblySubstantive),
	};
}

export function extractMessageText(message: AgentSession["messages"][number]): string {
	const { content } = message as MessageWithTextContent;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
			.filter(Boolean)
			.join("");
	}
	return "";
}

export function lastAssistantTextFromMessages(messages: AgentSession["messages"]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = extractMessageText(message).trim();
		if (text) return text;
	}
	return undefined;
}

function messageStopReason(message: AgentSession["messages"][number]): string | undefined {
	const record = message as { readonly stopReason?: unknown };
	return typeof record.stopReason === "string" ? record.stopReason : undefined;
}

function normalizedStopReason(stopReason: string | undefined): string | undefined {
	return stopReason?.toLowerCase().replace(/[_-]+/g, "");
}

function isTerminalAssistantFailureStopReason(stopReason: string | undefined): boolean {
	const normalized = normalizedStopReason(stopReason);
	return normalized === "error" || normalized === "aborted";
}

function isCleanAssistantStopReason(stopReason: string | undefined): boolean {
	const normalized = normalizedStopReason(stopReason);
	return normalized === "stop" || normalized === "tooluse" || normalized === "length";
}

function assistantErrorMessage(message: AgentSession["messages"][number]): string | undefined {
	const record = message as { readonly errorMessage?: unknown };
	return typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0
		? record.errorMessage
		: undefined;
}

export function latestTerminalAssistantFailureSince(
	messages: AgentSession["messages"],
	startIndex: number,
): AgentSession["messages"][number] | undefined {
	for (let index = messages.length - 1; index >= startIndex; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const stopReason = messageStopReason(message);
		if (isTerminalAssistantFailureStopReason(stopReason)) return message;
		if (isCleanAssistantStopReason(stopReason)) return undefined;
		if (assistantErrorMessage(message) === undefined && extractMessageText(message).trim().length > 0) {
			return undefined;
		}
	}
	return undefined;
}

export class WorkflowPromptModelFailure extends Error {
	override readonly cause: unknown;

	constructor(cause: unknown) {
		super(errorMessage(cause));
		this.name = "WorkflowPromptModelFailure";
		this.cause = cause;
	}
}

function terminatingToolResultText(
	messages: AgentSession["messages"],
	terminatingToolCallIds: ReadonlySet<string>,
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "toolResult") {
			const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
			if (typeof toolCallId !== "string" || !terminatingToolCallIds.has(toolCallId)) {
				return undefined;
			}
			const text = extractMessageText(message).trim();
			return text.length > 0 ? text : undefined;
		}
		if (message.role === "assistant") return undefined;
	}
	return undefined;
}

export function lastAssistantTextFromSession(
	activeSession: StageSessionRuntime | undefined,
	fallback: string | undefined,
	terminatingToolCallIds: ReadonlySet<string>,
	promptStartIndex?: number,
): string | undefined {
	if (!activeSession) return fallback;
	const terminatingText = terminatingToolResultText(activeSession.messages, terminatingToolCallIds);
	if (terminatingText !== undefined) return terminatingText;
	const nominated = nominatedAssistantOutput(activeSession.messages, promptStartIndex);
	if (nominated !== undefined) return nominated.text;
	const direct = activeSession.getLastAssistantText?.();
	if (direct?.trim()) return direct;
	return lastAssistantTextFromMessages(activeSession.messages) ?? direct ?? fallback;
}

export function assistantMessage(text: string): AgentSession["messages"] {
	return [
		{
			role: "assistant",
			content: [{ type: "text", text }],
		},
	] as AgentSession["messages"];
}
