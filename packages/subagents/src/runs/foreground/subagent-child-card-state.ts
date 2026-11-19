import type { CustomEntry, ExtensionContext, SessionEntry } from "@bastani/atomic";
import { pathExists } from "../../shared/path-exists.js";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import type { SubagentChildRecord } from "./subagent-child-records.js";
import type { SessionStoreSource } from "./subagent-child-session.js";

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
	readonly elapsedMs?: number;
	readonly elapsedSpan?: SubagentChildRecord["elapsedSpan"];
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

/** How often an expanded card of a running child, which keeps saving messages, reads its transcript again. */
const RUNNING_TRANSCRIPT_REFRESH_MS = 1_000;
/** How far up from a session's leaf an entry this process just appended is looked for. */
const APPENDED_ENTRY_SEARCH_DEPTH = 32;

// Tasks and their record writes survive re-evaluation of the extension. Every generation reads the same latest row.
function newChildIndex() {
	const watchers = new Map<string, Set<WeakRef<object>>>();
	return {
		entries: new Map<string, SubagentChildIndexEntry>(),
		// A record not yet found as a complete saved entry: pending, deferred, failed or from a partial older record.
		unsavedRecords: new Map<string, SubagentChildRecord>(),
		pendingWrites: new WeakSet<SubagentChildRecord>(),
		// Open copies of a session, preferred first. Do not retain a closed copy (#5252).
		readers: new Map<string, WeakRef<RecordReader>[]>(),
		childIdsByTaskId: new Map<string, string>(),
		watchers,
		invalidators: new WeakMap<object, () => void>(),
		collectedCards: new FinalizationRegistry<WatchedCard>(({ key, cards, ref }) => {
			cards.delete(ref);
			if (cards.size === 0) watchers.delete(key);
		}),
	};
}
const INDEX = Symbol.for("@bastani/subagents/child-record-index@1");
const processIndex = globalThis as { [INDEX]?: ReturnType<typeof newChildIndex> };
processIndex[INDEX] ??= newChildIndex();
const { entries, unsavedRecords, pendingWrites, readers, childIdsByTaskId, watchers, invalidators, collectedCards } =
	processIndex[INDEX];

export { pendingWrites as pendingSubagentChildWrites };
export interface SubagentChildToolCallEntry {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly resultContent?: readonly {
		readonly type: string;
		readonly text?: string;
		readonly data?: string;
		readonly mimeType?: string;
	}[];
	readonly resultDetails?: unknown;
	readonly resultText?: string;
	readonly isError?: boolean;
	readonly durationMs?: number;
	readonly completed: boolean;
}

export interface SubagentChildTranscriptDetails {
	readonly prompt?: string;
	readonly toolCalls: readonly SubagentChildToolCallEntry[];
	readonly result?: string;
	readonly unavailable?: string;
	readonly lines: readonly string[];
}

interface TranscriptCache {
	readonly key: string;
	readonly cancel: AbortController;
	lines?: readonly string[];
	details?: SubagentChildTranscriptDetails;
}
/** Each card's transcripts, by child id: they are dropped with the card. */
const transcripts = new WeakMap<object, Map<string, TranscriptCache>>();
const transcriptGenerations = new WeakMap<object, number>();
const loadedOwners = new Set<string>();
/**
 * The session store cards read owners' records and children's transcripts from: the latest bound session's, never that
 * session itself, which ends while the process and its cards go on.
 */
type CardSource = SessionStoreSource & { readonly expanded: Set<WeakRef<object>> };
let source: CardSource | undefined;
const boundCards = new WeakMap<object, { owner: CardSource; ref: WeakRef<object> }>();
const removedCards = new FinalizationRegistry<{ owner: WeakRef<CardSource>; ref: WeakRef<object> }>(({ owner, ref }) =>
	owner.deref()?.expanded.delete(ref),
);
const releaseSections = new WeakMap<object, (card: object) => void>();
export function onSubagentCardDiscard(card: object, release: (card: object) => void) {
	releaseSections.set(card, release);
}

