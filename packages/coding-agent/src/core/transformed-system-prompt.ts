/**
 * The prompt a session with a transformed system prompt (an in-process subagent child) actually sent.
 *
 * Such a session's own system messages record the structured prompt before the transform, which the model never
 * sees. The transformed prompt is recorded beside them. The row that starts it records a digest of each section the
 * model is told and its owner (the session and the transform's key), and either the exact text it leads with or, in
 * a fork, a note: a fork leads with the conversation it continues, sent exactly as that conversation was sent, and
 * adds the note and its own sections after it. A later row records the sections that changed. A session reopened on
 * another day or after an upgrade therefore keeps its cached prefix and is told what changed as section updates, as a
 * session with the structured prompt is. Only the latest recorded prompt is sent, and only by its owner: a session
 * reopened under another key records and sends its current prompt instead.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	type Api,
	getCurrentTools,
	type Model,
	type SystemMessage,
	type Tool,
	type ToolReference,
} from "@bastani/atomic-ai";
import type { SystemPromptSections } from "./system-prompt.ts";

export interface TransformedPromptHead {
	/** The exact text the session leads with. */
	readonly content?: string;
	/**
	 * A fork: the conversation before this row is sent as it was, with the tools its requests hid (`hidden`) left
	 * out, and `note` opens what the fork adds.
	 */
	readonly fork?: { readonly note: string; readonly hidden?: readonly string[] };
	/** A digest of each section the model is told at this row, before its `sections` changes. */
	readonly digests: Record<string, string>;
	readonly owner: string;
	/** The session started as a fork: kept on every later head, also across compactions. */
	readonly forked?: true;
}

export interface TransformedPromptRecord {
	/**
	 * On the row that starts the prompt. A head with neither text nor fork (a fork after a compaction) has nothing to
	 * lead with: the next request records the session's current prompt.
	 */
	readonly head?: TransformedPromptHead;
	/** The sections that changed at this row; `null` removes one. */
	readonly sections?: Record<string, string | null>;
}

/** The transformed prompt a session built and the sections it renders. */
export interface TransformedPrompt {
	readonly content: string;
	readonly sections: SystemPromptSections;
}

/** How a fork that continues a conversation adds its own prompt. */
export interface TransformedPromptFork {
	/** The sections of the conversation's prompt it continues, as the model was told them. */
	readonly sections: SystemPromptSections;
	readonly note: string;
	/** The tools the conversation's requests declared but hid. */
	readonly hidden?: readonly string[];
}

/** Which tool changes the transport can declare after the first message; see `TranscriptToolSupport`. */
export type ToolChangeSupport = "none" | "additions" | "changes";

/** The tool changes a model's transport declares in place, from the compatibility flags its transports read. */
export function toolChangeSupport(compat: Model<Api>["compat"]): ToolChangeSupport {
	if (!compat || !("supportsMidConvoSystemMessages" in compat) || !compat.supportsMidConvoSystemMessages)
		return "none";
	if (
		("supportsMidConvoToolChanges" in compat && compat.supportsMidConvoToolChanges) ||
		("supportsAdditionalTools" in compat && compat.supportsAdditionalTools)
	)
		return "changes";
	return "supportsMidConvoToolAdditions" in compat && compat.supportsMidConvoToolAdditions ? "additions" : "none";
}

/** The sections a fork keeps as the conversation it continues was sent: it never changes or removes them. */
const CONVERSATION_SECTIONS = new Set(["project_context", "skills"]);

function forkOwnSections(sections: SystemPromptSections): SystemPromptSections {
	return Object.fromEntries(Object.entries(sections).filter(([name]) => !CONVERSATION_SECTIONS.has(name)));
}

export type SystemMessageWithTransformedPrompt = SystemMessage & { transformedPrompt?: TransformedPromptRecord };

function transformedPromptOf(message: AgentMessage): TransformedPromptRecord | undefined {
	return message.role === "system" ? (message as SystemMessageWithTransformedPrompt).transformedPrompt : undefined;
}

/** The owner a session records its transformed prompt under: the session and the transform's key. */
export function transformedPromptOwner(sessionId: string, key: string): string {
	return JSON.stringify([sessionId, key]);
}

function latestHeadIndex(messages: readonly AgentMessage[]): number {
	return messages.findLastIndex((message) => transformedPromptOf(message)?.head !== undefined);
}

/**
 * The row of the latest recorded prompt when `owner` recorded it and it has something to lead with, or -1: a prompt
 * recorded before another owner's, and the changes recorded after it, are never sent again.
 */
function headIndex(messages: readonly AgentMessage[], owner: string): number {
	const index = latestHeadIndex(messages);
	const head = index < 0 ? undefined : transformedPromptOf(messages[index])?.head;
	return head?.owner === owner && (head.content !== undefined || head.fork !== undefined) ? index : -1;
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("base64url");
}

