import type { CustomEntry, ExtensionContext, SessionEntry } from "@bastani/atomic";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import type { SubagentChildRecord } from "./subagent-child-records.js";
import { reopenChildSession } from "./subagent-child-session.js";

/** Session entry type that durably records each background child a session launched (#3760). */
export const SUBAGENT_CHILD_RECORD_TYPE = "subagent-child";

/**
 * `terminalStatus` of a background child released while it waited on detached tool calls (#4326): it holds no session,
 * task or connection, and a tool result, an Intercom send or ask, or `resume` rehydrates it from its session.
 */
export const SUBAGENT_CHILD_RELEASED_STATUS = "released";

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

/**
 * What the index keeps of one child (#4395): who it is, where it stands, and which session entry holds its latest
 * record. Plain data of a fixed shape: the task, held messages and held results stay in that entry, so the index entry
 * does not grow with the child's history.
 */
export interface SubagentChildIndexEntry {
	readonly childId: string;
	readonly runId: string;
	readonly index: number;
	readonly agent: string;
	readonly ownerSessionId?: string;
	readonly state: SubagentChildRecord["state"];
	readonly cwd: string;
	readonly taskId?: string;
	readonly terminalStatus?: string;
	readonly childSessionId?: string;
	readonly childSessionFile?: string;
	readonly intercomTarget?: string;
	/** The session entry that holds the child's latest record; absent while that record is not saved yet. */
	readonly entryId?: string;
	/** The session that entry is in, when it is not the owner's: a fork copies the records of the session it forked. */
	readonly recordedIn?: string;
	/** Read from a session that did not launch the child; it never replaces what the owner's own records said. */
	readonly copied?: true;
}

/** Where a saved record is: its entry, and the session that entry is in. */
export interface SubagentChildRecordLocation {
	readonly entryId: string;
	readonly sessionId: string;
}

type RecordReader = Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntry" | "getLeafEntry">;

const TRANSCRIPT_LINES = 12;
const TRANSCRIPT_LINE_CHARS = 200;
/** How often an expanded card of a running child, which keeps saving messages, reads its transcript again. */
const RUNNING_TRANSCRIPT_REFRESH_MS = 1_000;
/** How far up from a session's leaf an entry this process just appended is looked for. */
const APPENDED_ENTRY_SEARCH_DEPTH = 32;

const entries = new Map<string, SubagentChildIndexEntry>();
/**
 * Latest records the index cannot point at yet: their append is in flight, failed, or was deferred while a reload
 * started extensions, or the session holds only partial records an older Atomic wrote. Each leaves once a complete
 * record of its child is saved and found.
 */
const unsavedRecords = new Map<string, SubagentChildRecord>();
/** The sessions full records are read from, by session id; held weakly, so a closed session is not kept alive. */
const readers = new Map<string, WeakRef<RecordReader>>();
const childIdsByTaskId = new Map<string, string>();
const watchers = new Map<string, Set<WeakRef<object>>>();
const invalidators = new WeakMap<object, () => void>();
interface TranscriptCache {
	readonly key: string;
	lines?: readonly string[];
}
/** Each card's transcripts, by child id: they are dropped with the card. */
const transcripts = new WeakMap<object, Map<string, TranscriptCache>>();
const loadedOwners = new Set<string>();
let source: Pick<ExtensionContext, "sessionManager"> | undefined;

interface WatchedCard {
	readonly key: string;
	readonly cards: Set<WeakRef<object>>;
	readonly ref: WeakRef<object>;
}

/** A card that is gone stops being watched, and its key goes with its last card. */
const collectedCards = new FinalizationRegistry<WatchedCard>(({ key, cards, ref }) => {
	cards.delete(ref);
	if (cards.size === 0) watchers.delete(key);
});

function notify(key: string): void {
	const cards = watchers.get(key);
	if (!cards) return;
	for (const ref of cards) {
		const card = ref.deref();
		const invalidate = card ? invalidators.get(card) : undefined;
		if (invalidate) invalidate();
	}
}

/** Read full records of `sessionManager`'s session from it; `replace` makes it the reader even if one is registered. */
export function registerSubagentChildRecordReader(sessionManager: RecordReader, replace = false): void {
	const sessionId = sessionManager.getSessionId();
	if (!replace && readers.get(sessionId)?.deref() !== undefined) return;
	readers.set(sessionId, new WeakRef(sessionManager));
}