interface WatchedCard {
	readonly key: string;
	readonly cards: Set<WeakRef<object>>;
	readonly ref: WeakRef<object>;
}

function notify(key: string): void {
	const cards = watchers.get(key);
	if (!cards) return;
	for (const ref of cards) {
		const card = ref.deref();
		const invalidate = card ? invalidators.get(card) : undefined;
		if (invalidate) invalidate();
	}
}

/** The open copies of a session's records, the preferred first; copies that were collected are forgotten. */
function readersOf(sessionId: string): RecordReader[] {
	const refs = readers.get(sessionId);
	if (refs === undefined) return [];
	const live: RecordReader[] = [];
	const kept = refs.filter((ref) => {
		const reader = ref.deref();
		if (reader !== undefined) live.push(reader);
		return reader !== undefined;
	});
	if (kept.length === 0) readers.delete(sessionId);
	else if (kept.length !== refs.length) readers.set(sessionId, kept);
	return live;
}

/**
 * Read full records of `sessionManager`'s session from it. A reader registered before is still preferred, and this one
 * is read once that one is collected; `replace` makes it the only reader.
 */
export function registerSubagentChildRecordReader(sessionManager: RecordReader, replace = false): void {
	const sessionId = sessionManager.getSessionId();
	if (replace) {
		readers.set(sessionId, [new WeakRef(sessionManager)]);
		return;
	}
	const live = readersOf(sessionId);
	if (live.includes(sessionManager)) return;
	readers.set(sessionId, [...(readers.get(sessionId) ?? []), new WeakRef(sessionManager)]);
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
		...(record.elapsedMs === undefined ? {} : { elapsedMs: record.elapsedMs }),
		...(record.elapsedSpan === undefined ? {} : { elapsedSpan: record.elapsedSpan }),
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
	const entryId = entry.entryId;
	if (sessionId !== undefined && entryId !== undefined) {
		for (const reader of readersOf(sessionId)) {
			const saved = reader.getEntry(entryId);
			const data = saved !== undefined && isSubagentChildRecord(saved) ? saved.data : undefined;
			if (data?.childId === entry.childId) return data;
		}
	}
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
	const reader = sessionId === undefined ? undefined : readersOf(sessionId)[0];
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
		// A preserving reload reads the previous durable row while this child's newer observation waits to append.
		const pending = unsavedRecords.get(record.childId);
		if (pending !== undefined && pendingWrites.has(pending)) continue;
		const copied = copiedInto(record, sessionId);
		if (hasEveryKeyOf(latest, record)) observeSubagentChildRecord(latest, copied, { entryId, sessionId });
		else observeSubagentChildRecord(record, copied);
	}
}

