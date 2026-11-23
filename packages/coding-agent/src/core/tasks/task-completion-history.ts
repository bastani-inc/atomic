import { memoizeAsync } from "../../utils/memoize-async.js";
import type { OversizedSessionEntry } from "../storage/session/types.js";
import {
	loadTaskOwnTranscriptHistory,
	type TaskLease,
	type TaskTranscriptSource,
	taskOwnTranscriptEntries,
	taskTranscriptSource,
} from "./supervisor.js";
import type { FileArchive } from "./task-view-source.js";

/** The last result a task's history holds for one of its tool calls, as an expanded completion card shows it. */
export interface TaskCompletionToolResult {
	readonly content: readonly unknown[];
	readonly details?: unknown;
	readonly text: string;
	readonly isError: boolean;
	readonly durationMs?: number;
}

export interface TaskCompletionToolCall {
	/** The call's ID, or `""` when it saved none. */
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly result?: TaskCompletionToolResult;
}

/**
 * What an expanded completion card shows of a task's own history: its first prompt, every tool call in order with the
 * last result of each, and why its saved history could not be read. Nothing else of the history is kept.
 */
export interface TaskCompletionHistory {
	readonly kind: "task-completion-history";
	readonly prompt: string;
	readonly toolCalls: readonly TaskCompletionToolCall[];
	readonly unavailable?: string;
}

type Entry = ReturnType<TaskTranscriptSource["getEntries"]>[number];
type Message = Extract<Entry, { type: "message" }>["message"];
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
type Chunks = () => AsyncIterable<Uint8Array>;
type Item = { readonly entry: Entry } | { readonly chunks: Chunks };
type Items = () => AsyncIterable<Item>;

// A tool result seen before any call with its ID only keeps its ID, to find it again if a later call has that ID.
const ORPHAN_ID_LIMIT = 4096;

/** The card's prompt: a fork's continuation preamble and progress-file trailers are not what the task was asked. */
function unwrapPromptText(task: string): string {
	let text = task;
	const forkMarker = "\n\nTask:\n";
	const forkIndex = text.indexOf(forkMarker);
	if (forkIndex >= 0 && text.startsWith("You are continuing from")) {
		text = text.slice(forkIndex + forkMarker.length);
	}
	text = text.replace(
		/\n\n---\n(?:Create and maintain progress at:|Update progress at:|Write your findings to:)\s*\S[^\n]*$/g,
		"",
	);
	text = text.replace(/\n\n\[Write to:\s*[^\]\s][^\]\n]*\]\s*$/i, "");
	return text.trim();
}