function digestsOf(sections: SystemPromptSections): Record<string, string> {
	return Object.fromEntries(Object.entries(sections).map(([name, text]) => [name, digest(text)]));
}

interface TransformedPromptState {
	readonly head: TransformedPromptHead;
	/** The digest of each section the model was last told. */
	readonly digests: Map<string, string>;
	/** The text of each section changed since the head, or null for one removed since. */
	readonly changed: Map<string, string | null>;
}

/** The transformed prompt of `owner` as the model was last told it, or undefined when it has none to lead with. */
function transformedPromptState(messages: readonly AgentMessage[], owner: string): TransformedPromptState | undefined {
	const index = headIndex(messages, owner);
	return index < 0 ? undefined : stateFrom(messages, index);
}

function stateFrom(messages: readonly AgentMessage[], index: number): TransformedPromptState | undefined {
	const head = transformedPromptOf(messages[index])?.head;
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

/** The sections of `desired` the model was not told; a section it was told and `removable` allows that is gone. */
function changedSections(
	told: ReadonlyMap<string, string>,
	desired: SystemPromptSections,
	removable: (name: string) => boolean,
): Record<string, string | null> | undefined {
	const changes: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(desired)) if (told.get(name) !== digest(text)) changes[name] = text;
	for (const name of told.keys()) if (desired[name] === undefined && removable(name)) changes[name] = null;
	return Object.keys(changes).length > 0 ? changes : undefined;
}

/** Whether any row of `messages` recorded a transformed prompt, under any owner. */
export function hasRecordedTransformedPrompt(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => transformedPromptOf(message) !== undefined);
}

/** Whether `messages` record that their session started as a fork that continues another session's conversation. */
export function startedAsFork(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => {
		const head = transformedPromptOf(message)?.head;
		return head?.fork !== undefined || head?.forked === true;
	});
}

/** Whether `owner` recorded the transformed prompt the next request leads with. */
export function hasTransformedPrompt(messages: readonly AgentMessage[], owner: string): boolean {
	return headIndex(messages, owner) >= 0;
}

/**
 * The record for the next request: a new head when `owner` has no prompt to lead with, otherwise the sections of
 * `desired` that changed since the model was last told them, or undefined when nothing changed. A fork whose
 * conversation never recorded a prompt continues it: its head keeps the conversation's prompt and adds `desired` after
 * it, and its own sections are the only ones it ever changes or removes. Any other session leads with `prompt`.
 */
export function nextTransformedPromptRecord(
	messages: readonly AgentMessage[],
	owner: string,
	prompt: TransformedPrompt,
	desired: SystemPromptSections,
	fork?: TransformedPromptFork,
): TransformedPromptRecord | undefined {
	const state = transformedPromptState(messages, owner);
	if (state !== undefined) {
		const forked = state.head.fork !== undefined;
		const own = (name: string) => !forked || typeof state.changed.get(name) === "string";
		const sections = changedSections(state.digests, forked ? forkOwnSections(desired) : desired, own);
		return sections ? { sections } : undefined;
	}
	if (fork !== undefined && latestHeadIndex(messages) < 0) {
		const digests = digestsOf(fork.sections);
		const sections = changedSections(new Map(Object.entries(digests)), forkOwnSections(desired), () => false);
		const forked = { note: fork.note, ...(fork.hidden?.length ? { hidden: [...fork.hidden] } : {}) };
		return { head: { fork: forked, digests, owner }, ...(sections ? { sections } : {}) };
	}
	const digests = digestsOf(prompt.sections);
	const sections = changedSections(new Map(Object.entries(digests)), desired, () => true);
	const forked = startedAsFork(messages) ? ({ forked: true } as const) : {};
	return { head: { content: prompt.content, digests, owner, ...forked }, ...(sections ? { sections } : {}) };
}

/**
 * Carry the transformed prompt into a compaction's system message: the same leading text, with every change made
 * since as one update, so the prompt stays what the model was told. A fork's prompt is the conversation the
 * compaction replaces, so it carries only its owner: the next request records the session's current prompt.
 */
export function carriedTransformedPrompt(messages: readonly AgentMessage[]): TransformedPromptRecord | undefined {
	const index = latestHeadIndex(messages);
	const state = index < 0 ? undefined : stateFrom(messages, index);
	if (state === undefined) return undefined;
	if (state.head.content === undefined) return { head: { digests: {}, owner: state.head.owner, forked: true } };
	const sections: Record<string, string | null> = {};
	for (const [name, text] of state.changed) {
		if (text === null ? name in state.head.digests : state.head.digests[name] !== digest(text)) sections[name] = text;
	}
	return { head: state.head, ...(Object.keys(sections).length > 0 ? { sections } : {}) };
}