function projectionOf(
	record: SubagentChildRecord,
	copied: boolean,
	saved: SubagentChildRecordLocation | undefined,
): SubagentChildIndexEntry {
	const ownerSessionId = record.owner?.sessionId;
	return {
		childId: record.childId,
		runId: record.runId,
		index: record.index,
		agent: record.agent,
		...(ownerSessionId === undefined ? {} : { ownerSessionId }),
		state: record.state,
		cwd: record.cwd,
		...(record.taskId === undefined ? {} : { taskId: record.taskId }),
		...(record.terminalStatus === undefined ? {} : { terminalStatus: record.terminalStatus }),
		...(record.childSessionId === undefined ? {} : { childSessionId: record.childSessionId }),
		...(record.childSessionFile === undefined ? {} : { childSessionFile: record.childSessionFile }),
		...(record.intercomTarget === undefined ? {} : { intercomTarget: record.intercomTarget }),
		...(saved === undefined ? {} : { entryId: saved.entryId }),
		...(saved === undefined || saved.sessionId === ownerSessionId ? {} : { recordedIn: saved.sessionId }),
		...(copied ? { copied: true as const } : {}),
	};
}

function savedRecordOf(entry: SubagentChildIndexEntry): SubagentChildRecord {
	const sessionId = entry.recordedIn ?? entry.ownerSessionId;
	const reader = sessionId === undefined ? undefined : readers.get(sessionId)?.deref();
	const saved = entry.entryId === undefined ? undefined : reader?.getEntry(entry.entryId);
	const data = saved !== undefined && isSubagentChildRecord(saved) ? saved.data : undefined;
	if (data?.childId === entry.childId) return data;
	throw new ReleasedChildError("child-record-unreadable", {
		childId: entry.childId,
		...(entry.ownerSessionId === undefined ? {} : { ownerSessionId: entry.ownerSessionId }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(entry.entryId === undefined ? {} : { entryId: entry.entryId }),
	});
}

function fullRecordOf(entry: SubagentChildIndexEntry): SubagentChildRecord {
	return unsavedRecords.get(entry.childId) ?? savedRecordOf(entry);
}

/**
 * The child's full latest record, or undefined when the session holding it is not open in this process: a newer
 * observation of the child is then indexed as written, which is what a fold of that session's own history gives.
 */
function readableRecordOf(entry: SubagentChildIndexEntry): SubagentChildRecord | undefined {
	try {
		return fullRecordOf(entry);
	} catch (error) {
		if (isReleasedChildError(error as Error) && (error as ReleasedChildError).code === "child-record-unreadable")
			return undefined;
		throw error;
	}
}

function acceptsObservation(existing: SubagentChildIndexEntry | undefined, copied: boolean): boolean {
	return !copied || existing === undefined || existing.copied === true;
}

function hasEveryKeyOf(record: SubagentChildRecord, merged: SubagentChildRecord): boolean {
	return Object.keys(merged).every((key) => Object.hasOwn(record, key));
}

/**
 * Fold a child record into the index and redraw the cards of that child; returns the child's full latest record: the
 * record merged over the latest one of the same owner, which it is then saved as. A `copied` record was read from a
 * session that did not launch the child (a fork copies the original's records): it never replaces state the owner's
 * own records gave, which may be newer. With `saved`, the record is the one in that entry, and the index points at the
 * entry when it holds everything the child's merged record has.
 */
export function observeSubagentChildRecord(
	record: SubagentChildRecord,
	copied = false,
	saved?: SubagentChildRecordLocation,
): SubagentChildRecord {
	const existing = entries.get(record.childId);
	if (!acceptsObservation(existing, copied)) return record;
	const sameOwner = existing?.ownerSessionId === record.owner?.sessionId;
	const previous = existing === undefined || !sameOwner ? undefined : readableRecordOf(existing);
	const merged = previous ? { ...previous, ...record } : record;
	const complete = saved !== undefined && hasEveryKeyOf(record, merged);
	if (complete) unsavedRecords.delete(record.childId);
	else unsavedRecords.set(record.childId, merged);
	entries.set(record.childId, projectionOf(merged, copied, complete ? saved : undefined));
	notify(record.childId);
	indexTaskId(merged);
	return merged;
}

/** A card finds a child by any task id it ran as; a released child's task is no longer one. */
function indexTaskId(record: SubagentChildRecord): void {
	if (record.taskId === undefined) return;
	if (record.state === "terminal" && record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) {
		if (childIdsByTaskId.get(record.taskId) === record.childId) childIdsByTaskId.delete(record.taskId);
	} else if (!childIdsByTaskId.has(record.taskId)) childIdsByTaskId.set(record.taskId, record.childId);
	notify(record.taskId);
}

/**
 * The entry `record` was just appended as, in its owner's session: the leaf, or one an append that followed it moved
 * the leaf past. Undefined when it is not there, as while a reload defers the appends of the extensions it starts.
 */
export function findAppendedSubagentChildRecord(record: SubagentChildRecord): SubagentChildRecordLocation | undefined {
	const sessionId = record.owner?.sessionId;
	const reader = sessionId === undefined ? undefined : readers.get(sessionId)?.deref();
	if (sessionId === undefined || reader === undefined) return undefined;
	let entry = reader.getLeafEntry();
	for (let depth = 0; entry !== undefined && depth < APPENDED_ENTRY_SEARCH_DEPTH; depth++) {
		if (entry.type === "custom" && entry.data === record) return { entryId: entry.id, sessionId };
		entry = entry.parentId === null ? undefined : reader.getEntry(entry.parentId);
	}
	return undefined;
}

/**
 * Point the index at the entry `record` was saved as, once its owner's append of it resolved, unless a newer record of
 * the child was observed since. A record whose entry is not found stays in memory until a later record of its child is
 * found. Only an owner's own records are appended, so the entry is never a copy.
 */
export function settleSubagentChildRecord(record: SubagentChildRecord): void {
	if (!isUnsavedSubagentChildRecord(record)) return;
	const saved = findAppendedSubagentChildRecord(record);
	if (saved === undefined) return;
	unsavedRecords.delete(record.childId);
	entries.set(record.childId, projectionOf(record, false, saved));
}

/** Whether `record` is the latest record of its child and is not saved as one entry yet. */
export function isUnsavedSubagentChildRecord(record: SubagentChildRecord): boolean {
	return unsavedRecords.get(record.childId) === record;
}

/**
 * The children of `ownerSessionId` whose latest record is not saved as one complete entry, as when the session holds
 * only the partial records an older Atomic wrote; their owner appends each once (#4395).
 */
export function unsavedSubagentChildRecordsOf(ownerSessionId: string): SubagentChildRecord[] {
	const unsaved: SubagentChildRecord[] = [];
	for (const record of unsavedRecords.values()) if (record.owner?.sessionId === ownerSessionId) unsaved.push(record);
	return unsaved;
}

interface FoldedRecord {
	record: SubagentChildRecord;
	latest: SubagentChildRecord;
	entryId: string;
}

function copiedInto(record: SubagentChildRecord, sessionId: string): boolean {
	const owner = record.owner?.sessionId;
	return owner !== undefined && owner !== sessionId;
}

/**
 * Fold a session's records per child, then index each child once from its latest entry. Every task id a child ran as
 * is indexed on the way, so its card finds it by any of them.
 */
function observeEntries(sessionEntries: readonly SessionEntry[], sessionId: string): void {
	const folded = new Map<string, FoldedRecord>();
	for (const entry of sessionEntries) {
		if (!isSubagentChildRecord(entry)) continue;
		const data = entry.data as SubagentChildRecord;
		const previous = folded.get(data.childId);
		const record = previous === undefined ? data : { ...previous.record, ...data };
		folded.set(data.childId, { record, latest: data, entryId: entry.id });
		if (acceptsObservation(entries.get(data.childId), copiedInto(data, sessionId))) indexTaskId(record);
	}
	for (const { record, latest, entryId } of folded.values()) {
		const copied = copiedInto(record, sessionId);
		if (hasEveryKeyOf(latest, record)) observeSubagentChildRecord(latest, copied, { entryId, sessionId });
		else observeSubagentChildRecord(record, copied);
	}
}

/** Read the child records of the session a card is shown in, and keep its store for records and transcripts. */
export function bindSubagentChildCards(ctx: Pick<ExtensionContext, "sessionManager">): void {
	source = ctx;
	registerSubagentChildRecordReader(ctx.sessionManager, true);
	loadedOwners.add(ctx.sessionManager.getSessionId());
	observeEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
}

/**
 * Index `ctx`'s session once, if it was not read yet: the wake path then finds a child without scanning the owner's
 * whole history, however many children it launched.
 */
export function indexSubagentChildOwner(ctx: Pick<ExtensionContext, "sessionManager">): void {
	const ownerSessionId = ctx.sessionManager.getSessionId();
	registerSubagentChildRecordReader(ctx.sessionManager);
	if (loadedOwners.has(ownerSessionId)) return;
	loadedOwners.add(ownerSessionId);
	observeEntries(ctx.sessionManager.getEntries(), ownerSessionId);
}

function ownEntry(ownerSessionId: string, childId: string): SubagentChildIndexEntry | undefined {
	const entry = entries.get(childId);
	return entry?.ownerSessionId === ownerSessionId ? entry : undefined;
}

/**
 * The latest record of one of `ownerSessionId`'s children, read through the index; undefined for a child it did not
 * launch. Throws a {@link ReleasedChildError} `child-record-unreadable` when the session holding that record is not
 * open in this process.
 */
export function subagentChildRecordOf(ownerSessionId: string, childId: string): SubagentChildRecord | undefined {
	const entry = ownEntry(ownerSessionId, childId);
	return entry === undefined ? undefined : fullRecordOf(entry);
}

/** The child of `ownerSessionId` that was launched with this Intercom name. Walks the index, as a wake by name is rare. */
export function subagentChildRecordForTarget(
	ownerSessionId: string,
	intercomTarget: string,
): SubagentChildRecord | undefined {
	if (typeof intercomTarget !== "string") return undefined;
	let found: SubagentChildIndexEntry | undefined;
	for (const entry of entries.values())
		if (entry.intercomTarget === intercomTarget && entry.ownerSessionId === ownerSessionId) found = entry;
	return found === undefined ? undefined : fullRecordOf(found);
}

/** Every child of `ownerSessionId` in the index. Walks the whole index: for a restart or a reconnect, not a wake. */
export function subagentChildRecordsOf(ownerSessionId: string): SubagentChildRecord[] {
	const records: SubagentChildRecord[] = [];
	for (const entry of entries.values()) if (entry.ownerSessionId === ownerSessionId) records.push(fullRecordOf(entry));
	return records;
}

/** Ids of every child of `ownerSessionId` in the index, without reading their records. */
export function subagentChildIdsOf(ownerSessionId: string): string[] {
	const childIds: string[] = [];
	for (const entry of entries.values()) if (entry.ownerSessionId === ownerSessionId) childIds.push(entry.childId);
	return childIds;
}

/** How many children the index holds; counted by tests and the benchmark. */
export function subagentChildIndexSize(): number {
	return entries.size;
}

/** What the index keeps of a child, by its child id; read by tests and the benchmark. */
export function subagentChildIndexEntry(childId: string): SubagentChildIndexEntry | undefined {
	return entries.get(childId);
}

/**
 * What a launch card shows of a child, by its child id or any task id it ran as. A released child keeps no task id
 * entry, so its current task is found by walking the index.
 */
export function subagentChildCardRecord(
	childId: string | undefined,
	taskId: string,
): SubagentChildIndexEntry | undefined {
	const id = childId ?? childIdsByTaskId.get(taskId);
	if (id !== undefined) return entries.get(id);
	for (const entry of entries.values()) if (entry.taskId === taskId) return entry;
	return undefined;
}

/** Run ids of the children this process has seen records of whose owner is `ownerSessionId`. */
export function observedSubagentRunIds(ownerSessionId: string): Set<string> {
	const runIds = new Set<string>();
	for (const entry of entries.values()) if (entry.ownerSessionId === ownerSessionId) runIds.add(entry.runId);
	return runIds;
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
	if (![...cards].some((ref) => ref.deref() === card)) {
		const ref = new WeakRef(card);
		cards.add(ref);
		collectedCards.register(card, { key, cards, ref });
	}
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
 * The tail of a child's own saved transcript as `card` shows it, undefined until it is read. A settled child's is
 * loaded once per record state; a running child keeps saving messages, so its card reads it again at most once per
 * refresh interval. The card keeps what it read, and it goes with the card.
 */
export function subagentChildTranscript(card: object, record: SubagentChildIndexEntry): readonly string[] | undefined {
	if (record.childSessionId === undefined && record.childSessionFile === undefined) return undefined;
	const running = record.state === "running";
	const refresh = running ? `:${Math.floor(Date.now() / RUNNING_TRANSCRIPT_REFRESH_MS)}` : "";
	const key = `${record.taskId}:${record.state}:${record.terminalStatus}${refresh}`;
	const cache = transcripts.get(card) ?? new Map<string, TranscriptCache>();
	transcripts.set(card, cache);
	const cached = cache.get(record.childId);
	if (cached?.key === key) return cached.lines;
	const from = source;
	if (!from) return cached?.lines;
	const entry: TranscriptCache = {
		key,
		...(cached?.lines ? { lines: cached.lines } : {}),
	};
	cache.set(record.childId, entry);
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

/** What the child index and the cards keep, by kind; counted by tests and the benchmark. */
export function subagentChildCardStateSizes(): {
	readonly records: number;
	readonly unsavedRecords: number;
	readonly taskIds: number;
	readonly owners: number;
	readonly readers: number;
	readonly watchers: number;
} {
	return {
		records: entries.size,
		unsavedRecords: unsavedRecords.size,
		taskIds: childIdsByTaskId.size,
		owners: loadedOwners.size,
		readers: readers.size,
		watchers: watchers.size,
	};
}
