import { type CustomEntry, type ExtensionContext, type SessionEntry, sliceHead } from "@bastani/atomic";
import { type ArchivedChildCatalogEntry, readSessionChildCatalog } from "@bastani/atomic/storage";
import { ReleasedChildError } from "./released-child-errors.js";
import { visibleWorktreeRecord } from "./run-worktrees.js";
import type { SubagentChildRecord } from "./subagent-child-records.js";
import { reopenChildSession, type SessionStoreSource } from "./subagent-child-session.js";

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
		(data.owner === undefined || data.owner?.kind === "session") &&
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

/**
 * An open session the index reads child records from. A session that keeps the children whose records left its window
 * out of its entries names them in its catalog and reads their records on demand; a session interface without them
 * holds every record in its entries.
 */
type RecordReader = Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntry" | "getLeafEntry"> &
	Partial<Pick<ExtensionContext["sessionManager"], "getArchivedChildCatalog" | "readArchivedChildRecord">>;

const TRANSCRIPT_LINES = 12;
const TRANSCRIPT_LINE_CHARS = 200;
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
		// Full records read on demand for children whose records left their session's window, by the index entry they
		// were read for: a later observation of the child replaces that entry, and the record goes with it. A record only
		// actions held (`holds`) goes as soon as the last of them lets it go; one a reader keeps (`kept`) stays until then.
		hydrated: new WeakMap<SubagentChildIndexEntry, SubagentChildRecord>(),
		// How many actions on the child hold the record read for an index entry until they are done with it.
		holds: new WeakMap<SubagentChildIndexEntry, number>(),
		// Index entries whose read record stays until the child's next observation, as wakes and record steps keep it.
		kept: new WeakSet<SubagentChildIndexEntry>(),
		// Tasks of such children their cards show, read once per index entry.
		archivedTasks: new WeakMap<SubagentChildIndexEntry, { task?: string }>(),
	};
}
const INDEX = Symbol.for("@bastani/subagents/child-record-index@1");
const processIndex = globalThis as { [INDEX]?: ReturnType<typeof newChildIndex> };
processIndex[INDEX] ??= newChildIndex();
// An index an earlier generation of this extension made may not keep these yet.
processIndex[INDEX].hydrated ??= new WeakMap();
processIndex[INDEX].holds ??= new WeakMap();
processIndex[INDEX].kept ??= new WeakSet();
processIndex[INDEX].archivedTasks ??= new WeakMap();
const {
	entries,
	unsavedRecords,
	pendingWrites,
	readers,
	childIdsByTaskId,
	watchers,
	invalidators,
	collectedCards,
	hydrated,
	holds,
	kept,
	archivedTasks,
} = processIndex[INDEX];

// A saved record can be replaced while its task remains released. Keep an interested wake's identity across
// those writes, without retaining its receipt or keeping a per-name table of abandoned confirmations.
const RELEASE_KEYS = Symbol.for("@bastani/subagents/child-release-keys@1");
const releaseState = globalThis as { [RELEASE_KEYS]?: WeakMap<SubagentChildIndexEntry, WeakRef<object>> };
releaseState[RELEASE_KEYS] ??= new WeakMap();
const releaseKeys = releaseState[RELEASE_KEYS];
export function childReleaseKey(
	childId: string,
	owner: string,
	target: string,
	taskId: string,
	create: boolean,
): object | undefined {
	const entry = entries.get(childId);
	if (
		!entry ||
		entry.ownerSessionId !== owner ||
		entry.intercomTarget !== target ||
		entry.taskId !== taskId ||
		entry.state !== "terminal" ||
		entry.terminalStatus !== SUBAGENT_CHILD_RELEASED_STATUS
	)
		return undefined;
	let key = releaseKeys.get(entry)?.deref();
	if (!key && create) {
		key = {};
		releaseKeys.set(entry, new WeakRef(key));
	}
	return key;
}
function indexEntry(entry: SubagentChildIndexEntry): void {
	if (entry.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS && entry.state === "terminal") {
		const previous = entries.get(entry.childId);
		if (
			previous &&
			previous.ownerSessionId === entry.ownerSessionId &&
			previous.taskId === entry.taskId &&
			previous.intercomTarget === entry.intercomTarget
		) {
			const key = releaseKeys.get(previous);
			if (key) releaseKeys.set(entry, key);
		}
	}
	entries.set(entry.childId, entry);
}

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
let source: SessionStoreSource | undefined;

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

