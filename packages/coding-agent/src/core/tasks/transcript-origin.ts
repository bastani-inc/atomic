import type { AgentMessage } from "@bastani/atomic-agent-core";

/** Provenance belongs to this page, not to an arbitrary SDK message reused in a different task. */
const origins = new WeakMap<readonly AgentMessage[], ReadonlyMap<AgentMessage, string>>();
const rendered = new WeakMap<object, string>();
export function bindSavedTaskOrigins(messages: readonly AgentMessage[], keys: ReadonlyMap<AgentMessage, string>): void {
	origins.set(messages, keys);
}
export function savedTaskRows(
	messages: readonly AgentMessage[],
): ((entry: object, message: AgentMessage, part: number) => void) | undefined {
	const keys = origins.get(messages);
	if (!keys) return undefined;
	return (entry, message, part) => {
		const key = keys.get(message);
		if (key !== undefined) rendered.set(entry, `${key}:${part}`);
	};
}
export function savedTaskRowKey(entry: object): string | undefined {
	return rendered.get(entry);
}

/** The save receipt of a live message: the sequence its session stored it at. Absent while it is unsaved. */
const savedSeqs = new WeakMap<object, number>();
export function noteSavedSeq(message: object, seq: number): void {
	if (Number.isSafeInteger(seq) && seq > 0) savedSeqs.set(message, seq);
}
export function savedSeqOf(message: object | undefined): number | undefined {
	return message === undefined ? undefined : savedSeqs.get(message);
}

/** The message a chat row was drawn from, its position among that message's rows, and the result it shows. */
export interface ChatRowSource {
	readonly message: object;
	readonly part: number;
	readonly result?: object;
}
const rowSources = new WeakMap<object, ChatRowSource>();
export function noteRowSource(row: object, source: ChatRowSource): void {
	rowSources.set(row, source);
}
export function rowSource(row: object): ChatRowSource | undefined {
	return rowSources.get(row);
}
/** A replacement row (a streamed update, a tool's result) keeps the source of the row it replaces. */
export function carryRowSource(previous: object | undefined, next: object, result?: object): void {
	const source = previous === undefined ? undefined : rowSources.get(previous);
	if (source) rowSources.set(next, result === undefined ? source : { ...source, result });
}
/** The saved sequences a row was drawn from, once every message it shows has a save receipt. */
export function savedRowSpan(row: object): { readonly first: number; readonly last: number } | undefined {
	const source = rowSources.get(row);
	const first = savedSeqOf(source?.message);
	if (first === undefined) return undefined;
	if (source?.result === undefined) return { first, last: first };
	const last = savedSeqOf(source.result);
	return last === undefined ? undefined : { first: Math.min(first, last), last: Math.max(first, last) };
}
/** A drawn row's identity among saved rows: its message's saved sequence and its position among that message's rows. */
export function savedRowKey(row: object): string | undefined {
	const source = rowSources.get(row);
	const seq = savedSeqOf(source?.message);
	return seq === undefined ? undefined : `${seq}:${source!.part}`;
}