function textParts(content: readonly unknown[]): string {
	return (content as readonly { type?: unknown; text?: unknown }[])
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function savedResult(fields: {
	readonly content?: unknown;
	readonly hasDetails: boolean;
	readonly details?: unknown;
	readonly isError?: unknown;
	readonly durationMs?: unknown;
}): TaskCompletionToolResult {
	const content = Array.isArray(fields.content) ? (fields.content as readonly unknown[]) : [];
	return {
		content,
		details: fields.hasDetails ? fields.details : undefined,
		text: textParts(content),
		isError: fields.isError === true,
		durationMs: typeof fields.durationMs === "number" ? fields.durationMs : undefined,
	};
}

type RawCall = { readonly id: unknown; readonly name: unknown; readonly args: unknown };

/**
 * One forward read of the history in append order. It keeps the first prompt, every call, and the last result of each
 * call already seen; a result whose call comes later keeps only its ID. The history before the inherited boundary is
 * read past, as a whole read would slice it off.
 */
class CompletionFold {
	prompt = "";
	readonly calls: RawCall[] = [];
	private readonly callIds = new Set<string>();
	readonly results = new Map<string, TaskCompletionToolResult>();
	private readonly orphans = new Set<string>();
	private orphanOverflow = false;
	own: boolean;
	private readonly throughId: string | undefined;

	constructor(throughId: string | undefined) {
		this.throughId = throughId;
		this.own = throughId === undefined;
	}

	boundary(): void {
		this.prompt = "";
		this.calls.length = 0;
		this.callIds.clear();
		this.results.clear();
		this.orphans.clear();
		this.orphanOverflow = false;
		this.own = true;
	}

	isBoundary(entry: Entry): boolean {
		return this.throughId !== undefined && entry.id === this.throughId;
	}

	userText(text: string): void {
		if (!this.prompt) this.prompt = unwrapPromptText(text);
	}

	call(id: unknown, name: unknown, args: unknown): void {
		this.calls.push({ id, name, args });
		if (typeof id === "string") this.callIds.add(id);
	}

	/** Whether a result for `id` is kept now. */
	wants(id: string): boolean {
		if (this.callIds.has(id)) return true;
		if (id.length > ORPHAN_ID_LIMIT) this.orphanOverflow = true;
		else this.orphans.add(id);
		return false;
	}

	longResultId(): void {
		this.orphanOverflow = true;
	}

	message(message: Message): void {
		if (message.role === "user" && !this.prompt) {
			if (typeof message.content === "string") this.userText(message.content);
			else if (Array.isArray(message.content)) this.userText(textParts(message.content));
		} else if (message.role === "toolResult" && "toolCallId" in message && typeof message.toolCallId === "string") {
			if (this.wants(message.toolCallId))
				this.results.set(message.toolCallId, savedResult({ ...message, hasDetails: "details" in message }));
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			this.call(part.id, part.name, part.arguments);
		}
	}

	/** Calls whose only results came before them, which a second read finds. */
	unresolved(): Set<string> | undefined {
		if (this.orphans.size === 0 && !this.orphanOverflow) return undefined;
		const ids = new Set<string>();
		for (const { id } of this.calls)
			if (typeof id === "string" && !this.results.has(id) && (this.orphanOverflow || this.orphans.has(id)))
				ids.add(id);
		return ids.size === 0 ? undefined : ids;
	}

	history(unavailable?: string): TaskCompletionHistory {
		return {
			kind: "task-completion-history",
			prompt: this.prompt,
			toolCalls: this.calls.map(({ id, name, args }) => {
				const result = typeof id === "string" ? this.results.get(id) : undefined;
				return {
					id: typeof id === "string" ? id : "",
					name: name as string,
					args:
						typeof args === "object" && args !== null && !Array.isArray(args)
							? (args as Record<string, unknown>)
							: {},
					...(result === undefined ? {} : { result }),
				};
			}),
			...(unavailable === undefined ? {} : { unavailable }),
		};
	}
}

/** The card's projection of entries already in memory, exactly as a whole read projects them. */
export function projectTaskCompletionEntries(entries: readonly Entry[], unavailable?: string): TaskCompletionHistory {
	const fold = new CompletionFold(undefined);
	for (const entry of entries) if (entry.type === "message") fold.message(entry.message);
	const unresolved = fold.unresolved();
	if (unresolved)
		for (const entry of entries) {
			const message = entry.type === "message" ? entry.message : undefined;
			if (
				message?.role === "toolResult" &&
				typeof message.toolCallId === "string" &&
				unresolved.has(message.toolCallId)
			)
				fold.results.set(message.toolCallId, savedResult({ ...message, hasDetails: "details" in message }));
		}
	return fold.history(unavailable);
}

type EntryFields = typeof import("./task-completion-entry.js");
const oversized = memoizeAsync((): Promise<EntryFields> => import("./task-completion-entry.js"));

/** Whether a saved assistant message is the unsaved answer, compared by what it adds to the card. */
async function sameCalls(chunks: Chunks, unsaved: Message): Promise<boolean> {
	const { savedEntryHeader, savedToolCalls } = await oversized();
	const header = await savedEntryHeader(chunks(), undefined, 0);
	if (header.type !== "message" || header.role !== unsaved.role || unsaved.role !== "assistant") return false;
	const calls = (await savedToolCalls(chunks())).map((call) => [call.id, call.name, call.arguments]);
	const expected = unsaved.content.flatMap((part) =>
		part.type === "toolCall" ? [[part.id, part.name, part.arguments]] : [],
	);
	return JSON.stringify(calls) === JSON.stringify(expected);
}

/** An unsaved answer without calls cannot change the card, whether or not its session holds it. */
function cardUnsaved(unsaved: Entry | undefined): Extract<Entry, { type: "message" }> | undefined {
	if (unsaved?.type !== "message") return undefined;
	const { message } = unsaved;
	if (message.role === "assistant" && !message.content.some((part) => part.type === "toolCall")) return undefined;
	return unsaved;
}

/**
 * Read the history once, forward, a page at a time; a second time only when a call's results all came before it. An
 * oversized entry is read field by field. `unsaved` follows the history unless its last message is that answer.
 */
async function projectSavedHistory(
	items: Items,
	throughId: string | undefined,
	unsavedEntry: Entry | undefined,
	signal: AbortSignal | undefined,
): Promise<TaskCompletionHistory> {
	const unsaved = cardUnsaved(unsavedEntry);
	const fold = new CompletionFold(throughId);
	let last: Item | undefined;
	for await (const item of items()) {
		signal?.throwIfAborted();
		if ("entry" in item) {
			const { entry } = item;
			if (unsaved && entry.type === "message") last = item;
			if (fold.isBoundary(entry)) fold.boundary();
			else if (fold.own && entry.type === "message") fold.message(entry.message);
			continue;
		}
		const fields = await oversized();
		const header = await fields.savedEntryHeader(item.chunks(), throughId, ORPHAN_ID_LIMIT);
		if (unsaved && header.type === "message") last = item;
		if (header.boundary) {
			fold.boundary();
			continue;
		}
		if (!fold.own || header.type !== "message") continue;
		if (header.role === "user") {
			if (fold.prompt) continue;
			const text = await fields.savedUserText(item.chunks());
			if (text !== undefined) fold.userText(text);
		} else if (header.role === "assistant") {
			// A long answer or its thinking without a call is passed over without tokenizing it.
			if (!(await fields.savedRowMayHold(item.chunks(), "toolCall"))) continue;
			for (const call of await fields.savedToolCalls(item.chunks())) fold.call(call.id, call.name, call.arguments);
		} else if (header.role === "toolResult") {
			if (header.longToolCallId) fold.longResultId();
			else if (header.toolCallId !== undefined && fold.wants(header.toolCallId))
				fold.results.set(header.toolCallId, savedResult(await fields.savedToolResult(item.chunks())));
		}
	}
	signal?.throwIfAborted();
	const appended =
		unsaved !== undefined &&
		!(last === undefined
			? false
			: "entry" in last
				? last.entry.type === "message" && JSON.stringify(last.entry.message) === JSON.stringify(unsaved.message)
				: await sameCalls(last.chunks, unsaved.message));
	last = undefined;
	if (appended && fold.own) fold.message(unsaved.message);
	const unresolved = fold.unresolved();
	if (unresolved) {
		const idLimit = Math.max(...[...unresolved].map((id) => id.length));
		let own = throughId === undefined;
		const found = new Map<string, TaskCompletionToolResult>();
		const keep = (id: string, message: ToolResultMessage) => {
			if (own && unresolved.has(id)) found.set(id, savedResult({ ...message, hasDetails: "details" in message }));
		};
		for await (const item of items()) {
			signal?.throwIfAborted();
			if ("entry" in item) {
				const { entry } = item;
				if (throughId !== undefined && entry.id === throughId) {
					own = true;
					found.clear();
				} else if (entry.type === "message" && entry.message.role === "toolResult") {
					const { message } = entry;
					if (typeof message.toolCallId === "string") keep(message.toolCallId, message);
				}
				continue;
			}
			const fields = await oversized();
			const header = await fields.savedEntryHeader(item.chunks(), throughId, idLimit);
			if (header.boundary) {
				own = true;
				found.clear();
			} else if (
				own &&
				header.type === "message" &&
				header.role === "toolResult" &&
				header.toolCallId !== undefined &&
				unresolved.has(header.toolCallId)
			)
				found.set(header.toolCallId, savedResult(await fields.savedToolResult(item.chunks())));
		}
		if (appended && unsaved.message.role === "toolResult" && typeof unsaved.message.toolCallId === "string")
			keep(unsaved.message.toolCallId, unsaved.message);
		for (const [id, result] of found) fold.results.set(id, result);
	}
	signal?.throwIfAborted();
	// A boundary that is never found leaves no own history, as a whole read finds none after it.
	return fold.own ? fold.history() : new CompletionFold(undefined).history();
}

function storeItems(session: TaskTranscriptSource, signal: AbortSignal | undefined): Items {
	return async function* () {
		for await (const page of session.readHistory!({ ...(signal ? { signal } : {}) })) {
			for (const item of page.items) {
				if ("entry" in item) yield { entry: item.entry };
				else {
					const reference: OversizedSessionEntry = item;
					yield {
						chunks: () => {
							if (!session.readHistoryChunks)
								throw new TypeError(
									"The task history source must implement readHistoryChunks for oversized entries",
								);
							return session.readHistoryChunks(reference, { ...(signal ? { signal } : {}) });
						},
					};
				}
			}
		}
	};
}

function fileItems(file: FileArchive, signal: AbortSignal | undefined): Items {
	return async function* () {
		const { taskFileEntryChunks, taskFilePages } = await import("./task-file-history.js");
		for await (const page of taskFilePages(file.path, file.sessionId, {
			direction: "forward",
			...(signal ? { signal } : {}),
		})) {
			const cursor = page.adjacent.current;
			for (const item of page.items) {
				if ("entry" in item) yield { entry: item.entry };
				else {
					const { seq, bytes } = item;
					yield { chunks: () => taskFileEntryChunks(file.path, file.sessionId, cursor, seq, bytes, signal) };
				}
			}
		}
	};
}

/**
 * What an expanded completion card shows of a task's own history. A saved history is read a page at a time and only
 * the card's prompt, calls and their last results are kept; when it cannot be read, the card shows what the task kept
 * of its own prompt and answer and why. A history held in memory, or by a source that can only read it whole, is
 * projected from that.
 */
export async function readTaskCompletionHistory(
	task: TaskLease,
	signal?: AbortSignal,
): Promise<TaskCompletionHistory | undefined> {
	const bound = taskTranscriptSource(task);
	if (!bound.ok) return undefined;
	const { session, inheritedThroughId } = bound.value;
	if (!session.loadHistory) {
		const entries = taskOwnTranscriptEntries(task);
		return entries === undefined ? undefined : projectTaskCompletionEntries(entries);
	}
	const { taskTranscriptFile, taskTranscriptUnsavedAnswer } = await import("./task-view-source.js");
	const file = taskTranscriptFile(session);
	const items = file ? fileItems(file, signal) : session.readHistory ? storeItems(session, signal) : undefined;
	if (!items) {
		const history = await loadTaskOwnTranscriptHistory(task);
		return history === undefined ? undefined : projectTaskCompletionEntries(history.entries, history.unavailable);
	}
	try {
		return await projectSavedHistory(items, inheritedThroughId, taskTranscriptUnsavedAnswer(session), signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		const reason = file
			? await (await import("./task-file-history.js")).taskFileUnavailable(file.path, error)
			: storeUnavailable(error);
		return projectTaskCompletionEntries(session.getFallbackEntries?.() ?? [], reason);
	}
}

/** Why a task's saved session could not be read, worded as its runner words a failed whole read. */
function storeUnavailable(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("History unavailable:")) return message;
	return `History unavailable: ${error instanceof Error ? error.message : String(error ?? "its session could not be read")}`;
}