/** The index entry of a child that `sessionId` keeps only in its catalog, as that catalog names it. */
function archivedProjectionOf(child: ArchivedChildCatalogEntry, sessionId: string): SubagentChildIndexEntry {
	const copied = child.ownerSessionId !== sessionId;
	return {
		childId: child.childId,
		runId: child.runId,
		index: child.index,
		agent: child.agent,
		ownerSessionId: child.ownerSessionId,
		state: child.state,
		...(child.elapsedMs === undefined ? {} : { elapsedMs: child.elapsedMs }),
		...(child.elapsedSpan === undefined ? {} : { elapsedSpan: child.elapsedSpan }),
		cwd: child.cwd,
		...(child.taskId === undefined ? {} : { taskId: child.taskId }),
		...(child.terminalStatus === undefined ? {} : { terminalStatus: child.terminalStatus }),
		...(child.childSessionId === undefined ? {} : { childSessionId: child.childSessionId }),
		...(child.childSessionFile === undefined ? {} : { childSessionFile: child.childSessionFile }),
		...(child.intercomTarget === undefined ? {} : { intercomTarget: child.intercomTarget }),
		entryId: child.entryId,
		...(copied ? { recordedIn: sessionId, copied: true as const } : {}),
	};
}

function unreadableRecordError(entry: SubagentChildIndexEntry): ReleasedChildError {
	const sessionId = entry.recordedIn ?? entry.ownerSessionId;
	return new ReleasedChildError("child-record-unreadable", {
		childId: entry.childId,
		...(entry.ownerSessionId === undefined ? {} : { ownerSessionId: entry.ownerSessionId }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(entry.entryId === undefined ? {} : { entryId: entry.entryId }),
	});
}

/**
 * The child's latest saved record when this process holds it: in an open copy of its session's window, or read for an
 * action on the child after it left that window.
 */
function residentRecordOf(entry: SubagentChildIndexEntry): SubagentChildRecord | undefined {
	const read = hydrated.get(entry);
	if (read !== undefined) return read;
	const sessionId = entry.recordedIn ?? entry.ownerSessionId;
	const entryId = entry.entryId;
	if (sessionId === undefined || entryId === undefined) return undefined;
	for (const reader of readersOf(sessionId)) {
		const saved = reader.getEntry(entryId);
		const data = saved !== undefined && isSubagentChildRecord(saved) ? saved.data : undefined;
		if (data?.childId === entry.childId) return data;
	}
	return undefined;
}

function fullRecordOf(entry: SubagentChildIndexEntry): SubagentChildRecord {
	const record = readableRecordOf(entry);
	if (record === undefined) throw unreadableRecordError(entry);
	return record;
}

/**
 * The child's full latest record, or undefined when this process does not hold it: the session holding it is not open
 * here, or the record left that session's window and is read only on demand (see {@link loadSubagentChildRecord}). A
 * newer observation of the child is then indexed as written, which is what a fold of that session's own history gives.
 */
function readableRecordOf(entry: SubagentChildIndexEntry): SubagentChildRecord | undefined {
	return unsavedRecords.get(entry.childId) ?? residentRecordOf(entry);
}

/** Each catalog a session published, by its entries: a session publishes a new catalog when it changes. */
const catalogIndexes = new WeakMap<
	readonly ArchivedChildCatalogEntry[],
	ReadonlyMap<string, ArchivedChildCatalogEntry>
>();

/** What `reader`'s session keeps in its catalog of the record in entry `entryId`, if that record left its window. */
function archivedChildOf(reader: RecordReader, entryId: string): ArchivedChildCatalogEntry | undefined {
	if (typeof reader.getArchivedChildCatalog !== "function" || typeof reader.readArchivedChildRecord !== "function")
		return undefined;
	const catalog = reader.getArchivedChildCatalog();
	let byEntry = catalogIndexes.get(catalog);
	if (byEntry === undefined) {
		byEntry = new Map(catalog.map((child) => [child.entryId, child]));
		catalogIndexes.set(catalog, byEntry);
	}
	return byEntry.get(entryId);
}

/**
 * The open copies of the session holding `entry`'s record whose catalog names that record, which left their window,
 * with what the catalog keeps of it.
 */
function archiveReadersOf(
	entry: SubagentChildIndexEntry,
): { readonly reader: RecordReader; readonly child: ArchivedChildCatalogEntry }[] {
	const sessionId = entry.recordedIn ?? entry.ownerSessionId;
	const entryId = entry.entryId;
	if (sessionId === undefined || entryId === undefined) return [];
	return readersOf(sessionId).flatMap((reader) => {
		const child = archivedChildOf(reader, entryId);
		return child?.childId === entry.childId ? [{ reader, child }] : [];
	});
}

/**
 * How a record read for a child whose records left its session's window stays in memory: until the child's next
 * observation replaces its index entry, which then merges over it, or held by an action until that action lets it go.
 */
type KeepRead = "until-observed" | "held";

/** Keep the record read for `entry` as `keep` says; false when `entry`'s record was not read so. */
function keepRead(entry: SubagentChildIndexEntry, keep: KeepRead | undefined): boolean {
	if (keep === undefined || unsavedRecords.has(entry.childId) || !hydrated.has(entry)) return false;
	if (keep === "until-observed") kept.add(entry);
	else holds.set(entry, (holds.get(entry) ?? 0) + 1);
	return true;
}

/** An action is done with the record it held for `entry`: the record goes once no action holds it and none keeps it. */
function releaseRead(entry: SubagentChildIndexEntry): void {
	const count = (holds.get(entry) ?? 0) - 1;
	if (count > 0) {
		holds.set(entry, count);
		return;
	}
	holds.delete(entry);
	if (!kept.has(entry)) hydrated.delete(entry);
}

/**
 * The child's full latest record, read from its session when it left that session's window, and the index entry it is
 * the record of. With `keep` it stays in memory as {@link KeepRead} says; `kept` tells whether it was kept so. A
 * resumed child's records name only what changed, so they merge over it. Throws a {@link ReleasedChildError}
 * `child-record-unreadable` when no open session holds it.
 */
async function loadRecordOf(
	entry: SubagentChildIndexEntry,
	keep: KeepRead | undefined,
): Promise<{ readonly record: SubagentChildRecord; readonly entry: SubagentChildIndexEntry; readonly kept: boolean }> {
	for (;;) {
		const ready = readableRecordOf(entry);
		if (ready !== undefined) return { record: ready, entry, kept: keepRead(entry, keep) };
		const merge = mergingEntries.get(entry);
		const read = merge === undefined ? await readArchivedRecordOf(entry) : await merge.then(() => undefined);
		// A newer observation of the child arrived meanwhile: it is the latest record.
		const latest = entries.get(entry.childId);
		if (latest !== undefined && latest !== entry) {
			entry = latest;
			continue;
		}
		if (read === undefined) throw unreadableRecordError(entry);
		if (keep !== undefined && latest === entry) hydrated.set(entry, read);
		return { record: read, entry, kept: keepRead(entry, keep) };
	}
}

/** The record `entry` names, read from an open copy of its session after it left that session's window. */
async function readArchivedRecordOf(entry: SubagentChildIndexEntry): Promise<SubagentChildRecord | undefined> {
	for (const { reader } of archiveReadersOf(entry)) {
		const saved = await reader.readArchivedChildRecord?.(entry.entryId as string);
		const data = saved !== undefined && isSubagentChildRecord(saved) ? saved.data : undefined;
		if (data?.childId === entry.childId) return data;
	}
	return undefined;
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
	indexEntry(projectionOf(merged, copied, complete ? saved : undefined));
	notify(record.childId);
	indexTaskId(merged);
	return merged;
}

/** A card finds a child by any task id it ran as; a released child's task is no longer one. */
function indexTaskId(record: SubagentChildRecord): void {
	if (record.taskId === undefined) return;
	indexChildTask(
		record.childId,
		record.taskId,
		record.state === "terminal" && record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS,
	);
}

function indexChildTask(childId: string, taskId: string, released: boolean): void {
	if (released) {
		if (childIdsByTaskId.get(taskId) === childId) childIdsByTaskId.delete(taskId);
	} else if (!childIdsByTaskId.has(taskId)) childIdsByTaskId.set(taskId, childId);
	notify(taskId);
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
	indexEntry(projectionOf(record, false, saved));
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
 * is indexed on the way, so its card finds it by any of them. `archived` are the children whose earlier records left
 * the session's window: the records the window still holds of one of them are merged over its catalog's.
 */
function observeEntries(
	sessionEntries: readonly SessionEntry[],
	sessionId: string,
	archived: ReadonlyMap<string, SubagentChildIndexEntry> = new Map(),
): void {
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
		const earlier = archived.get(record.childId);
		if (earlier !== undefined && entries.get(record.childId) === earlier)
			mergeOverArchived(earlier, record, latest, { entryId, sessionId }, copied);
		else if (hasEveryKeyOf(latest, record)) observeSubagentChildRecord(latest, copied, { entryId, sessionId });
		else observeSubagentChildRecord(record, copied);
	}
}

/**
 * Index what `sessionId` keeps of children whose records left its window, before the records the window still holds,
 * which are newer. Returns the entries indexed from it, by child id.
 */
function observeArchivedChildren(
	children: readonly ArchivedChildCatalogEntry[],
	sessionId: string,
): Map<string, SubagentChildIndexEntry> {
	const indexed = new Map<string, SubagentChildIndexEntry>();
	for (const child of children) {
		const copied = child.ownerSessionId !== sessionId;
		const existing = entries.get(child.childId);
		if (!acceptsObservation(existing, copied)) continue;
		const released = new Set(child.releasedTaskIds ?? []);
		for (const taskId of child.taskIds) indexChildTask(child.childId, taskId, released.has(taskId));
		// This process observed a newer record of it, which is not saved yet or waits to be appended: that one stands.
		if (unsavedRecords.has(child.childId)) continue;
		const projection = archivedProjectionOf(child, sessionId);
		// Indexed from this entry already, as before its window was cleared: what was read of it stays.
		if (
			existing !== undefined &&
			existing.entryId === projection.entryId &&
			existing.recordedIn === projection.recordedIn &&
			existing.copied === projection.copied
		) {
			indexed.set(child.childId, existing);
			continue;
		}
		entries.set(child.childId, projection);
		indexed.set(child.childId, projection);
		notify(child.childId);
	}
	return indexed;
}

/** Merges of window records over records that left the window, by owner, while they read the earlier records. */
const merging = new Map<string, Promise<void>>();
/** The merge an index entry waits for before its full record can be read. */
const mergingEntries = new WeakMap<SubagentChildIndexEntry, Promise<void>>();

/**
 * The window holds newer records of a child whose earlier ones left it, and they do not name everything its record has
 * (as an Atomic before #4395 wrote them): its record is theirs merged over the earlier one, read before anything reads
 * the child's record. Until then the index says where the child stands as those newer records do.
 */
function mergeOverArchived(
	earlier: SubagentChildIndexEntry,
	fold: SubagentChildRecord,
	latest: SubagentChildRecord,
	saved: SubagentChildRecordLocation,
	copied: boolean,
): void {
	const { entryId: _location, recordedIn: _recordedIn, copied: _copied, ...known } = projectionOf(fold, copied, saved);
	const standing: SubagentChildIndexEntry = { ...earlier, ...known };
	entries.set(fold.childId, standing);
	notify(fold.childId);
	const owner = fold.owner?.sessionId ?? saved.sessionId;
	const merged = readArchivedRecordOf(earlier)
		.catch(() => undefined)
		.then((record) => {
			if (entries.get(fold.childId) !== standing) return;
			// The earlier record cannot be read: the child's record is what the window holds, as a fold of it gives.
			if (record === undefined) {
				observeSubagentChildRecord(fold, copied);
				return;
			}
			const full = { ...record, ...fold };
			if (hasEveryKeyOf(latest, full)) observeSubagentChildRecord(latest, copied, saved);
			else observeSubagentChildRecord(full, copied);
		});
	mergingEntries.set(standing, merged);
	const all = Promise.all([merging.get(owner), merged]).then(() => undefined);
	merging.set(owner, all);
	void all.then(() => {
		if (merging.get(owner) === all) merging.delete(owner);
	});
}

/**
 * Settles once the records of `ownerSessionId`'s children that left its window are merged with the newer ones the
 * window holds; undefined when none are being merged.
 */
export function subagentChildRecordsMerging(ownerSessionId: string): Promise<void> | undefined {
	return merging.get(ownerSessionId);
}

/** Index a session: its catalog of children whose records left its window, then the records the window holds. */
function observeSession(sessionManager: RecordReader & { getEntries(): SessionEntry[] }): void {
	const sessionId = sessionManager.getSessionId();
	const catalog =
		typeof sessionManager.getArchivedChildCatalog === "function" ? sessionManager.getArchivedChildCatalog() : [];
	const earlier = observeArchivedChildren(catalog, sessionId);
	for (const child of catalog)
		if (child.coveredBy && sessionManager.getEntry(child.coveredBy)) earlier.delete(child.childId);
	observeEntries(sessionManager.getEntries(), sessionId, earlier);
}

/** Read the child records of the session a card is shown in, and keep its store for records and transcripts. */
export function bindSubagentChildCards(ctx: Pick<ExtensionContext, "sessionManager">): void {
	const store = ctx.sessionManager.getSessionStore();
	source = { sessionManager: { getSessionStore: () => store } };
	registerSubagentChildRecordReader(ctx.sessionManager, true);
	loadedOwners.add(ctx.sessionManager.getSessionId());
	observeSession(ctx.sessionManager);
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
	observeSession(ctx.sessionManager);
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
 * restore that reads the owner's own session instead, or a wake that only looks for results.
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
	const found = entryForTarget(ownerSessionId, intercomTarget);
	return found === undefined ? undefined : fullRecordOf(found);
}

function entryForTarget(ownerSessionId: string, intercomTarget: string): SubagentChildIndexEntry | undefined {
	if (typeof intercomTarget !== "string") return undefined;
	let found: SubagentChildIndexEntry | undefined;
	for (const entry of entries.values())
		if (entry.intercomTarget === intercomTarget && entry.ownerSessionId === ownerSessionId) found = entry;
	return found;
}

/**
 * The id of the child of `ownerSessionId` that was launched with this Intercom name, read from the index alone: a
 * child whose record left its session's window is found without reading it. Throws as
 * {@link subagentChildRecordForTarget} does when the session holding that child's record is not open in this process.
 */
export function subagentChildIdForTarget(ownerSessionId: string, intercomTarget: string): string | undefined {
	const found = entryForTarget(ownerSessionId, intercomTarget);
	if (found === undefined || readableRecordOf(found) !== undefined || isArchivedEntry(found)) return found?.childId;
	throw unreadableRecordError(found);
}

/**
 * The latest record of one of `ownerSessionId`'s children, as {@link subagentChildRecordOf} gives it, read from its
 * session when it left that session's window. With `keep`, a record read so stays in memory until the child's next
 * observation, which merges over it: for work that records the child again, as a wake does.
 */
export async function loadSubagentChildRecord(
	ownerSessionId: string,
	childId: string,
	options: { readonly keep?: boolean } = {},
): Promise<SubagentChildRecord | undefined> {
	const entry = ownEntry(ownerSessionId, childId);
	if (entry === undefined) return undefined;
	return (await loadRecordOf(entry, options.keep === true ? "until-observed" : undefined)).record;
}

/**
 * Keep this child's latest record in memory until its next observation, as {@link loadSubagentChildRecord} keeps it,
 * also when an action read it first and holds it: that action letting it go does not take it from the caller. Returns
 * the read to wait for when the record left its session's window and is not in memory; undefined when nothing needs
 * reading, so the caller goes on at once.
 */
export function keepSubagentChildRecord(ownerSessionId: string, childId: string): Promise<unknown> | undefined {
	const entry = ownEntry(ownerSessionId, childId);
	if (entry === undefined || keepRead(entry, "until-observed") || !isArchivedEntry(entry)) return undefined;
	return loadRecordOf(entry, "until-observed");
}

/** A child's latest record an action on it holds, and how the action lets it go. */
export interface SubagentChildRecordHold {
	readonly record: SubagentChildRecord;
	/** The action is done with the child: a record read from its session is no longer kept for it. Called once. */
	release(): void;
}

/**
 * The latest record of one of `ownerSessionId`'s children for an explicit action on it, read as
 * {@link loadSubagentChildRecord} reads it. A record read from its session stays in memory while the action holds it:
 * the action lets it go once it is done with the child, or the child's next observation, when the action records the
 * child again, merges over it and replaces it. Undefined for a child this owner did not launch.
 */
export async function holdSubagentChildRecord(
	ownerSessionId: string,
	childId: string,
): Promise<SubagentChildRecordHold | undefined> {
	const entry = ownEntry(ownerSessionId, childId);
	if (entry === undefined) return undefined;
	const read = await loadRecordOf(entry, "held");
	let held = read.kept;
	return {
		record: read.record,
		release: () => {
			if (!held) return;
			held = false;
			releaseRead(read.entry);
		},
	};
}

/**
 * Whether the latest record of this child of `ownerSessionId` is read only on demand, by
 * {@link loadSubagentChildRecord}: it left its session's window.
 */
export function subagentChildRecordNeedsRead(ownerSessionId: string, childId: string): boolean {
	const entry = ownEntry(ownerSessionId, childId);
	return (
		entry !== undefined &&
		readableRecordOf(entry) === undefined &&
		(mergingEntries.has(entry) || archiveReadersOf(entry).length > 0)
	);
}

/** Whether `entry`'s record left its session's window, which an open copy of that session reads on demand. */
function isArchivedEntry(entry: SubagentChildIndexEntry): boolean {
	return readableRecordOf(entry) === undefined && (mergingEntries.has(entry) || archiveReadersOf(entry).length > 0);
}

/** Where a child stands, as its index entry keeps it: no task, held messages or held results. */
export type SubagentChildStanding = Pick<
	SubagentChildRecord,
	| "childId"
	| "runId"
	| "index"
	| "agent"
	| "cwd"
	| "state"
	| "terminalStatus"
	| "taskId"
	| "childSessionId"
	| "childSessionFile"
	| "intercomTarget"
	| "intercomGroup"
	| "releasedIntercomId"
	| "elapsedMs"
	| "elapsedSpan"
>;

function standingOf(entry: SubagentChildIndexEntry): SubagentChildStanding {
	const { ownerSessionId: _owner, entryId: _entryId, recordedIn: _recordedIn, copied: _copied, ...standing } = entry;
	return standing;
}

/**
 * Every child of `ownerSessionId` in the index, as {@link subagentChildRecordsOf} lists them, and with them the ones
 * whose records left their session's window, as they stand: settled children that hold nothing for later, which a
 * reconnect still reports ended. A child whose record is in a session not open in this process is left out.
 */
export function subagentChildStandingsOf(ownerSessionId: string): (SubagentChildRecord | SubagentChildStanding)[] {
	const found: (SubagentChildRecord | SubagentChildStanding)[] = [];
	for (const entry of entries.values()) {
		if (entry.ownerSessionId !== ownerSessionId) continue;
		const record = readableRecordOf(entry);
		const archived = record === undefined ? archiveReadersOf(entry)[0]?.child : undefined;
		if (record !== undefined) found.push(record);
		else if (archived !== undefined)
			found.push({
				...standingOf(entry),
				...(archived.intercomGroup === undefined ? {} : { intercomGroup: archived.intercomGroup }),
				...(archived.releasedIntercomId === undefined ? {} : { releasedIntercomId: archived.releasedIntercomId }),
			});
	}
	return found;
}

/** The Intercom name of the child of `ownerSessionId` that runs or ran as task `taskId`, read from the index alone. */
export function subagentChildIntercomTargetOfTask(ownerSessionId: string, taskId: string): string | undefined {
	for (const entry of entries.values()) {
		if (entry.ownerSessionId !== ownerSessionId || entry.taskId !== taskId) continue;
		if (readableRecordOf(entry) !== undefined || archiveReadersOf(entry).length > 0) return entry.intercomTarget;
	}
	return undefined;
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

/**
 * Look up where children stand for one reservation batch: index names once, on demand, but never cache a child's state.
 * A child whose record left its session's window is found as it stands: settled, holding nothing.
 */
export function reservationRecordLookup(
	ownerSessionId: string,
): (name: string) => SubagentChildRecord | SubagentChildStanding | undefined {
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
		const entry = id === undefined ? undefined : ownEntry(ownerSessionId, id);
		if (entry === undefined) return undefined;
		const record = readableRecordOf(entry) ?? (archiveReadersOf(entry).length > 0 ? standingOf(entry) : undefined);
		return record?.intercomTarget === name ? record : undefined;
	};
}

/** How many children the index holds; counted by tests and the benchmark. */
export function subagentChildIndexSize(): number {
	return entries.size;
}

/**
 * What the index keeps of a child, by its child id, even when its full record cannot be read.
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
	if (id !== undefined) {
		const entry = entries.get(id);
		return entry && visibleWorktreeRecord(entry);
	}
	for (const entry of entries.values()) if (entry.taskId === taskId) return visibleWorktreeRecord(entry);
	return undefined;
}

/** Run ids of the children this process has seen records of whose owner is `ownerSessionId`. */
export function observedSubagentRunIds(ownerSessionId: string): Set<string> {
	const runIds = new Set<string>();
	for (const entry of entries.values()) if (entry.ownerSessionId === ownerSessionId) runIds.add(entry.runId);
	return runIds;
}

/**
 * Redraw a card when its child's records change. A card shown outside its owner's session reads that session's
 * records from the store once.
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
	// Where the owner's children stand, never the owner's history: a card reads a child's details only when expanded.
	void (async () => {
		observeArchivedChildren(
			await readSessionChildCatalog(from.sessionManager.getSessionStore(), ownerSessionId),
			ownerSessionId,
		);
	})().catch(() => undefined);
}

type TranscriptPart = {
	readonly type: string;
	readonly text?: string;
	readonly data?: string;
	readonly mimeType?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
};
type TranscriptMessage = {
	readonly role: string;
	readonly content?: string | readonly TranscriptPart[];
	readonly details?: unknown;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly durationMs?: number;
};

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

function messageText(content: string | readonly TranscriptPart[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is TranscriptPart & { text: string } => part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

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
				lines.push(text.length > TRANSCRIPT_LINE_CHARS ? `${sliceHead(text, TRANSCRIPT_LINE_CHARS - 1)}…` : text);
		}
	}
	return lines.slice(-TRANSCRIPT_LINES);
}

function extractTranscriptDetails(messages: readonly TranscriptMessage[]): SubagentChildTranscriptDetails {
	let prompt: string | undefined;
	let result: string | undefined;
	const resultsById = new Map<
		string,
		{
			readonly content: readonly TranscriptPart[];
			readonly details?: unknown;
			readonly text: string;
			readonly isError: boolean;
			readonly durationMs?: number;
		}
	>();
	for (const message of messages) {
		if (message.role === "user" && prompt === undefined) {
			const raw = messageText(message.content);
			if (raw.trim()) prompt = unwrapPrompt(raw);
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const content = Array.isArray(message.content) ? message.content : [];
			resultsById.set(message.toolCallId, {
				content,
				...(message.details !== undefined ? { details: message.details } : {}),
				text: messageText(message.content),
				isError: message.isError === true,
				...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
			});
		} else if (message.role === "assistant") {
			const text = messageText(message.content).trim();
			if (text) result = text;
		}
	}
	const toolCalls: SubagentChildToolCallEntry[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || !part.name) continue;
			const id = typeof part.id === "string" ? part.id : "";
			const args =
				typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
					? (part.arguments as Record<string, unknown>)
					: {};
			const matched = id ? resultsById.get(id) : undefined;
			toolCalls.push({
				id,
				name: part.name,
				args,
				...(matched
					? {
							resultContent: matched.content,
							...(matched.details !== undefined ? { resultDetails: matched.details } : {}),
							resultText: matched.text,
							isError: matched.isError,
							...(matched.durationMs !== undefined ? { durationMs: matched.durationMs } : {}),
							completed: true,
						}
					: { completed: false }),
			});
		}
	}
	return {
		...(prompt !== undefined ? { prompt } : {}),
		toolCalls,
		...(result !== undefined ? { result } : {}),
		lines: transcriptLines(messages),
	};
}

async function resolveSavedRecord(
	from: SessionStoreSource,
	entry: SubagentChildIndexEntry,
): Promise<SubagentChildRecord | undefined> {
	const memory = readableRecordOf(entry);
	if (memory !== undefined) return memory;
	const sessionId = entry.recordedIn ?? entry.ownerSessionId;
	if (!sessionId || !entry.entryId) return undefined;
	try {
		const snapshot = await from.sessionManager.getSessionStore().load(sessionId);
		const found = snapshot.entries.find((item) => item.id === entry.entryId);
		return found && isSubagentChildRecord(found) ? found.data : undefined;
	} catch {
		return undefined;
	}
}

async function postLaunchMessages(
	from: SessionStoreSource,
	entry: SubagentChildIndexEntry,
	sessionManager: NonNullable<
		Extract<Awaited<ReturnType<typeof reopenChildSession>>, { sessionManager: unknown }>["sessionManager"]
	>,
): Promise<readonly TranscriptMessage[]> {
	const full = await resolveSavedRecord(from, entry);
	const launchLeafId = full?.launchLeafId;
	const launchLeafSeq = full?.launchLeafSeq;
	let branch = sessionManager.getBranch();
	if (typeof launchLeafId === "string") {
		let idx = branch.findIndex((item) => item.id === launchLeafId);
		if (idx === -1 && typeof sessionManager.loadFullHistory === "function") {
			await sessionManager.loadFullHistory();
			branch = sessionManager.getBranch();
			idx = branch.findIndex((item) => item.id === launchLeafId);
		}
		if (idx !== -1) {
			return branch
				.slice(idx + 1)
				.flatMap((item) => (item.type === "message" ? [item.message as unknown as TranscriptMessage] : []));
		}
		if (launchLeafSeq !== undefined && typeof sessionManager.getEntrySeq === "function") {
			const seqs = branch.map((item) => sessionManager.getEntrySeq(item.id));
			if (seqs.some((seq) => seq !== undefined && seq <= launchLeafSeq)) {
				return branch
					.filter((_, index) => (seqs[index] ?? 0) > launchLeafSeq)
					.flatMap((item) => (item.type === "message" ? [item.message as unknown as TranscriptMessage] : []));
			}
		}
		return [];
	}
	if (launchLeafSeq !== undefined && typeof sessionManager.getEntrySeq === "function") {
		return branch
			.filter((item) => (sessionManager.getEntrySeq(item.id) ?? 0) > launchLeafSeq)
			.flatMap((item) => (item.type === "message" ? [item.message as unknown as TranscriptMessage] : []));
	}
	const messages = (sessionManager.buildSessionContext().messages ?? []) as readonly TranscriptMessage[];
	if (full?.forked === true) {
		const forkIdx = messages.findIndex(
			(msg) => msg.role === "user" && messageText(msg.content).includes("\n\nTask:\n"),
		);
		return forkIdx >= 0 ? messages.slice(forkIdx) : [];
	}
	return messages;
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
	const readable = readableRecordOf(record);
	if (readable !== undefined || archiveReadersOf(record).length === 0) return readable?.task;
	// Its record left its session's window: read once, and the card is drawn again with its task.
	const known = archivedTasks.get(record);
	if (known !== undefined) return known.task;
	const read: { task?: string } = {};
	archivedTasks.set(record, read);
	void readArchivedRecordOf(record).then(
		(full) => {
			if (full?.task === undefined) return;
			read.task = full.task;
			notify(record.childId);
		},
		() => undefined,
	);
	return undefined;
}

export function clearSubagentChildTranscriptCache(card: object): void {
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
	const entry: TranscriptCache = {
		key,
		...(cached?.lines ? { lines: cached.lines } : {}),
		...(cached?.details ? { details: cached.details } : {}),
	};
	cache.set(record.childId, entry);
	void (async () => {
		const reopened = await reopenChildSession(from, record);
		if ("reason" in reopened) {
			if ((transcriptGenerations.get(card) ?? 0) !== gen || transcripts.get(card)?.get(record.childId) !== entry) {
				return;
			}
			const details: SubagentChildTranscriptDetails = {
				toolCalls: [],
				lines: [],
				unavailable: `Transcript unavailable · ${reopened.reason}`,
			};
			const changed = !sameDetails(entry.details, details);
			entry.lines = details.lines;
			entry.details = details;
			if (changed) notify(record.childId);
			return;
		}
		const messages = await postLaunchMessages(from, record, reopened.sessionManager);
		if ((transcriptGenerations.get(card) ?? 0) !== gen || transcripts.get(card)?.get(record.childId) !== entry) {
			return;
		}
		const details = extractTranscriptDetails(messages);
		const changed = !sameDetails(entry.details, details);
		entry.lines = details.lines;
		entry.details = details;
		if (changed) notify(record.childId);
		if (running) {
			setTimeout(() => {
				if ((transcriptGenerations.get(card) ?? 0) === gen) notify(record.childId);
			}, RUNNING_TRANSCRIPT_REFRESH_MS).unref?.();
		}
	})().catch(() => undefined);
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
