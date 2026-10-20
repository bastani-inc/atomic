import type { CustomEntry, ExtensionContext, SessionEntry } from "@bastani/atomic";
import type { SubagentChildRecord } from "./subagent-child-records.js";
import { reopenChildSession } from "./subagent-child-session.js";

/** Session entry type that durably records each background child a session launched (#3760). */
export const SUBAGENT_CHILD_RECORD_TYPE = "subagent-child";

export function isSubagentChildRecord(value: SessionEntry): value is CustomEntry<SubagentChildRecord> {
	if (value.type !== "custom" || value.customType !== SUBAGENT_CHILD_RECORD_TYPE) return false;
	const data = value.data as Partial<SubagentChildRecord> | undefined;
	return (
		data?.version === 1 &&
		typeof data.childId === "string" &&
		typeof data.runId === "string" &&
		typeof data.index === "number" &&
		typeof data.agent === "string" &&
		typeof data.cwd === "string" &&
		(data.state === "running" || data.state === "terminal")
	);
}

const TRANSCRIPT_LINES = 12;
const TRANSCRIPT_LINE_CHARS = 200;
/** How often an expanded card of a running child, which keeps saving messages, reads its transcript again. */
const RUNNING_TRANSCRIPT_REFRESH_MS = 1_000;

const latest = new Map<string, SubagentChildRecord>();
/** Children whose state came from their owner: written live, or read from the owner's own session. */
const fromOwner = new Set<string>();
const childIdsByTaskId = new Map<string, string>();
const watchers = new Map<string, Set<WeakRef<object>>>();
const invalidators = new WeakMap<object, () => void>();
const transcripts = new Map<string, { readonly key: string; lines?: readonly string[] }>();
const loadedOwners = new Set<string>();
let source: Pick<ExtensionContext, "sessionManager"> | undefined;

function notify(key: string): void {
	const cards = watchers.get(key);
	if (!cards) return;
	for (const ref of cards) {
		const card = ref.deref();
		const invalidate = card ? invalidators.get(card) : undefined;
		if (invalidate) invalidate();
		else cards.delete(ref);
	}
}

/**
 * Fold a child record into what launch cards show, and redraw the cards of that child. A `copied` record was read from
 * a session that did not launch the child (a fork copies the original's records): it never replaces state the owner's
 * own records gave, which may be newer.
 */
export function observeSubagentChildRecord(record: SubagentChildRecord, copied = false): void {
	if (copied && fromOwner.has(record.childId)) return;
	if (!copied) fromOwner.add(record.childId);
	const previous = latest.get(record.childId);
	latest.set(record.childId, previous ? { ...previous, ...record } : record);
	notify(record.childId);
	if (record.taskId === undefined) return;
	if (!childIdsByTaskId.has(record.taskId)) childIdsByTaskId.set(record.taskId, record.childId);
	notify(record.taskId);
}

function observeEntries(entries: readonly SessionEntry[], sessionId: string): void {
	for (const entry of entries) {
		if (!isSubagentChildRecord(entry)) continue;
		const record = entry.data as SubagentChildRecord;
		const owner = record.owner?.sessionId;
		observeSubagentChildRecord(record, owner !== undefined && owner !== sessionId);
	}
}

/** Read the child records of the session a card is shown in, and keep its store for records and transcripts. */
export function bindSubagentChildCards(ctx: Pick<ExtensionContext, "sessionManager">): void {
	source = ctx;
	loadedOwners.add(ctx.sessionManager.getSessionId());
	observeEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
}

/** The latest record of the child a launch card shows, by its child id or any task id it ran as. */
export function subagentChildCardRecord(childId: string | undefined, taskId: string): SubagentChildRecord | undefined {
	const id = childId ?? childIdsByTaskId.get(taskId);
	return id === undefined ? undefined : latest.get(id);
}

/**
 * Redraw a card when its child's records change. A card shown outside its owner's session (a workflow stage's
 * transcript) reads that session's records from the store once.
 */
export function watchSubagentChildCard(
	card: object,
	invalidate: () => void,
	key: string,
	ownerSessionId: string | undefined,
): void {
	invalidators.set(card, invalidate);
	const cards = watchers.get(key) ?? new Set<WeakRef<object>>();
	watchers.set(key, cards);
	if (![...cards].some((ref) => ref.deref() === card)) cards.add(new WeakRef(card));
	if (ownerSessionId === undefined || loadedOwners.has(ownerSessionId) || !source) return;
	loadedOwners.add(ownerSessionId);
	const from = source;
	void (async () => {
		const snapshot = await from.sessionManager.getSessionStore().load(ownerSessionId);
		observeEntries(snapshot.entries, ownerSessionId);
	})().catch(() => undefined);
}

type TranscriptPart = { readonly type: string; readonly text?: string; readonly name?: string };
type TranscriptMessage = { readonly role: string; readonly content?: string | readonly TranscriptPart[] };

function transcriptLines(messages: readonly TranscriptMessage[]): string[] {
	const lines: string[] = [];
	for (const message of messages) {
		const parts =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
		for (const part of parts) {
			const text =
				part.type === "text" && part.text?.trim()
					? `${message.role === "user" ? "› " : ""}${part.text.trim().replace(/\s+/g, " ")}`
					: part.type === "toolCall" && part.name
						? `→ ${part.name}`
						: undefined;
			if (text && (message.role === "user" || message.role === "assistant"))
				lines.push(text.length > TRANSCRIPT_LINE_CHARS ? `${text.slice(0, TRANSCRIPT_LINE_CHARS - 1)}…` : text);
		}
	}
	return lines.slice(-TRANSCRIPT_LINES);
}

function sameLines(left: readonly string[] | undefined, right: readonly string[]): boolean {
	return left?.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * The tail of a child's own saved transcript, undefined until it is read. A settled child's is loaded once per record
 * state; a running child keeps saving messages, so its card reads it again at most once per refresh interval.
 */
export function subagentChildTranscript(record: SubagentChildRecord): readonly string[] | undefined {
	if (record.childSessionId === undefined && record.childSessionFile === undefined) return undefined;
	const running = record.state === "running";
	const refresh = running ? `:${Math.floor(Date.now() / RUNNING_TRANSCRIPT_REFRESH_MS)}` : "";
	const key = `${record.taskId}:${record.state}:${record.terminalStatus}${refresh}`;
	const cached = transcripts.get(record.childId);
	if (cached?.key === key) return cached.lines;
	const from = source;
	if (!from) return cached?.lines;
	const entry: { readonly key: string; lines?: readonly string[] } = {
		key,
		...(cached?.lines ? { lines: cached.lines } : {}),
	};
	transcripts.set(record.childId, entry);
	void (async () => {
		const reopened = await reopenChildSession(from, record);
		if ("reason" in reopened) return;
		const lines = transcriptLines(
			reopened.sessionManager.buildSessionContext().messages as readonly TranscriptMessage[],
		);
		const changed = !sameLines(entry.lines, lines);
		entry.lines = lines;
		if (changed) notify(record.childId);
		// Redraw once the next refresh is due; that draw reads the transcript again while the child still runs.
		if (running) setTimeout(() => notify(record.childId), RUNNING_TRANSCRIPT_REFRESH_MS).unref?.();
	})().catch(() => undefined);
	return entry.lines;
}