/**
 * Which tools a fork that continues a conversation declares: the conversation's own declarations are kept, whatever
 * the fork may call (it refuses a call to a tool it lacks). The removal of a tool the fork cannot call (`callable`
 * names the tools it can) is declared only where the transport declares changes in place. A tool only the fork has
 * is declared where the transport can add it in place; otherwise it is reached through the conversation's codemode
 * when the fork has codemode too, and declared (changing the top-level tool list) when not.
 */
export function forkToolDeclarations(
	inherited: readonly Tool[],
	support: ToolChangeSupport,
	callable: readonly string[],
): {
	readonly keepRemoval: (name: string) => boolean;
	readonly keepAddition: (tool: Tool) => boolean;
	readonly throughCodemode: boolean;
} {
	const declared = new Set(inherited.map((tool) => tool.name));
	const own = new Set(callable);
	const throughCodemode = support === "none" && own.has("codemode") && declared.has("codemode");
	return {
		keepRemoval: (name) => support === "changes" && !own.has(name),
		keepAddition: (tool) => !declared.has(tool.name) && !throughCodemode,
		throughCodemode,
	};
}

/** A system message as a request that hides `hidden` declarations sends it (as `projectToolLoadout` does). */
function withoutHidden(message: SystemMessage, hidden: (name: string) => boolean): SystemMessage {
	if (!message.toolsAdded && !message.toolsRemoved) return message;
	const { toolsAdded, toolsRemoved, ...rest } = message;
	const added = toolsAdded?.filter((tool) => !hidden(tool.name)) ?? [];
	const removed = toolsRemoved?.filter((tool) => !hidden(tool.name)) ?? [];
	if (added.length === (toolsAdded?.length ?? 0) && removed.length === (toolsRemoved?.length ?? 0)) return message;
	return {
		...rest,
		...(added.length ? { toolsAdded: added } : {}),
		...(removed.length ? { toolsRemoved: removed } : {}),
	};
}

/**
 * The request projection of a transcript whose transformed prompt `owner` recorded, or undefined when `owner` has
 * none to lead with. A recorded text leads with the tools declared up to its row, and earlier system messages fold
 * into it. A fork sends the conversation before its row as it was, then its note. After the head, a system message
 * carries its tool changes and its transformed section changes in place; the untransformed sections are never sent.
 * `isHidden` names the session's own tools whose declarations its requests leave out; a fork leaves out the tools
 * the conversation it continues hid before its row.
 */
export function projectTransformedPrompt(
	messages: readonly AgentMessage[],
	owner: string,
	toolSupport: ToolChangeSupport,
	callable: readonly string[],
	isHidden: (name: string) => boolean,
): AgentMessage[] | undefined {
	const index = headIndex(messages, owner);
	const head = index < 0 ? undefined : transformedPromptOf(messages[index])?.head;
	if (head === undefined) return undefined;
	const inheritedHidden = new Set(head.fork?.hidden ?? []);
	const declarations = head.fork
		? forkToolDeclarations(
				getCurrentTools(messages.slice(0, index)).filter((tool) => !inheritedHidden.has(tool.name)),
				toolSupport,
				callable,
			)
		: undefined;
	const shown = (hidden: (name: string) => boolean) => (tool: { readonly name: string }) => !hidden(tool.name);
	const projected: AgentMessage[] = [];
	if (!head.fork) {
		const tools = getCurrentTools(messages.slice(0, index + 1)).filter(shown(isHidden));
		projected.push({
			role: "system",
			content: head.content ?? "",
			...(tools.length > 0 ? { toolsAdded: tools } : {}),
			timestamp: messages.find((message) => message.role === "system")?.timestamp ?? Date.now(),
		});
	}
	for (const [position, message] of messages.entries()) {
		if (message.role !== "system") {
			projected.push(message);
			continue;
		}
		if (position < index) {
			if (head.fork) projected.push(withoutHidden(message, (name) => inheritedHidden.has(name)));
			continue;
		}
		const sections = transformedPromptOf(message)?.sections;
		const content = position === index ? (head.fork?.note ?? "") : "";
		const ownHead = position === index && !head.fork;
		let toolsAdded: Tool[] | undefined = ownHead ? undefined : message.toolsAdded?.filter(shown(isHidden));
		let toolsRemoved: ToolReference[] | undefined = ownHead
			? undefined
			: message.toolsRemoved?.filter(shown(isHidden));
		if (declarations) {
			toolsAdded = toolsAdded?.filter(declarations.keepAddition);
			toolsRemoved = toolsRemoved?.filter(
				(tool) => declarations.keepRemoval(tool.name) && !inheritedHidden.has(tool.name),
			);
		}
		if (!content && !sections && !toolsAdded?.length && !toolsRemoved?.length) continue;
		projected.push({
			role: "system",
			content,
			...(sections ? { sections } : {}),
			...(toolsAdded?.length ? { toolsAdded } : {}),
			...(toolsRemoved?.length ? { toolsRemoved } : {}),
			timestamp: message.timestamp,
		});
	}
	return projected;
}
