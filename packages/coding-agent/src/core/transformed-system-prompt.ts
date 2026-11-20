/**
 * The prompt a session with a transformed system prompt (an in-process subagent child) actually sent.
 *
 * Such a session's own system messages record the structured prompt before the transform, which the model never
 * sees. The transformed prompt is recorded beside them: the row that first sends it records its exact text and a
 * digest of each section it renders, and a later row records the sections that changed. Requests lead with the
 * recorded text, so a session reopened on another day or after an upgrade keeps its cached prefix and is told what
 * changed as section updates, as a session with the structured prompt is.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { getCurrentTools, type SystemMessage } from "@bastani/atomic-ai";
import type { SystemPromptSections } from "./system-prompt.ts";

export interface TransformedPromptRecord {
	/** On the row that first sends the prompt: its exact text and a digest of each section it renders. */
	readonly head?: { readonly content: string; readonly digests: Record<string, string> };
	/** The sections that changed at this row; `null` removes one. */
	readonly sections?: Record<string, string | null>;
}

/** The transformed prompt a session built and the sections it renders. */
export interface TransformedPrompt {
	readonly content: string;
	readonly sections: SystemPromptSections;
}

export type SystemMessageWithTransformedPrompt = SystemMessage & { transformedPrompt?: TransformedPromptRecord };

function transformedPromptOf(message: AgentMessage): TransformedPromptRecord | undefined {
	return message.role === "system" ? (message as SystemMessageWithTransformedPrompt).transformedPrompt : undefined;
}

function headIndex(messages: readonly AgentMessage[]): number {
	return messages.findLastIndex((message) => transformedPromptOf(message)?.head !== undefined);
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("base64url");
}

interface TransformedPromptState {
	readonly head: NonNullable<TransformedPromptRecord["head"]>;
	/** The digest of each section the model was last told. */
	readonly digests: Map<string, string>;
	/** The text of each section changed since the head, or null for one removed since. */
	readonly changed: Map<string, string | null>;
}

/** The transformed prompt as the model was last told it, or undefined when no row in `messages` sent it. */
function transformedPromptState(messages: readonly AgentMessage[]): TransformedPromptState | undefined {
	const index = headIndex(messages);
	const head = index < 0 ? undefined : transformedPromptOf(messages[index])?.head;
	if (head === undefined) return undefined;
	const digests = new Map(Object.entries(head.digests));
	const changed = new Map<string, string | null>();
	for (const message of messages.slice(index)) {
		for (const [name, text] of Object.entries(transformedPromptOf(message)?.sections ?? {})) {
			if (text === null) digests.delete(name);
			else digests.set(name, digest(text));
			changed.set(name, text);
		}
	}
	return { head, digests, changed };
}

function changedSections(
	told: ReadonlyMap<string, string>,
	desired: SystemPromptSections,
): Record<string, string | null> | undefined {
	const changes: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(desired)) if (told.get(name) !== digest(text)) changes[name] = text;
	for (const name of told.keys()) if (desired[name] === undefined) changes[name] = null;
	return Object.keys(changes).length > 0 ? changes : undefined;
}

/** Whether a row in `messages` sent the transformed prompt. */
export function hasTransformedPrompt(messages: readonly AgentMessage[]): boolean {
	return headIndex(messages) >= 0;
}

/**
 * The record for the next request: `prompt` itself when no row has sent the transformed prompt yet, otherwise the
 * sections of `desired` that changed since the model was last told them, or undefined when nothing changed.
 */
export function nextTransformedPromptRecord(
	messages: readonly AgentMessage[],
	prompt: TransformedPrompt,
	desired: SystemPromptSections,
): TransformedPromptRecord | undefined {
	const state = transformedPromptState(messages);
	if (state !== undefined) {
		const sections = changedSections(state.digests, desired);
		return sections ? { sections } : undefined;
	}
	const digests = Object.fromEntries(Object.entries(prompt.sections).map(([name, text]) => [name, digest(text)]));
	const sections = changedSections(new Map(Object.entries(digests)), desired);
	return { head: { content: prompt.content, digests }, ...(sections ? { sections } : {}) };
}

/**
 * Carry the transformed prompt into a compaction's system message: the same leading text, with every change made
 * since as one update, so the prompt stays what the model was told.
 */
export function carriedTransformedPrompt(messages: readonly AgentMessage[]): TransformedPromptRecord | undefined {
	const state = transformedPromptState(messages);
	if (state === undefined) return undefined;
	const sections: Record<string, string | null> = {};
	for (const [name, text] of state.changed) {
		if (text === null ? name in state.head.digests : state.head.digests[name] !== digest(text)) sections[name] = text;
	}
	return { head: state.head, ...(Object.keys(sections).length > 0 ? { sections } : {}) };
}

/**
 * The request projection of a transcript whose transformed prompt was recorded: the recorded text leads with the
 * tools declared up to its row; earlier system messages fold into it; a later system message carries its tool
 * changes and its transformed section changes in place. The untransformed sections are never sent. Undefined when no
 * row in `messages` recorded the prompt.
 */
export function projectTransformedPrompt(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
	const index = headIndex(messages);
	const head = index < 0 ? undefined : transformedPromptOf(messages[index])?.head;
	if (head === undefined) return undefined;
	const tools = getCurrentTools(messages.slice(0, index + 1));
	const projected: AgentMessage[] = [
		{
			role: "system",
			content: head.content,
			...(tools.length > 0 ? { toolsAdded: tools } : {}),
			timestamp: messages.find((message) => message.role === "system")?.timestamp ?? Date.now(),
		},
	];
	for (const [position, message] of messages.entries()) {
		if (message.role !== "system") {
			projected.push(message);
			continue;
		}
		if (position < index) continue;
		const sections = transformedPromptOf(message)?.sections;
		const toolsAdded = position === index ? undefined : message.toolsAdded;
		const toolsRemoved = position === index ? undefined : message.toolsRemoved;
		if (!sections && !toolsAdded?.length && !toolsRemoved?.length) continue;
		projected.push({
			role: "system",
			content: "",
			...(sections ? { sections } : {}),
			...(toolsAdded?.length ? { toolsAdded } : {}),
			...(toolsRemoved?.length ? { toolsRemoved } : {}),
			timestamp: message.timestamp,
		});
	}
	return projected;
}