/** Read the child records of the session a card is shown in, and keep its store for records and transcripts. */
export function bindSubagentChildCards(ctx: Pick<ExtensionContext, "sessionManager">): () => void {
	const store = ctx.sessionManager.getSessionStore();
	const bound: CardSource = { sessionManager: { getSessionStore: () => store }, expanded: new Set() };
	source = bound;
	registerSubagentChildRecordReader(ctx.sessionManager, true);
	loadedOwners.add(ctx.sessionManager.getSessionId());
	observeEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
	return () => {
		for (const weak of bound.expanded) {
			const card = weak.deref();
			if (card) clearSubagentChildTranscriptCache(card);
		}
		bound.expanded.clear();
		if (source === bound) source = undefined;
	};
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

/**
 * The latest record of one of `ownerSessionId`'s children, or undefined when it did not launch it or when the session
 * holding that record is not open in this process. For callers that must not fail on a record they cannot read: a
 * workflow stage's close, a restore that reads the owner's own session instead, a wake that only looks for results.
 */
export function readableSubagentChildRecordOf(
	ownerSessionId: string,
	childId: string,
): SubagentChildRecord | undefined {
	const entry = ownEntry(ownerSessionId, childId);
	return entry === undefined ? undefined : readableRecordOf(entry);
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

/**
 * Every child of `ownerSessionId` in the index whose latest record can be read. Walks the whole index: for a restart or a
 * reconnect, not a wake. A child whose record is in a session not open in this process is left out, so it does not stop
 * the others from being reserved, reported ended or woken; a wake of it reads it again and reports why it cannot.
 */
export function subagentChildRecordsOf(ownerSessionId: string): SubagentChildRecord[] {
	const records: SubagentChildRecord[] = [];
	for (const entry of entries.values()) {
		if (entry.ownerSessionId !== ownerSessionId) continue;
		const record = readableRecordOf(entry);
		if (record !== undefined) records.push(record);
	}
	return records;
}

/** Look up the latest records for one reservation batch: index names once, on demand, but never cache a child's state. */
export function reservationRecordLookup(ownerSessionId: string): (name: string) => SubagentChildRecord | undefined {
	let ids: Map<string, string> | undefined;
	return (name) => {
		if (ids === undefined) {
			ids = new Map();
			for (const entry of entries.values()) {
				if (entry.ownerSessionId !== ownerSessionId) continue;
				const target = entry.intercomTarget;
				if (target !== undefined) ids.set(target, entry.childId);
			}
		}
		const id = ids.get(name);
		const record = id === undefined ? undefined : readableSubagentChildRecordOf(ownerSessionId, id);
		return record?.intercomTarget === name ? record : undefined;
	};
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

/**
 * What the index keeps of a child, by its child id: where it stands even when its full record cannot be read, as a
 * closing workflow stage needs. Read by tests and the benchmark too.
 */
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

function unwrapPrompt(task: string): string {
	let text = task;
	const forkMarker = "\n\nTask:\n";
	const forkIndex = text.indexOf(forkMarker);
	if (forkIndex >= 0 && text.startsWith("You are continuing from")) {
		text = text.slice(forkIndex + forkMarker.length);
	}
	text = text.replace(
		/\n\n---\n(?:Create and maintain progress at:|Update progress at:|Write your findings to:)(?:[^\S\n]*\n)*[^\n]+$/g,
		"",
	);
	text = text.replace(/\n\n\[Write to:(?:[^\S\n]*\n)*[^\]\n]+\]\s*$/i, "");
	return text.trim();
}

async function readCard(
	from: SessionStoreSource,
	entry: SubagentChildIndexEntry,
	signal: AbortSignal,
): Promise<SubagentChildTranscriptDetails> {
	const { readExpandedChildDetails, readSavedChildLaunch } = await import("@bastani/atomic/storage");
	const { JsonlSessionStore } = await import("@bastani/atomic");
	const owner = from.sessionManager.getSessionStore();
	const parentId = entry.recordedIn ?? entry.ownerSessionId;
	const launch = async () =>
		readableRecordOf(entry) ??
		(parentId !== undefined && entry.entryId
			? await readSavedChildLaunch(owner, parentId, entry.entryId, entry.childId, signal).catch(() => {
					signal.throwIfAborted();
					return undefined;
				})
			: undefined);
	const unavailable = (reason: string) => ({
		toolCalls: [],
		lines: [],
		unavailable: `Transcript unavailable · ${reason}`,
	});
	try {
		const file = entry.childSessionFile;
		if (file && !(await pathExists(file))) return unavailable(`its session file is missing: ${file}`);
		const details = file
			? await JsonlSessionStore.withFileReader(file, async (store, id) =>
					entry.childSessionId !== undefined && entry.childSessionId !== id
						? unavailable("its session file now belongs to a different session")
						: readExpandedChildDetails(store, id, await launch(), { signal }),
				)
			: entry.childSessionId === undefined
				? unavailable("no session was recorded for it")
				: await readExpandedChildDetails(owner, entry.childSessionId, await launch(), { signal });
		if ("prompt" in details && details.prompt !== undefined)
			return { ...details, prompt: unwrapPrompt(details.prompt) };
		return details;
	} catch (error) {
		if (error instanceof Error && error.name === "SessionNotFoundError")
			return unavailable("its session no longer exists in the session store");
		throw error;
	}
}

function sameLines(left: readonly string[] | undefined, right: readonly string[]): boolean {
	return left?.length === right.length && left.every((line, index) => line === right[index]);
}

function sameDetails(left: SubagentChildTranscriptDetails | undefined, right: SubagentChildTranscriptDetails): boolean {
	if (!left) return false;
	return (
		left.prompt === right.prompt &&
		left.result === right.result &&
		left.unavailable === right.unavailable &&
		left.toolCalls.length === right.toolCalls.length &&
		left.toolCalls.every(
			(call, index) =>
				call.id === right.toolCalls[index]?.id &&
				call.completed === right.toolCalls[index]?.completed &&
				call.resultText === right.toolCalls[index]?.resultText,
		) &&
		sameLines(left.lines, right.lines)
	);
}

export function subagentChildCardTask(record: SubagentChildIndexEntry): string | undefined {
	return readableRecordOf(record)?.task;
}

export function clearSubagentChildTranscriptCache(card: object): void {
	for (const entry of transcripts.get(card)?.values() ?? []) {
		entry.cancel.abort();
		entry.details = undefined;
		entry.lines = undefined;
	}
	const binding = boundCards.get(card);
	if (binding) {
		binding.owner.expanded.delete(binding.ref);
		removedCards.unregister(binding.ref);
		boundCards.delete(card);
	}
	releaseSections.get(card)?.(card);
	transcripts.delete(card);
	transcriptGenerations.set(card, (transcriptGenerations.get(card) ?? 0) + 1);
}

export function subagentChildTranscriptDetails(
	card: object,
	record: SubagentChildIndexEntry,
): SubagentChildTranscriptDetails | undefined {
	if (record.childSessionId === undefined && record.childSessionFile === undefined) return undefined;
	const running = record.state === "running";
	const refresh = running ? `:${Math.floor(Date.now() / RUNNING_TRANSCRIPT_REFRESH_MS)}` : "";
	const key = `${record.taskId}:${record.state}:${record.terminalStatus}${refresh}`;
	const cache = transcripts.get(card) ?? new Map<string, TranscriptCache>();
	transcripts.set(card, cache);
	const cached = cache.get(record.childId);
	if (cached?.key === key) return cached.details;
	const from = source;
	if (!from) return cached?.details;
	const gen = transcriptGenerations.get(card) ?? 0;
	if (!boundCards.has(card)) {
		const ref = new WeakRef(card);
		from.expanded.add(ref);
		boundCards.set(card, { owner: from, ref });
		removedCards.register(card, { owner: new WeakRef(from), ref }, ref);
	}
	cached?.cancel.abort();
	const entry: TranscriptCache = {
		key,
		cancel: new AbortController(),
		...(cached?.lines ? { lines: cached.lines } : {}),
		...(cached?.details ? { details: cached.details } : {}),
	};
	cache.set(record.childId, entry);
	const weak = new WeakRef(card);
	void readCard(from, record, entry.cancel.signal)
		.then((details) => {
			const live = weak.deref();
			if (
				!live ||
				entry.cancel.signal.aborted ||
				(transcriptGenerations.get(live) ?? 0) !== gen ||
				transcripts.get(live)?.get(record.childId) !== entry
			)
				return;
			const changed = !sameDetails(entry.details, details);
			entry.lines = details.lines;
			entry.details = details;
			if (changed) notify(record.childId);
			if (running)
				setTimeout(() => {
					if (!entry.cancel.signal.aborted && weak.deref()) notify(record.childId);
				}, RUNNING_TRANSCRIPT_REFRESH_MS).unref?.();
		})
		.catch(() => undefined);
	return entry.details;
}

export function subagentChildTranscript(card: object, record: SubagentChildIndexEntry): readonly string[] | undefined {
	return subagentChildTranscriptDetails(card, record)?.lines;
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
