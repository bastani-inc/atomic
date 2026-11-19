import { dirname, join } from "node:path";
import { isProxy } from "node:util/types";
import { getCurrentSystemMessage } from "@bastani/atomic-ai";
import type { ImageContent, Message, TextContent, Usage } from "@bastani/atomic-ai/compat";
import { getAgentDir } from "../config.js";
import { yieldToEventLoop } from "../utils/event-loop.js";

import { createSessionCwdMatcherAsync, normalizePath, pathsEqual, resolvePath } from "../utils/paths.ts";
import type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
import { forkContextPath, includeNamedForkOutputs } from "./fork-context-path.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { SessionHistoryIndex } from "./session-history-index.ts";
import { appendFailureWroteNothing } from "./session-manager-append-errors.ts";
import { createBranchedSessionState } from "./session-manager-archive.ts";
import { classifiedWorkflowMetadata, validSessionWorkflowMetadata } from "./session-manager-classification.ts";
import {
	createBranchSummaryEntry,
	createCompactionEntry,
	createContextEditEntry,
	createCustomEntry,
	createCustomMessageEntry,
	createLabelEntry,
	createMessageEntry,
	createModelChangeEntry,
	createSessionFilePath,
	createSessionHeader,
	createSessionInfoEntry,
	createSessionSummaryEntry,
	createThinkingLevelChangeEntry,
	createWorktreeSnapshotEntry,
	getEntriesWithoutHeader,
} from "./session-manager-entries.ts";
import { SessionDeletedError, SessionEntryError } from "./session-manager-errors.js";
import {
	buildContextEntries,
	buildSessionIndex,
	buildSessionProjection,
	buildSessionTree,
	getBranchPath,
	getLatestCompactionBoundaryEntry,
	isLeafMoveEntry,
	LEAF_MOVE_ENTRY_TYPE,
} from "./session-manager-history.ts";
import { listProjectSessions } from "./session-manager-list.ts";
import { getDefaultSessionDirPath } from "./session-manager-paths.ts";
import type {
	BranchSummaryEntry,
	ContextEditEntry,
	FileEntry,
	ModelFallbackRecord,
	NewSessionOptions,
	SessionContext,
	SessionEntry,
	SessionHeader,
	SessionInfo,
	SessionListProgress,
	SessionNameState,
	SessionOpenOptions,
	SessionProjection,
	SessionTreeNode,
	SessionWorkflowMetadata,
	UsageEntry,
	WorktreeRestoreHostWarning,
} from "./session-manager-types.ts";
import {
	assertValidSessionId,
	createSessionId,
	generateId,
	validateSessionFileEntries,
} from "./session-manager-validation.ts";
import { assertSessionNotOpenElsewhere, holdSessionOpenMarker } from "./session-open-markers.js";
import { listSessionStore } from "./session-store-list.js";
import {
	assertSessionBlobStore,
	copySessionBlobs,
	sessionBlobHashes,
	storeSessionBlobs,
	TOOL_OUTPUT_ENTRY_TYPE,
	type ToolOutputReference,
	takeInlineToolOutput,
} from "./session-tool-output.ts";
import { adoptInlineSnapshotBlobs, deleteSessionWithSnapshotRefs } from "./session-worktree-snapshots.ts";
import {
	isStorageTransientError,
	SessionBlobError,
	type StorageFailureCause,
	StorageRollbackError,
} from "./storage/errors.js";
import { validateSessionEntryStructure } from "./storage/session/entry-structure.js";
import {
	SessionConflictError,
	SessionFormatVersionError,
	SessionIdMismatchError,
	type SessionJsonValue,
	SessionNotFoundError,
	StorageUnavailableError,
} from "./storage/session/errors.js";
import { createForkArchive } from "./storage/session/fork-archive.js";
import { firstHistoryCursor, historyChunks, historyPages } from "./storage/session/history-pages.js";
import { bindSessionFile, JsonlSessionStore, withForkFileWindow } from "./storage/session/jsonl-session-store.js";
import { SessionKeyDigests } from "./storage/session/key-digests.js";
import { MemorySessionStore, markPrivateMemorySessionStore } from "./storage/session/memory-session-store.js";
import {
	addEntryToHistoryTotals,
	EMPTY_SESSION_HISTORY_TOTALS,
	readSessionRange,
	sessionResumeOf,
	updateWorkflowStarts,
} from "./storage/session/session-resume.js";
import type {
	OversizedSessionEntry,
	SessionBlob,
	SessionHistoryPage,
	SessionHistoryReadOptions,
	SessionHistoryTotals,
	SessionRecordHeader,
	SessionRecoveryState,
	SessionResume,
	SessionSnapshot,
	SessionStore,
	SessionStoredEntry,
} from "./storage/session/types.js";
import { SESSION_HISTORY_PAGE_ENTRIES } from "./storage/session/types.js";
import {
	type AssistantAnswer,
	archivedAnswerAt,
	lastBranchAnswer,
	savedWindowAnswer,
} from "./storage/session/window-answer.js";
import { writeChunksAtomically } from "./storage/transfer-files.js";
import { WorkspaceConfigError } from "./worktree-snapshot/errors.ts";
import type {
	PathContinuation,
	WorktreeRootMapping,
	WorktreeSnapshot,
	WorktreeUnrestored,
} from "./worktree-snapshot/types.ts";

/** How many times one append reads the store's new tail and tries again before its failure stands (#4970). */
const MAX_APPEND_RECONCILES = 3;

async function resolveSessionStore(cwd: string): Promise<SessionStore> {
	// Selection loads settings and tools, which depend on the completed session module.
	return (await import("./session-storage.js")).resolveSessionStore(cwd);
}

type SelectedWindow = SessionResume & { readonly priorAnswer?: AssistantAnswer; readonly archiveOnlyEpoch?: true };
type OpenedSession = { readonly resume: SelectedWindow };
async function withPriorAnswer(store: SessionStore, resume: SelectedWindow): Promise<SelectedWindow> {
	return Object.hasOwn(resume, "priorAnswer")
		? resume
		: { ...resume, priorAnswer: await savedWindowAnswer(store, resume) };
}
async function readStoredSession(
	store: SessionStore,
	sessionId: string,
	options: SessionOpenOptions | undefined,
): Promise<OpenedSession> {
	if (options?.history !== undefined && options.history !== "tail") {
		throw new TypeError(
			'Session history: "full" has been removed. Use sessionManager.readHistory() to iterate older entries.',
		);
	}
	if (!store.readResume || !store.readRange)
		return {
			resume: await (await import("./storage/session/snapshot-history.js")).snapshotWindow(
				store,
				sessionId,
				options?.leafId,
			),
		};
	return { resume: await withPriorAnswer(store, await store.readResume(sessionId, options?.leafId)) };
}

async function openSessionFileWindow(path: string, cwd: string | undefined, options?: SessionOpenOptions) {
	const store = await JsonlSessionStore.open(dirname(path), { exactDirectory: true, scanExisting: false });
	let id: string;
	try {
		id = (await store.readHeaderFile(path)).id;
	} catch (error) {
		if (!(error instanceof StorageUnavailableError) || (error.cause as NodeJS.ErrnoException).code !== "ENOENT")
			throw error;
		const { type: _type, ...header } = createSessionHeader(createSessionId(), resolvePath(cwd ?? process.cwd()));
		await store.create(header, [], path);
		id = header.id;
	}
	store[bindSessionFile](id, path);
	return { store, opened: await readStoredSession(store, id, options) };
}

function openedHeader(opened: OpenedSession): SessionRecordHeader {
	return opened.resume.header;
}

/** A custom entry written with a message, in the same store write (see `SessionManager.appendWithMessage`). */
export interface MessageCompanionEntry {
	readonly customType: string;
	readonly data?: SessionJsonValue;
}

/** Private host/builtin bridge, not re-exported by session-manager or the SDK. */
export let appendOwnedSubagentChildRecord: (
	manager: SessionManager,
	ownerId: string,
	data: { readonly childId?: string; readonly owner?: { readonly sessionId?: string } },
	live: () => boolean,
) => Promise<void>;

// A child factory and its host can load independent SDK copies. Their constructors are not
// interchangeable, but both can identify the physical header without calling virtual host methods.
const forkGeneration = Symbol.for("atomic.session-manager/fork-generation@1");

/** @internal Read only the native manager's local generation. Unknown/virtual hosts have no receipt. */
export function physicalForkHeader(manager: SessionManager): SessionHeader | undefined {
	if (isProxy(manager)) return undefined;
	const prototype: object | null = Object.getPrototypeOf(manager);
	const read = prototype && !isProxy(prototype) && Object.getOwnPropertyDescriptor(prototype, forkGeneration)?.value;
	return typeof read === "function" ? read.call(manager) : undefined;
}

/** An in-memory session tree whose mutations await the backing store. */
export class SessionManager {
	private sessionId = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private store: SessionStore;
	private lastSeq = 0;
	/** Ids of entries an append of unknown outcome may have saved, that no read of the store has settled (#4970). */
	private readonly unconfirmed = new Set<string>();
	/** The open session was deleted from the store; later entries stay in memory only (#4971). */
	private deletedFromStore = false;
	/** Another writer's entries stopped an append while `appendHaltPolicy` held: appends reject with it (#5135). */
	private appendHalt: SessionConflictError | undefined;
	private appendHaltPolicy: (() => boolean) | undefined;
	/** How many live sessions run on this manager; while any do, its session is marked open (#4971). */
	private openHolds = 0;
	private openMarker:
		| { readonly sessionId: string; readonly store: SessionStore; readonly release: () => Promise<void> }
		| undefined;
	private mutation: Promise<void> = Promise.resolve();
	/** Custom entries written with a message, in its own store write, by the message they go with. */
	private readonly messageCompanions = new WeakMap<object, () => MessageCompanionEntry | undefined>();
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private contextEdits = 0;
	/** Whether a retained row at this leaf differs between the transcript and model projections. */
	private projectedEdits: { leafId: string | null; visible: boolean } | undefined;
	private leafId: string | null = null;
	private historyIndex = new SessionHistoryIndex();

	private historyStartSeq = 1;
	private answerWindowStart = 1;
	private priorAnswer?: AssistantAnswer;
	private archiveOnlyEpoch = false;

	private entrySeqs = new Map<string, number>();
	private historyEpoch: string | undefined;
	private lastEntryId: string | null = null;
	private recoveryState: SessionRecoveryState = { admissionDigests: "", intercomDeliveredIds: [] };
	private admissionKeys = new SessionKeyDigests();
	private workflowStarts: Record<string, number> = {};

	private omittedTotals: SessionHistoryTotals | undefined;

	private branchLinks: ReadonlyMap<string, string> | undefined;
	private historyLoad: Promise<void> | undefined;

	private constructor(store: SessionStore, cwd: string, sessionDir: string, options?: NewSessionOptions) {
		this.store = store;
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.start(options);
	}

	/**
	 * #5135: while `policy` holds, the first append that another writer's entries stop halts every queued and later
	 * append, which then rejects with that conflict, until {@link resumeAppends}. A run that such a conflict stopped
	 * then writes nothing more after the other writer's entries, inside that writer's turn.
	 */
	haltAppendsOnConflictWhile(policy: () => boolean): void {
		this.appendHalt = undefined;
		this.appendHaltPolicy = policy;
	}

	/** The conflict that halted appends, if one did (#5135). */
	getAppendHalt(): SessionConflictError | undefined {
		return this.appendHalt;
	}

	/** Lets appends go on after the other writer's entries again (#5135). */
	resumeAppends(): void {
		this.appendHalt = undefined;
	}

	private runMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutation.then(operation);
		this.mutation = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private recordHeader(header = this.getHeader()!): SessionRecordHeader {
		const { type: _type, ...record } = header;
		return record;
	}

	private restore(snapshot: SessionSnapshot, location?: string): void {
		this.restoreHistory(snapshot.header, snapshot.entries, snapshot.lastSeq, location);
		this.historyEpoch = snapshot.epoch;
	}

	private restoreOpened(opened: OpenedSession, location?: string): void {
		const resume = opened.resume;
		const held = [...resume.state, ...resume.branch].sort((a, b) => a.seq - b.seq);
		this.restoreHistory(
			resume.header,
			held.map(({ entry }) => entry),
			resume.lastSeq,
			location,
		);
		this.entrySeqs = new Map(held.map(({ seq, entry }) => [entry.id, seq]));
		this.historyEpoch = resume.epoch;
		this.archiveOnlyEpoch = resume.archiveOnlyEpoch === true;
		this.answerWindowStart = resume.branch[0]?.seq ?? 1;
		this.priorAnswer = resume.priorAnswer;
		this.lastEntryId = resume.lastEntryId;
		const { workflowStarts, ...recovery } = resume.recovery;
		this.recoveryState = { ...recovery, admissionDigests: "" };
		this.workflowStarts = { ...workflowStarts };
		// An older custom store includes open workflow records in its state rows instead of their positions.
		if (workflowStarts === undefined) {
			for (const { entry, seq } of held) updateWorkflowStarts(this.workflowStarts, entry, seq);
		}
		this.admissionKeys = new SessionKeyDigests(resume.recovery.admissionDigests);
		this.historyStartSeq = held.length < resume.lastSeq ? (resume.branch[0]?.seq ?? resume.lastSeq + 1) : 1;
		if (held.length < resume.lastSeq && this.historyStartSeq === 1) this.historyStartSeq = 2;
		this.omittedTotals = held.length < resume.lastSeq ? resume.omitted : undefined;
		const path = [...resume.state.filter((e) => e.onBranch), ...resume.branch].sort((a, b) => a.seq - b.seq);
		this.branchLinks = new Map(path.slice(1).map((held, i) => [held.entry.id, path[i]!.entry.id]));
		this.leafId = resume.leafId;
		Object.assign(this.byId, { preferFullIds: !this.hasFullHistory() });
	}

	private restoreHistory(
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		lastSeq: number,
		location: string | undefined,
		partial?: {
			readonly fromSeq: number;
			readonly heldState: number;
			readonly omitted: SessionHistoryTotals;
			readonly links: ReadonlyMap<string, string>;
		},
	): void {
		this.fileEntries = [{ type: "session", ...header }, ...entries];
		this.sessionId = header.id;
		this.lastSeq = lastSeq;
		this.deletedFromStore = false;
		this.appendHalt = undefined;
		this.historyStartSeq = partial?.fromSeq ?? 1;
		this.answerWindowStart = 1;
		this.priorAnswer = undefined;
		this.entrySeqs = new Map(entries.map((entry, i) => [entry.id, i + 1]));
		this.lastEntryId = entries.at(-1)?.id ?? null;
		this.historyEpoch = undefined;
		this.archiveOnlyEpoch = false;
		this.recoveryState = { admissionDigests: "", intercomDeliveredIds: [] };
		this.admissionKeys = new SessionKeyDigests();
		this.workflowStarts = {};
		for (const [i, entry] of entries.entries()) updateWorkflowStarts(this.workflowStarts, entry, i + 1);
		this.omittedTotals = partial?.omitted;
		this.branchLinks = partial?.links;
		this.historyLoad = undefined;
		this.sessionFile =
			location ?? (this.store instanceof JsonlSessionStore ? this.store.locationFor(header) : undefined);
		this._buildIndex();
		this.syncOpenMarker();
	}

	hasFullHistory(): boolean {
		return this.historyStartSeq <= 1;
	}

	loadFullHistory(): Promise<void> {
		if (this.hasFullHistory()) return Promise.resolve();
		this.historyLoad ??= this.hydrateHistory().finally(() => {
			this.historyLoad = undefined;
		});
		return this.historyLoad;
	}

	async forEachStoredEntry(
		fromSeq: number,
		visit: (entry: SessionEntry, seq: number, held: boolean) => void,
	): Promise<number> {
		const { store, sessionId, historyEpoch } = this;
		const watermark = this.lastSeq;
		const held = new Map<number, SessionEntry>();
		for (const entry of this.getEntries()) {
			const seq = this.entrySeqs.get(entry.id);
			if (seq !== undefined) held.set(seq, entry);
		}
		for (let start = Math.max(1, fromSeq); start <= watermark; ) {
			const entry = held.get(start);
			if (entry !== undefined) {
				visit(entry, start, true);
				start++;
				continue;
			}
			let end = start;
			while (end < watermark && end - start < 4095 && !held.has(end + 1)) end++;
			const range = await readSessionRange(
				store,
				sessionId,
				start,
				end,
				this.archiveOnlyEpoch ? historyEpoch : undefined,
			);
			if (historyEpoch !== undefined && range.epoch !== historyEpoch)
				throw new SessionConflictError(sessionId, watermark, range.lastSeq);
			for (const [i, read] of range.entries.entries()) visit(read, range.seqs?.[i] ?? start + i, false);
			start = end + 1;
		}
		return watermark;
	}

	/** Iterate the stored history in append order up to the watermark at the start of the read. Stopping iteration
	 * stops further reads; none of the historical payloads are added to the live manager. */
	readHistory(options: SessionHistoryReadOptions = {}): AsyncGenerator<SessionHistoryPage, void> {
		return historyPages(this.store, this.sessionId, this.historyEpoch, this.lastSeq, options);
	}

	readHistoryChunks(
		reference: OversizedSessionEntry,
		options: { readonly offset?: number; readonly signal?: AbortSignal } = {},
	): AsyncGenerator<Uint8Array, void> {
		return historyChunks(this.store, this.sessionId, this.historyEpoch, reference, options);
	}

	private async hydrateHistory(): Promise<void> {
		const { store, sessionId, historyEpoch } = this;
		const held = new Map<number, SessionEntry>();
		await this.forEachStoredEntry(1, (entry, seq) => held.set(seq, entry));
		if (this.store !== store || this.sessionId !== sessionId || this.historyEpoch !== historyEpoch) return;
		const leafId = this.leafId;
		for (const entry of this.getEntries()) held.set(this.entrySeqs.get(entry.id)!, entry);
		const ordered = [...held].sort((a, b) => a[0] - b[0]);
		this.fileEntries = [this.fileEntries[0]!, ...ordered.map(([, entry]) => entry)];
		this.entrySeqs = new Map(ordered.map(([seq, entry]) => [entry.id, seq]));
		this.historyStartSeq = 1;
		this.omittedTotals = undefined;
		this.branchLinks = undefined;
		this._buildIndex();
		this.leafId = leafId;
	}

	refreshFromStore(): Promise<boolean> {
		return this.runMutation(() => this.refreshStoredTail());
	}

	private async refreshStoredTail(): Promise<boolean> {
		const { store, sessionId, lastSeq, historyEpoch, lastEntryId } = this;
		const range = await readSessionRange(
			store,
			sessionId,
			Math.max(1, lastSeq),
			Number.MAX_SAFE_INTEGER,
			this.archiveOnlyEpoch ? historyEpoch : undefined,
		);
		if (this.sessionId !== sessionId || this.store !== store || this.lastSeq !== lastSeq) return false;
		if (range.lastSeq < lastSeq || (historyEpoch !== undefined && range.epoch !== historyEpoch)) return false;
		if (lastSeq > 0 && range.entries[0]?.id !== lastEntryId) return false;
		const added = range.entries.slice(lastSeq > 0 ? 1 : 0);
		let parent = this.leafId;
		for (const entry of added) {
			if (entry.parentId !== parent) return false;
			parent = isLeafMoveEntry(entry) ? entry.parentId : entry.id;
		}
		this.lastSeq = range.lastSeq;
		this.applyAppended(added);
		if (added.length > 0) {
			this._buildIndex();
			this.leafId = parent;
		}
		return true;
	}

	getEntrySeq(id: string): number | undefined {
		return this.entrySeqs.get(id);
	}
	getLastSeq(): number {
		return this.lastSeq;
	}

	/** @internal The host of an unsaved isolated session owns an independent private backend. These positions
	 * let it combine the live (possibly locally mutated) rows with the same generation's archived bytes. */
	getPrivateMirrorArchive(
		entries: readonly SessionEntry[],
	): { sessionId: string; cursor: string; seqs: number[] } | undefined {
		if (this.isPersisted() || entries.length === this.lastSeq || this.historyEpoch === undefined) return undefined;
		return {
			sessionId: this.sessionId,
			cursor: firstHistoryCursor(this.sessionId, this.historyEpoch, this.lastSeq),
			seqs: entries.map((e) => this.entrySeqs.get(e.id)!),
		};
	}
	getSessionRecoveryState(): SessionRecoveryState {
		return { ...this.recoveryState, admissionDigests: this.admissionKeys.serialize() };
	}
	/** Read the identities of interrupted runs from their saved starts only when recovery is requested. */
	async readOpenWorkflowIds(): Promise<string[]> {
		const { store, sessionId, historyEpoch, lastSeq } = this;
		const ids: string[] = [];
		for (const seq of Object.values(this.workflowStarts)) {
			for await (const { items } of historyPages(store, sessionId, historyEpoch, lastSeq, {
				fromSeq: seq,
				toSeq: seq,
			})) {
				const item = items[0];
				if (!item) continue;
				if ("entry" in item) {
					const { entry } = item;
					if (entry.type === "custom" && entry.customType === "workflow.run.start") {
						const data = entry.data as { runId?: string } | undefined;
						if (typeof data?.runId === "string") ids.push(data.runId);
					}
				} else {
					const { readChunkedWorkflowRunId } = await import("./storage/session/chunked-resume-projection.js");
					const id = await readChunkedWorkflowRunId(historyChunks(store, sessionId, historyEpoch, item, {}));
					if (id !== undefined) ids.push(id);
				}
			}
			await yieldToEventLoop();
		}
		return ids;
	}

	getAdmissionKeys(): Pick<SessionKeyDigests, "has"> {
		return this.admissionKeys;
	}
	async findEntrySeq(id: string): Promise<number | undefined> {
		const held = this.entrySeqs.get(id);
		if (held !== undefined) return held;
		const { store, sessionId, historyEpoch, lastSeq } = this;
		if (store.findEntrySeq) {
			const seq = await store.findEntrySeq(sessionId, id);
			if (historyEpoch !== undefined && store.readEntrySizes) {
				const head = await store.readEntrySizes(sessionId, 1, 0);
				if (head.epoch !== historyEpoch || head.lastSeq < lastSeq)
					throw new SessionConflictError(sessionId, lastSeq, head.lastSeq);
			}
			return seq !== undefined && seq <= lastSeq ? seq : undefined;
		}
		for await (const { items } of historyPages(store, sessionId, historyEpoch, lastSeq, { direction: "backward" })) {
			for (let i = items.length - 1; i >= 0; i--) {
				const item = items[i]!;
				if (
					"entry" in item
						? item.entry.id === id
						: await (await import("./storage/session/chunked-resume-projection.js")).chunkedEntryHasId(
								historyChunks(store, sessionId, historyEpoch, item, {}),
								id,
							)
				)
					return item.seq;
			}
		}
		return undefined;
	}

	getHeldTail(): { readonly fromSeq: number; readonly entries: readonly SessionEntry[] } {
		return {
			fromSeq: this.historyStartSeq,
			entries: this.getEntries().filter((entry) => (this.entrySeqs.get(entry.id) ?? 0) >= this.historyStartSeq),
		};
	}

	getOmittedHistoryTotals(): SessionHistoryTotals | undefined {
		return this.omittedTotals;
	}

	/**
	 * @internal Marks the session this manager has open, and each one it switches to, as open in this process until
	 * the returned function is called, so that other processes and hosts refuse to delete it (#4971). The returned
	 * function never rejects; it settles once the mark is removed.
	 */
	holdOpen(): () => Promise<void> {
		this.openHolds++;
		this.syncOpenMarker();
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			this.openHolds--;
			await this.syncOpenMarker();
		};
	}

	private syncOpenMarker(): Promise<void> {
		const sessionId = this.openHolds > 0 && this.isPersisted() ? this.sessionId : undefined;
		const marker = this.openMarker;
		if (marker?.sessionId === sessionId && marker?.store === this.store) return Promise.resolve();
		this.openMarker =
			sessionId === undefined
				? undefined
				: { sessionId, store: this.store, release: holdSessionOpenMarker(sessionId, { store: this.store }) };
		return marker?.release() ?? Promise.resolve();
	}

	private start(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) assertValidSessionId(options.id);
		this.sessionId = options?.id ?? createSessionId();
		this.fileEntries = [
			createSessionHeader(
				this.sessionId,
				this.cwd,
				new Date().toISOString(),
				options?.parentSession,
				options?.internal,
				options?.workflow,
			),
		];
		this.lastSeq = 0;
		this.historyStartSeq = 1;
		this.answerWindowStart = 1;
		this.priorAnswer = undefined;
		this.omittedTotals = undefined;
		this.branchLinks = undefined;
		this._buildIndex();
		this.sessionFile =
			this.store instanceof JsonlSessionStore
				? this.sessionDir
					? createSessionFilePath(this.sessionDir, this.getHeader()!.createdAt, this.sessionId)
					: this.store.locationFor(this.recordHeader())
				: undefined;
		return this.sessionFile;
	}

	setSessionFile(sessionFile: string): Promise<void> {
		return this.runMutation(async () => {
			const path = resolvePath(sessionFile);
			const { store, opened } = await openSessionFileWindow(path, this.cwd);
			validateSessionFileEntries(
				[
					{ type: "session", ...opened.resume.header },
					...opened.resume.state.map(({ entry }) => entry),
					...opened.resume.branch.map(({ entry }) => entry),
				],
				path,
			);
			this.store = store;
			this.restoreOpened(opened, path);
		});
	}

	private async initialize(): Promise<void> {
		const created = await (this.store instanceof JsonlSessionStore
			? this.store.create(this.recordHeader(), this.getEntries(), this.sessionFile)
			: this.store.create(this.recordHeader(), this.getEntries()));
		this.lastSeq = created.lastSeq;
		this.historyEpoch = created.epoch;
		this.entrySeqs = new Map(this.getEntries().map((entry, i) => [entry.id, i + 1]));
		this.lastEntryId = this.getEntries().at(-1)?.id ?? null;
	}

	private async storeForNewSession(): Promise<SessionStore> {
		if (
			this.store instanceof JsonlSessionStore &&
			this.sessionDir &&
			this.store.descriptor.location !== resolvePath(this.sessionDir)
		) {
			return JsonlSessionStore.open(this.sessionDir, { exactDirectory: true, scanExisting: false });
		}
		return this.store;
	}

	newSession(options?: NewSessionOptions): Promise<string | undefined> {
		return this.runMutation(async () => {
			if (options?.id !== undefined) assertValidSessionId(options.id);
			const header = createSessionHeader(
				options?.id ?? createSessionId(),
				this.cwd,
				new Date().toISOString(),
				options?.parentSession,
				options?.internal,
				options?.workflow,
			);
			const record = this.recordHeader(header);
			const store = await this.storeForNewSession();
			const location =
				store instanceof JsonlSessionStore
					? this.sessionDir
						? createSessionFilePath(this.sessionDir, record.createdAt, record.id)
						: store.locationFor(record)
					: undefined;
			const result = await (store instanceof JsonlSessionStore
				? store.create(record, [], location)
				: store.create(record, []));
			this.store = store;
			this.byId.clear();
			this.labelsById.clear();
			this.labelTimestampsById.clear();
			this.restore({ header: record, entries: [], lastSeq: result.lastSeq, epoch: result.epoch }, location);
			return this.sessionFile;
		});
	}

	markSessionInternal(workflow?: SessionWorkflowMetadata): Promise<void> {
		return this.runMutation(async () => {
			const previous = this.getHeader()!;
			if (classifiedWorkflowMetadata(previous)) return;
			const validWorkflow = validSessionWorkflowMetadata(workflow);
			if (!validWorkflow) return;
			if (!this.store.updateHeader)
				throw new TypeError(`Session store ${this.store.descriptor.adapter} must implement updateHeader`);
			const header: SessionHeader = { ...previous, internal: true, workflow: validWorkflow };
			const result = await this.store.updateHeader(this.recordHeader(header), {
				expectSeq: this.lastSeq,
				...(this.archiveOnlyEpoch || this.historyEpoch === undefined ? {} : { epoch: this.historyEpoch }),
			});
			this.lastSeq = result.lastSeq;
			this.historyEpoch = result.epoch;
			this.fileEntries[0] = header;
		});
	}

	private _buildIndex(): void {
		this.historyIndex = new SessionHistoryIndex();
		validateSessionFileEntries(this.fileEntries, this.sessionFile ?? "in-memory session");
		const index = buildSessionIndex(this.fileEntries);
		this.byId = index.byId;
		this.labelsById = index.labelsById;
		this.labelTimestampsById = index.labelTimestampsById;
		this.contextEdits = index.contextEdits;
		this.projectedEdits = undefined;
		this.leafId = index.leafId;
		Object.assign(this.byId, { preferFullIds: !this.hasFullHistory() });
	}

	isPersisted(): boolean {
		return !(this.store instanceof MemorySessionStore);
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return pathsEqual(this.sessionDir, getDefaultSessionDirPath(this.cwd));
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	getSessionStore(): SessionStore {
		return this.store;
	}

	async deleteSession(sessionId: string): Promise<void> {
		assertValidSessionId(sessionId);
		if (sessionId === this.sessionId) {
			throw new Error(`Cannot delete the session that is currently open: ${sessionId}`);
		}
		await assertSessionNotOpenElsewhere(sessionId, { store: this.store });
		try {
			await deleteSessionWithSnapshotRefs(this.store, sessionId);
		} catch (error) {
			if (!(error instanceof SessionNotFoundError)) throw error;
		}
	}

	/** A compatible store takes a caller-owned array for a cross-store copy. Keep that input out of the live window,
	 * including if the destination write fails. The source watermark belongs to the manager, not a later appender. */
	private async compatibilityCopyEntries(): Promise<SessionEntry[]> {
		if (this.hasFullHistory()) return this.getEntries();
		const entries: SessionEntry[] = [];
		await this.forEachStoredEntry(1, (entry) => entries.push(entry));
		return entries;
	}

	/** @internal Finalize provisional startup storage after project trust resolves. */
	rebindStore(store: SessionStore, removeProvisionalRecord: boolean): Promise<void> {
		return this.runMutation(async () => {
			if (store === this.store) return;
			const header = this.recordHeader();
			const entries = await this.compatibilityCopyEntries();
			const hashes = sessionBlobHashes(this.store, entries);
			assertSessionBlobStore(store, this.sessionId, hashes.length);
			const result = await store.create(header, entries);
			await copySessionBlobs(this.store, this.sessionId, store, this.sessionId, hashes);
			const opened = await readStoredSession(store, this.sessionId, undefined);
			if (
				opened.resume.lastSeq !== result.lastSeq ||
				(result.epoch !== undefined && opened.resume.epoch !== result.epoch)
			)
				throw new SessionConflictError(this.sessionId, result.lastSeq, opened.resume.lastSeq);
			if (removeProvisionalRecord) await this.store.delete(this.sessionId);
			this.store = store;
			this.sessionDir = store instanceof JsonlSessionStore ? store.descriptor.location : "";
			this.restoreOpened(opened);
		});
	}

	async openSessionById(
		sessionId: string,
		cwdOverride?: string,
		sessionDirectory?: string,
		options?: SessionOpenOptions,
	): Promise<SessionManager> {
		let store =
			sessionDirectory === undefined
				? this.store
				: await JsonlSessionStore.open(sessionDirectory, { exactDirectory: true, scanExisting: false });
		let opened: OpenedSession;
		try {
			opened = await readStoredSession(store, sessionId, options);
		} catch (error) {
			if (
				!(error instanceof SessionNotFoundError) ||
				sessionDirectory !== undefined ||
				!this.usesDefaultSessionDir()
			)
				throw error;
			store = await JsonlSessionStore.open(join(getAgentDir(), "sessions"), { scanExisting: false });
			opened = await readStoredSession(store, sessionId, options);
		}
		const location = store instanceof JsonlSessionStore ? await store.findFile(sessionId) : undefined;
		if (location !== undefined) {
			const selected = await JsonlSessionStore.open(dirname(location), {
				exactDirectory: true,
				scanExisting: false,
			});
			selected[bindSessionFile](sessionId, location);
			store = selected;
			opened = await readStoredSession(store, sessionId, options);
		}
		const header = openedHeader(opened);
		if (header.id !== sessionId) throw new SessionIdMismatchError(sessionId, header.id);
		const manager = new SessionManager(store, cwdOverride ?? header.cwd, this.sessionDir);
		manager.restoreOpened(opened, location);
		if (location !== undefined) manager.sessionDir = dirname(location);
		return manager;
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<SessionManager> {
		const source = await JsonlSessionStore.open(dirname(resolvePath(inputPath)), {
			exactDirectory: true,
			scanExisting: false,
		});
		try {
			const loaded = await source.loadFile(inputPath);
			const { entries, blobs } = takeInlineToolOutput(loaded.entries, loaded.header.id);
			assertSessionBlobStore(this.store, loaded.header.id, blobs.length);
			const snapshot = {
				...loaded,
				entries: await adoptInlineSnapshotBlobs(entries, this.store.snapshotBlobs),
			};
			const manager = new SessionManager(this.store, cwdOverride ?? snapshot.header.cwd, this.sessionDir);
			manager.restore(snapshot);
			await manager.initialize();
			await storeSessionBlobs(this.store, snapshot.header.id, blobs);
			return manager;
		} finally {
			await source.close();
		}
	}

	private _appendEntry(entry: SessionEntry, target?: SessionResume): Promise<void> {
		return this._appendEntries([entry], target);
	}

	private async _appendEntries(entries: readonly SessionEntry[], target?: SessionResume): Promise<void> {
		if (this.appendHalt !== undefined) throw this.appendHalt;
		// #4971: the session was deleted from its store; that was reported once, and nothing more is saved.
		if (this.deletedFromStore) {
			if (target) this.restoreOpened({ resume: target }, this.sessionFile);
			return this.applyAppended(entries);
		}
		for (let attempt = 1; ; attempt++) {
			const expectSeq = this.lastSeq;
			try {
				const written = await this.store.append(this.sessionId, entries, {
					expectSeq,
					...(this.archiveOnlyEpoch || this.historyEpoch === undefined ? {} : { epoch: this.historyEpoch }),
				});
				if (target) this.restoreOpened({ resume: target }, this.sessionFile);
				this.lastSeq = written.lastSeq;
			} catch (error) {
				if (error instanceof SessionNotFoundError) {
					this.deletedFromStore = true;
					throw new SessionDeletedError(this.sessionId, { cause: error });
				}
				if (appendFailureWroteNothing(error) || attempt > MAX_APPEND_RECONCILES) throw error;
				const unknown = isStorageTransientError(error) && error.outcome === "unknown";
				if (await this.reconcileAppend(entries, error, unknown, expectSeq, target)) return;
				continue;
			}
			this.applyAppended(entries);
			return;
		}
	}

	private applyAppended(entries: readonly SessionEntry[]): void {
		for (const [position, entry] of entries.entries()) {
			this.entrySeqs.set(entry.id, this.lastSeq - entries.length + position + 1);
			updateWorkflowStarts(this.workflowStarts, entry, this.lastSeq - entries.length + position + 1);
			this.lastEntryId = entry.id;
			this.fileEntries.push(entry);
			this.byId.set(entry.id, entry);
			if (entry.type === "context_edit") this.contextEdits++;
			else if (entry.type !== "compaction" && this.projectedEdits?.leafId === entry.parentId)
				this.projectedEdits.leafId = entry.id;
			this.historyIndex.appended(entry, this.byId);
			this.leafId = entry.id;
		}
		if (entries.some((entry) => entry.type === "compaction")) this.releaseEarlierWindow();
	}

	/** Retire the old window in the same mutation as the boundary. Never reread after a committed append: a read
	 * could fail or observe another writer, neither of which changes what this append committed. */
	private releaseEarlierWindow(): void {
		const entries = this.getEntries();
		const linked = this.branchLinks
			? entries.map((entry) => {
					const parentId = this.branchLinks?.get(entry.id);
					return parentId !== undefined && parentId !== entry.parentId ? { ...entry, parentId } : entry;
				})
			: entries;
		const resume = sessionResumeOf(this.recordHeader(), linked, this.leafId ?? undefined);
		if (!resume.compaction) return;
		this.admissionKeys.mergeEncoded(resume.recovery.admissionDigests);
		this.recoveryState = {
			...this.recoveryState,
			intercomDeliveredIds: [
				...new Set([...this.recoveryState.intercomDeliveredIds, ...resume.recovery.intercomDeliveredIds]),
			],
			deliveryOpIds: [
				...new Set([...(this.recoveryState.deliveryOpIds ?? []), ...(resume.recovery.deliveryOpIds ?? [])]),
			],
		};
		const keep = new Set([...resume.branch, ...resume.state].map(({ entry }) => entry.id));
		const start = this.entrySeqs.get(resume.branch[0]!.entry.id)!;
		const leaf = this.leafId;
		const current = this.getBranch();
		const retiringAnswer = lastBranchAnswer(current, (entry) => {
			const seq = this.entrySeqs.get(entry.id)!;
			return seq >= this.answerWindowStart && seq < start;
		});
		this.priorAnswer = retiringAnswer ?? this.priorAnswer;
		this.answerWindowStart = start;
		const path = current.filter((entry) => keep.has(entry.id));
		const retained: FileEntry[] = [this.fileEntries[0]!];
		let totals = this.omittedTotals ?? EMPTY_SESSION_HISTORY_TOTALS;
		for (const entry of entries) {
			if (keep.has(entry.id)) retained.push(entry);
			else {
				totals = addEntryToHistoryTotals(totals, entry);
				const seq = this.entrySeqs.get(entry.id)!;
				if (
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					seq > (totals.latestAssistantSeq ?? 0)
				)
					totals = { ...totals, latestAssistantUsage: entry.message.usage, latestAssistantSeq: seq };
				this.entrySeqs.delete(entry.id);
			}
		}
		this.fileEntries = retained;
		if (keep.size < this.lastSeq) {
			this.historyStartSeq = Math.max(2, start);
			this.omittedTotals = totals;
		}
		this.branchLinks = new Map(path.slice(1).map((entry, i) => [entry.id, path[i]!.id]));
		this._buildIndex();
		this.leafId = leaf;
	}

	/**
	 * #4970: an append failed with an error that does not say it wrote nothing (the connection broke, or a gateway
	 * answered 5xx, after the server may have committed it) or found the store ahead of `lastSeq`. Reads the store's entries past `lastSeq` and takes them in, in store order, so
	 * the manager holds what the store holds; entries other than `entries` join the tree without moving the leaf.
	 * Resolves true when `entries` are among them (they are saved), and false when they are not and the rest are this
	 * manager's own from an earlier append of unknown outcome (`entries` go on after them). Throws a
	 * `SessionConflictError` when another writer added entries (or the store reported a conflict it does not show):
	 * the append fails once, and later appends go on after the new tail. Rethrows `error` when the store cannot be
	 * read, when its history no longer extends the one this manager holds, or when it shows the failed append wrote
	 * nothing and the failure is not one that passes.
	 */
	private async reconcileAppend(
		entries: readonly SessionEntry[],
		error: unknown,
		unknown: boolean,
		expectSeq: number,
		target?: SessionResume,
	): Promise<boolean> {
		// Entries of an append that failed for certain are never in the store, so marking them too changes nothing.
		for (const entry of entries) this.unconfirmed.add(entry.id);
		let read: { readonly entries: readonly SessionEntry[]; readonly lastSeq: number };
		try {
			read = await readSessionRange(
				this.store,
				this.sessionId,
				Math.max(1, this.lastSeq),
				Number.MAX_SAFE_INTEGER,
				this.archiveOnlyEpoch ? this.historyEpoch : undefined,
			);
		} catch {
			// Still unreadable: the next append, at the same `lastSeq`, finds out whether these entries were saved.
			throw error;
		}
		const stored = this.lastSeq > 0 ? read.entries : [undefined, ...read.entries];
		const lastHeld = this.lastEntryId ?? undefined;
		if (
			stored[0]?.id !== lastHeld ||
			(this.historyEpoch !== undefined && "epoch" in read && read.epoch !== this.historyEpoch)
		)
			throw error;
		const own = new Map(entries.map((entry) => [entry.id, entry]));
		const tail = (stored.slice(1) as SessionEntry[]).map((entry) => own.get(entry.id) ?? entry);
		const saved = tail.some((entry) => own.has(entry.id));
		const foreign = tail.some((entry) => !this.unconfirmed.has(entry.id));
		if (target && saved) this.restoreOpened({ resume: target }, this.sessionFile);
		const leafId = saved ? entries.at(-1)!.id : this.leafId;
		for (const [i, entry] of tail.entries()) {
			this.entrySeqs.set(entry.id, this.lastSeq + i + 1);
			updateWorkflowStarts(this.workflowStarts, entry, this.lastSeq + i + 1);
		}
		this.lastEntryId = tail.at(-1)?.id ?? this.lastEntryId;
		this.fileEntries = [...this.fileEntries, ...tail];
		this._buildIndex();
		this.leafId = leafId;
		this.lastSeq = read.lastSeq;
		if (saved) return true;
		const conflict = error instanceof SessionConflictError;
		// The prepared target describes the old watermark. Keep our original leaf when it lost the race,
		// but acknowledge the observed tail before reporting the conflict so a retry can prepare a fresh target.
		if ((target && tail.length > 0) || foreign || (conflict && tail.length === 0)) {
			const stop = conflict ? error : new SessionConflictError(this.sessionId, expectSeq, this.lastSeq);
			if (this.appendHaltPolicy?.() === true) this.appendHalt ??= stop;
			throw stop;
		}
		// Nothing of ours was written: a failure that passes is tried again, any other stands.
		if (!unknown && !conflict) throw error;
		return false;
	}

	/**
	 * @internal Record the model and thinking level a new session starts on with one store write, as a model change
	 * followed by a thinking level change.
	 */
	appendStartState(
		model: { readonly provider: string; readonly modelId: string } | undefined,
		thinkingLevel: string,
	): Promise<void> {
		return this.runMutation(async () => {
			const modelEntry =
				model === undefined
					? undefined
					: createModelChangeEntry(model.provider, model.modelId, this.byId, this.leafId);
			const thinkingEntry = createThinkingLevelChangeEntry(
				thinkingLevel,
				{ has: (id) => id === modelEntry?.id || this.byId.has(id), preferFullIds: !this.hasFullHistory() },
				modelEntry?.id ?? this.leafId,
			);
			await this._appendEntries(modelEntry === undefined ? [thinkingEntry] : [modelEntry, thinkingEntry]);
		});
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id. */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): Promise<string> {
		return this.runMutation(async () => {
			const entry = createMessageEntry(message, this.byId, this.leafId);
			const companion = this.messageCompanions.get(message);
			this.messageCompanions.delete(message);
			const custom = companion?.();
			await this._appendEntries(
				custom === undefined
					? [entry]
					: [
							entry,
							createCustomEntry(
								custom.customType,
								custom.data,
								{ has: (id) => id === entry.id || this.byId.has(id), preferFullIds: !this.hasFullHistory() },
								entry.id,
							),
						],
			);
			return entry.id;
		});
	}

	/**
	 * @internal Writes the custom entry `companion` returns in the same store write as `message`, right after it, when
	 * `message` is appended: the session then holds both or neither. `companion` runs once, as that write is made, and
	 * may return undefined to write the message alone; a message never appended never calls it.
	 */
	appendWithMessage(message: object, companion: () => MessageCompanionEntry | undefined): void {
		this.messageCompanions.set(message, companion);
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.runMutation(async () => {
			const entry = createThinkingLevelChangeEntry(thinkingLevel, this.byId, this.leafId);
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	/** Record auxiliary model usage without adding it to the LLM context. */
	appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): Promise<UsageEntry> {
		return this.runMutation(async () => {
			const entry: UsageEntry = {
				type: "usage",
				id: generateId(this.byId),
				parentId: this.leafId,
				timestamp: new Date().toISOString(),
				kind,
				provider,
				model,
				usage,
				...(note === undefined ? {} : { note }),
			};
			await this._appendEntry(entry);
			return entry;
		});
	}

	/**
	 * Append a model change as child of current leaf, then advance leaf. Returns entry id. `fallback` records why a model
	 * fallback made the change.
	 */
	appendModelChange(provider: string, modelId: string, fallback?: ModelFallbackRecord): Promise<string> {
		return this.runMutation(async () => {
			const entry = createModelChangeEntry(provider, modelId, this.byId, this.leafId, fallback);
			await this._appendEntry(entry);
			return entry.id;
		});
	}
	/**
	 * Append a compaction boundary. `compactedText` may be a builder that receives the history's last entry position right
	 * before the boundary, computed inside this queued mutation so no concurrent append can shift it, and returns the
	 * boundary text with the details to store.
	 */
	appendCompaction(
		compactedText: string | ((historyEntries: number) => { text: string; details: VerbatimCompactionDetails }),
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details: VerbatimCompactionDetails,
		usage?: Usage,
		coveredThroughEntryId?: string,
		precondition?: () => void,
	): Promise<string> {
		return this.runMutation(async () => {
			precondition?.();
			if (firstKeptEntryId !== null) await this.requireEntryExists(firstKeptEntryId);
			if (coveredThroughEntryId !== undefined) await this.requireEntryExists(coveredThroughEntryId);
			const built =
				typeof compactedText === "string" ? { text: compactedText, details } : compactedText(this.getLastSeq());
			precondition?.();
			const entry = createCompactionEntry(
				built.text,
				firstKeptEntryId,
				tokensBefore,
				built.details,
				usage,
				this.byId,
				this.leafId,
				coveredThroughEntryId,
			);
			const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages);
			if (systemMessage) entry.systemMessage = { ...systemMessage, timestamp: new Date(entry.timestamp).getTime() };
			const expanded = await this.expandForBoundary([firstKeptEntryId, coveredThroughEntryId]);
			if (expanded) precondition?.();
			await this._appendEntry(entry, expanded);
			return entry.id;
		});
	}

	/** A boundary may name an ancestor before the previous window. Stage that exact branch span before
	 * committing. The old view and its entry identities remain unchanged if a read or the write fails. */
	private async expandForBoundary(
		anchors: readonly (string | null | undefined)[],
	): Promise<SelectedWindow | undefined> {
		if (this.answerWindowStart <= 1 || !this.leafId) return;
		const leaf = this.entrySeqs.get(this.leafId)!;
		let from = this.answerWindowStart;
		for (const id of anchors) {
			if (id == null) continue;
			const at = await this.findEntrySeq(id);
			if (at === undefined || at >= from) continue;
			// A pointer to a sibling does not extend the active window.
			const match = await this.readHistory({ branchLeafSeq: leaf, fromSeq: at, toSeq: at }).next();
			if (!match.done) from = at;
		}
		if (from === this.answerWindowStart) return;
		const path = this.getBranch();
		const onBranch = new Set(path.map((entry) => entry.id));
		const branch: SessionStoredEntry[] = [];
		let omitted = this.omittedTotals ?? EMPTY_SESSION_HISTORY_TOTALS;
		for await (const { items } of this.readHistory({
			branchLeafSeq: leaf,
			fromSeq: from,
			toSeq: this.answerWindowStart - 1,
		})) {
			for (const item of items) {
				const entry =
					"entry" in item
						? item.entry
						: (await readSessionRange(this.store, this.sessionId, item.seq, item.seq, this.historyEpoch))
								.entries[0]!;
				const local = this.byId.get(entry.id);
				branch.push({ seq: item.seq, entry: local ?? entry });
				if (!local) omitted = addEntryToHistoryTotals(omitted, entry, -1);
			}
		}
		for (const entry of path) {
			const seq = this.entrySeqs.get(entry.id)!;
			if (seq >= this.answerWindowStart) branch.push({ seq, entry });
		}
		const kept = new Set(branch.map(({ entry }) => entry.id));
		const first = branch[0]!;
		const edits = new Map(
			branch.flatMap(({ seq, entry }) => (entry.type === "context_edit" ? [[entry.targetId, seq] as const] : [])),
		);
		const priorAnswer = first.entry.parentId
			? await archivedAnswerAt(
					this.store,
					this.sessionId,
					this.historyEpoch,
					this.lastSeq,
					first.seq,
					first.entry.parentId,
					edits,
				)
			: undefined;
		return {
			header: this.recordHeader(),
			epoch: this.historyEpoch!,
			archiveOnlyEpoch: this.archiveOnlyEpoch ? true : undefined,
			lastSeq: this.lastSeq,
			lastEntryId: this.lastEntryId,
			leafId: this.leafId,
			branch,
			state: this.getEntries()
				.filter((entry) => !kept.has(entry.id))
				.map((entry) => ({ seq: this.entrySeqs.get(entry.id)!, entry, onBranch: onBranch.has(entry.id) })),
			omitted,
			priorAnswer,
			recovery: { ...this.getSessionRecoveryState(), workflowStarts: this.workflowStarts },
		};
	}

	/** Save a JSONL backup; database-backed sessions have no file snapshot. */
	writeBackupSnapshot(label = "compact"): Promise<string | undefined> {
		return this.runMutation(async () => {
			if (!(this.store instanceof JsonlSessionStore) || !this.sessionFile) return undefined;
			const path = `${this.sessionFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.${label.replace(/[^a-z0-9_-]/gi, "-") || "backup"}.bak`;
			const header = this.getHeader()!;
			const history = this.readHistory();
			const chunks = this.readHistoryChunks.bind(this);
			async function* contents() {
				yield `${JSON.stringify(header)}\n`;
				for await (const { items } of history) {
					for (const item of items) {
						if ("entry" in item) yield `${JSON.stringify(item.entry)}\n`;
						else {
							yield* chunks(item);
							yield "\n";
						}
					}
				}
			}
			try {
				await writeChunksAtomically(path, contents());
			} catch (cause) {
				throw new StorageUnavailableError(this.store.descriptor, cause as Error);
			}
			return path;
		});
	}

	/** Append a branch-local edit to an earlier model-visible entry. */
	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): Promise<string> {
		return this.runMutation(async () => {
			if (
				replacement !== null &&
				(typeof replacement !== "object" ||
					!("content" in replacement) ||
					(typeof replacement.content !== "string" && !Array.isArray(replacement.content)))
			) {
				throw new SessionEntryError(targetId, "invalid-replacement");
			}
			const branch = this.getBranch();
			const seq = await this.findEntrySeq(targetId);
			if (seq === undefined) throw new SessionEntryError(targetId, "missing");
			const held = branch.find((entry) => entry.id === targetId);
			let targetRole: string | undefined;
			if (held)
				targetRole =
					held.type === "message" ? held.message.role : held.type === "custom_message" ? "custom" : undefined;
			else {
				const leaf = this.leafId && this.entrySeqs.get(this.leafId);
				if (!leaf) throw new SessionEntryError(targetId, "inactive");
				const next = await this.readHistory({ branchLeafSeq: leaf, fromSeq: seq, toSeq: seq }).next();
				const item = !next.done && next.value.items[0];
				if (!item) throw new SessionEntryError(targetId, "inactive");
				if ("entry" in item)
					targetRole =
						item.entry.type === "message"
							? item.entry.message.role
							: item.entry.type === "custom_message"
								? "custom"
								: undefined;
				else {
					const hint = await (await import("./storage/session/chunked-resume-projection.js")).chunkedAnswerHeader(
						this.readHistoryChunks(item),
					);
					targetRole = hint.type === "message" ? hint.role : hint.type === "custom_message" ? "custom" : undefined;
				}
			}
			if (
				targetRole !== "custom" &&
				targetRole !== "user" &&
				targetRole !== "toolResult" &&
				targetRole !== "assistant"
			)
				throw new SessionEntryError(targetId, "not-editable");
			const normalizedReplacement =
				replacement !== null &&
				(targetRole === "assistant" || targetRole === "toolResult") &&
				typeof replacement.content === "string"
					? { content: [{ type: "text" as const, text: replacement.content }] }
					: replacement;
			const entry = createContextEditEntry(targetId, normalizedReplacement, this.byId, this.leafId);
			const first =
				targetRole === "assistant" && seq < this.answerWindowStart
					? branch.find((item) => this.entrySeqs.get(item.id) === this.answerWindowStart)
					: undefined;
			const before = first
				? await archivedAnswerAt(
						this.store,
						this.sessionId,
						this.historyEpoch,
						this.lastSeq,
						this.answerWindowStart,
						first.parentId,
						new Map(
							branch.flatMap((item) =>
								item.type === "context_edit" ? [[item.targetId, this.entrySeqs.get(item.id)!] as const] : [],
							),
						),
						entry,
					)
				: undefined;
			await this._appendEntry(entry);
			if (first) this.priorAnswer = before;
			return entry.id;
		});
	}

	static {
		appendOwnedSubagentChildRecord = (manager, ownerId, data, live) =>
			manager.runMutation(async () => {
				if (typeof data?.childId !== "string" || data.owner?.sessionId !== ownerId)
					throw new Error("Cannot save a subagent-child record belonging to another owner.");
				const refusal = `Cannot save subagent-child record: session ${ownerId} no longer owns its writer.`;
				// A session its owner gave up refuses the record as its closed extension API does.
				if (manager.sessionId !== ownerId || !live())
					throw Object.assign(new Error(refusal), { code: "SessionClosed" });
				if (manager.deletedFromStore) throw new Error(refusal);
				await manager.appendCustomEntryAtLeaf("subagent-child", data);
			});
	}

	private async appendCustomEntryAtLeaf<T>(customType: string, data?: T): Promise<string> {
		const entry = createCustomEntry(customType, data, this.byId, this.leafId);
		await this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry<T = SessionJsonValue>(customType: string, data?: T): Promise<string> {
		return this.runMutation(() => this.appendCustomEntryAtLeaf(customType, data));
	}

	/**
	 * @internal Stores `data` as a blob of the current session and appends the entry that references it, as one
	 * mutation, so a session change cannot come between the two. The blob goes first: a process that stops in between
	 * leaves only a blob of this session. Rejects with `blobs-unsupported` when the store holds no blobs.
	 */
	appendToolOutputBlob(toolCallId: string, data: Uint8Array): Promise<SessionBlob> {
		return this.runMutation(async () => {
			const { putBlob } = this.store;
			if (putBlob === undefined) {
				throw new SessionBlobError("blobs-unsupported", {
					sessionId: this.sessionId,
					adapter: this.store.descriptor.adapter,
				});
			}
			const blob = await putBlob.call(this.store, this.sessionId, data);
			const reference: ToolOutputReference = { toolCallId, hash: blob.hash, bytes: blob.bytes };
			await this._appendEntry(createCustomEntry(TOOL_OUTPUT_ENTRY_TYPE, reference, this.byId, this.leafId));
			return blob;
		});
	}

	/**
	 * Record a checkout's snapshot at the current leaf. Pass the snapshot when it is new; omit it to refer to an earlier
	 * entry's snapshot with the same id (an unchanged capture). `restore` records that the snapshot was restored on
	 * this host into `root`, and `restoreWarnings` what that restore reported beyond its snapshot record. `unrestored`
	 * records that a resume continued without restoring the checkout at `root` (#4733). `captureMs` is how long the
	 * turn's capture took (#4748). `degradedFrom` names the snapshot a resume restored only partly into `root`, which
	 * stays the checkout's restore target while this entry records the worktree as it is (#4922).
	 */
	appendWorktreeSnapshot(
		root: string,
		snapshotId: string,
		snapshot?: WorktreeSnapshot,
		restore?: WorktreeRootMapping,
		restoreWarnings: readonly WorktreeRestoreHostWarning[] = [],
		unrestored?: WorktreeUnrestored,
		captureMs?: number,
		degradedFrom?: string,
	): Promise<string> {
		return this.runMutation(async () => {
			if (snapshot !== undefined && snapshot.id !== snapshotId) {
				throw new WorkspaceConfigError("sdk", "snapshot", "a snapshot whose id is snapshotId");
			}
			if (snapshot === undefined && !this.getWorktreeSnapshotRecords().has(snapshotId)) {
				throw new WorkspaceConfigError("sdk", "snapshotId", "the id of a snapshot recorded in this session");
			}
			if (restore !== undefined && (restore.to !== root || restore.snapshotId !== snapshotId)) {
				throw new WorkspaceConfigError("sdk", "restore", "a mapping to root for snapshotId");
			}
			if (unrestored !== undefined && (restore !== undefined || unrestored.snapshotId !== snapshotId)) {
				throw new WorkspaceConfigError("sdk", "unrestored", "an unrestored record of snapshotId without a restore");
			}
			if (restore === undefined && restoreWarnings.length > 0) {
				throw new WorkspaceConfigError("sdk", "restoreWarnings", "warnings recorded together with their restore");
			}
			if (
				degradedFrom !== undefined &&
				(degradedFrom === snapshotId || !this.getWorktreeSnapshotRecords().has(degradedFrom))
			) {
				throw new WorkspaceConfigError(
					"sdk",
					"degradedFrom",
					"the id of another snapshot recorded in this session",
				);
			}
			const entry = createWorktreeSnapshotEntry(
				root,
				snapshotId,
				snapshot,
				restore,
				restoreWarnings,
				this.byId,
				this.leafId,
				unrestored,
				captureMs,
				degradedFrom,
			);
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	/** Restores recorded on the active branch, oldest first: work recorded under `from` continues under `to`. */
	getWorktreeRootMappings(): WorktreeRootMapping[] {
		return this.historyIndex.worktreeRootMappings(this.leafId, this.byId, this.branchLinks);
	}

	/** Where the session continued instead of checkouts it worked in, on the active branch (#5379). */
	getWorktreePathContinuations(): PathContinuation[] {
		return this.historyIndex.worktreePathContinuations(this.leafId, this.byId, this.branchLinks);
	}

	/** Every snapshot record in the session, by id. */
	getWorktreeSnapshotRecords(): Map<string, WorktreeSnapshot> {
		return this.historyIndex.worktreeSnapshotRecords(this.fileEntries);
	}

	/** The latest snapshot of each checkout root on the active branch, keyed by the root it was last recorded under. */
	getLatestWorktreeSnapshots(): Map<string, WorktreeSnapshot> {
		const records = this.getWorktreeSnapshotRecords();
		const latest = new Map<string, WorktreeSnapshot>();
		for (const { root, snapshotId } of this.historyIndex.worktreeSnapshots(
			this.leafId,
			this.byId,
			this.branchLinks,
		)) {
			const snapshot = records.get(snapshotId);
			if (snapshot) latest.set(root, snapshot);
		}
		return latest;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): Promise<string> {
		return this.runMutation(async () => {
			const entry = createSessionInfoEntry(name, this.byId, this.leafId);
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	/** Append a generated resume summary anchored to the message it describes. Returns entry id. */
	appendSessionSummary(summary: string, summarizedThroughId: string, usage?: Usage): Promise<string> {
		return this.runMutation(async () => {
			await this.requireEntryExists(summarizedThroughId);
			const entry = createSessionSummaryEntry(summary, summarizedThroughId, usage, this.byId, this.leafId);
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		return this.getSessionNameState().name;
	}

	/**
	 * Get the session name state. `hasName` is true for a session that was named and
	 * then cleared even though `name` is undefined; a never-named session reports
	 * `hasName: false`. Read-side only: the JSONL already records the distinction.
	 */
	getSessionNameState(): SessionNameState {
		return this.historyIndex.sessionName(this.fileEntries);
	}

	/** Append a custom message entry (for extensions) that participates in LLM context unless excluded. */
	appendCustomMessageEntry<T = SessionJsonValue>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		excludeFromContext?: boolean,
		protectedReconciliation?: { delivery: "steer" | "followUp" },
		stageAdmissionKey?: string,
	): Promise<string> {
		return this.runMutation(async () => {
			const entry = createCustomMessageEntry(
				customType,
				content,
				display,
				details,
				excludeFromContext,
				protectedReconciliation,
				this.byId,
				this.leafId,
				stageAdmissionKey,
			);
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	async readEntry(id: string): Promise<SessionEntry | undefined> {
		const held = this.byId.get(id);
		if (held) return held;
		const { store, sessionId, historyEpoch, lastSeq } = this;
		const seq = await this.findEntrySeq(id);
		if (seq !== undefined && seq <= lastSeq) {
			for await (const { items } of historyPages(store, sessionId, historyEpoch, lastSeq, {
				fromSeq: seq,
				toSeq: seq,
			})) {
				const item = items[0];
				if (item && !("entry" in item))
					throw Object.assign(
						new Error(
							`Session entry ${seq} is ${item.bytes} bytes. Use readHistoryChunks(reference) to read it.`,
						),
						{ name: "OversizedSessionEntryError", reference: item },
					);
				if (item?.entry.id === id) return item.entry;
			}
		}
		return undefined;
	}

	/** A label, summary anchor or boundary pointer names an entry; it does not read that entry's body. */
	private async requireEntryExists(id: string): Promise<void> {
		if (!this.byId.has(id) && (await this.findEntrySeq(id)) === undefined) throw new SessionEntryError(id, "missing");
	}

	private async requireEntry(id: string): Promise<SessionEntry> {
		const entry = await this.readEntry(id);
		if (entry === undefined) throw new SessionEntryError(id, "missing");
		return entry;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/** Get all direct children of an entry. Like `getTree()`, omits recorded leaf moves. */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId && !isLeafMoveEntry(entry)) {
				children.push(entry);
			}
		}
		return children;
	}

	/** Get the label for an entry, if any. */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	getLabelTimestamp(id: string): string | undefined {
		return this.labelTimestampsById.get(id);
	}

	/** Set or clear a label on an entry. */
	appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		return this.runMutation(async () => {
			await this.requireEntryExists(targetId);
			const entry = createLabelEntry(targetId, label, this.byId, this.leafId);
			await this._appendEntry(entry);
			if (label) {
				this.labelsById.set(targetId, label);
				this.labelTimestampsById.set(targetId, entry.timestamp);
			} else {
				this.labelsById.delete(targetId);
				this.labelTimestampsById.delete(targetId);
			}
			return entry.id;
		});
	}

	/** Walk from entry to root, returning all entries in path order. */
	getBranch(fromId?: string): SessionEntry[] {
		const leafId = fromId ?? this.leafId;
		return leafId === this.leafId
			? this.historyIndex.branch(leafId, this.byId, this.branchLinks).slice()
			: getBranchPath(leafId, this.byId, this.branchLinks);
	}

	/** Return the active branch entries after applying the latest compaction boundary. */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId, this.activeBranch());
	}

	/** Project the current leaf and its compaction boundary. Transcript rows keep the content shown before model-only edits. */
	buildSessionProjection(purpose: "model" | "transcript" = "model", leafId = this.leafId): SessionProjection {
		let visible = false;
		const projection = buildSessionProjection(
			this.getEntries(),
			leafId,
			this.byId,
			this.sessionId,
			leafId === this.leafId ? this.activeBranch() : leafId === null ? undefined : this.getBranch(leafId),
			purpose,
			() => {
				visible = true;
			},
		);
		if (leafId === this.leafId) this.projectedEdits = { leafId, visible };
		return projection;
	}

	/** Whether an edit on the active branch changes a row still shown in its transcript. */
	hasContextEdits(): boolean {
		if (this.contextEdits === 0 || this.leafId === null) return false;
		if (this.projectedEdits?.leafId !== this.leafId) this.buildSessionProjection();
		return this.projectedEdits!.visible;
	}

	/** The active branch when the leaf is an entry of this session; undefined lets a stale leaf fall back as before. */
	private activeBranch(): readonly SessionEntry[] | undefined {
		return this.leafId !== null && this.byId.has(this.leafId)
			? this.historyIndex.branch(this.leafId, this.byId, this.branchLinks)
			: undefined;
	}

	/** Build the session context (what gets sent to the LLM). */
	buildSessionContext(): SessionContext {
		const { messages, thinkingLevel, model } = this.buildSessionProjection();
		return { messages, thinkingLevel, model };
	}

	/** @internal Starting or replacing a session installs a new header in slot zero, even for the same public ID. */
	[forkGeneration](): SessionHeader | undefined {
		const header = this.fileEntries[0];
		return header?.type === "session" ? header : undefined;
	}

	/** Get session header. */
	getHeader(): SessionHeader | null {
		const header = this.fileEntries.find((entry) => entry.type === "session");
		return header ? (header as SessionHeader) : null;
	}

	/** Number of entries without copying the session history. */
	getEntryCount(): number {
		return this.byId.size;
	}

	/** Get all session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return getEntriesWithoutHeader(this.fileEntries);
	}

	/** Get the session as a tree structure. Returns a shallow defensive copy of all entries. */
	getTree(): SessionTreeNode[] {
		return buildSessionTree(this.getEntries(), this.labelsById, this.labelTimestampsById);
	}

	/** @internal The raw branch may contain a sparse pre-window assistant needed for model state. It is not proof
	 * of an unedited answer. Consult only the complete window and the answer recovered for its exact prefix. */
	getLastBranchAnswer(): string | undefined {
		if (this.leafId === null) return undefined;
		return (
			lastBranchAnswer(this.getBranch(), (entry) => (this.entrySeqs.get(entry.id) ?? 0) >= this.answerWindowStart) ??
			this.priorAnswer
		)?.text;
	}

	private async prepareBranchTarget(id: string): Promise<SelectedWindow | undefined> {
		if (!this.hasFullHistory() && id !== this.leafId) {
			// Rewinding within the complete window does not need the archive. Keep caller-mutated entries
			// and permit a local move even if the backing store was deleted after this session opened.
			if (this.byId.has(id)) {
				const path = this.getBranch();
				const boundary = getLatestCompactionBoundaryEntry(path);
				const from = path.findIndex((entry) => entry.id === id);
				if (
					from >= 0 &&
					(!boundary || from >= path.indexOf(boundary)) &&
					!path.slice(from + 1).some((entry) => entry.type === "context_edit")
				)
					return undefined;
			}
			if (!this.store.readResume || !this.store.readRange) {
				const target = await (await import("./storage/session/snapshot-history.js")).snapshotWindow(
					this.store,
					this.sessionId,
					id,
					this.lastSeq,
					this.historyEpoch,
				);
				if (target.leafId !== id) throw new SessionEntryError(id, "missing");
				return target;
			}
			let resume: SessionResume;
			if (this.store.readResumeAt) resume = await this.store.readResumeAt(this.sessionId, id, this.lastSeq);
			else {
				resume = await this.store.readResume(this.sessionId, id);
				if (
					resume.lastSeq > this.lastSeq &&
					(this.historyEpoch === undefined || resume.epoch === this.historyEpoch)
				) {
					if (this.store.readEntrySizes && this.store.readEntryChunk) {
						const { pinnedBranchResume } = await import("./storage/session/pinned-branch-resume.js");
						resume = await pinnedBranchResume(
							this.store,
							this.recordHeader(),
							this.historyEpoch ?? resume.epoch,
							this.lastSeq,
							id,
						);
					} else {
						// A legacy custom store has neither a pinned index nor byte pages. Only this explicitly
						// requested local navigation may borrow its snapshot; it never becomes the manager's history.
						const snapshot = await this.store.load(this.sessionId);
						const knownEpoch =
							snapshot.epoch ??
							(await this.store.readRange!(this.sessionId, 1, 0)).epoch ??
							(await this.store.readResume(this.sessionId, id)).epoch;
						if (
							snapshot.lastSeq < this.lastSeq ||
							snapshot.entries[this.lastSeq - 1]?.id !== this.lastEntryId ||
							(this.historyEpoch !== undefined && knownEpoch !== this.historyEpoch)
						)
							throw new SessionConflictError(this.sessionId, this.lastSeq, snapshot.lastSeq);
						resume = {
							...sessionResumeOf(this.recordHeader(), snapshot.entries.slice(0, this.lastSeq), id),
							epoch: snapshot.epoch ?? resume.epoch,
						};
					}
				}
			}
			if (resume.lastSeq !== this.lastSeq || (this.historyEpoch !== undefined && resume.epoch !== this.historyEpoch))
				throw new SessionConflictError(this.sessionId, this.lastSeq, resume.lastSeq);
			if (resume.leafId !== id) throw new SessionEntryError(id, "missing");
			return withPriorAnswer(this.store, resume);
		}
		await this.requireEntry(id);
		return undefined;
	}

	/** Start a new branch from an earlier entry. */
	branch(branchFromId: string): Promise<void> {
		return this.runMutation(async () => {
			const target = await this.prepareBranchTarget(branchFromId);
			if (target) this.restoreOpened({ resume: target }, this.sessionFile);
			this.leafId = branchFromId;
		});
	}

	/** Reset the leaf pointer to null (before any entries). */
	resetLeaf(): Promise<void> {
		return this.runMutation(async () => {
			this.leafId = null;
		});
	}

	/**
	 * Move the leaf like `branch()`, or like `resetLeaf()` for `null`, and record the move, so the session reopens at the
	 * new leaf instead of its last entry. The record is a non-context entry under the new leaf; the tree omits it.
	 */
	recordBranch(branchFromId: string | null): Promise<void> {
		return this.runMutation(async () => {
			const target = branchFromId === null ? undefined : await this.prepareBranchTarget(branchFromId);
			await this._appendEntry(createCustomEntry(LEAF_MOVE_ENTRY_TYPE, undefined, this.byId, branchFromId), target);
			this.leafId = branchFromId;
		});
	}

	/** Start a new branch with a summary of the abandoned path. */
	branchWithSummary<T = SessionJsonValue>(
		branchFromId: string | null,
		summary: string,
		details?: T,
		fromHook?: boolean,
		usage?: import("@bastani/atomic-ai/compat").Usage,
		fromId?: string,
	): Promise<string> {
		return this.runMutation(async () => {
			const previous = fromId ?? this.leafId ?? "root";
			const target = branchFromId === null ? undefined : await this.prepareBranchTarget(branchFromId);
			const entry: BranchSummaryEntry = createBranchSummaryEntry(
				branchFromId,
				previous,
				summary,
				details,
				usage,
				fromHook,
				this.byId,
			);
			await this._appendEntry(entry, target);
			return entry.id;
		});
	}

	/**
	 * Switch to a new session holding the branch from the root to `leafId`. With `history: "tail"` it holds only what a
	 * resume of this session at `leafId` loads: the entries from the latest clear or compaction boundary on that branch
	 * through `leafId`, with the settings kept from before the boundary, so its context is the branch's context (#5500).
	 * A session opened at `leafId` with `history: "tail"` already holds exactly that, and nothing more is read.
	 */
	createBranchedSession(leafId: string, options?: { readonly history?: "tail" }): Promise<string | undefined> {
		return this.runMutation(async () => {
			if (options?.history !== undefined && options.history !== "tail")
				throw new TypeError(
					'Session history: "full" has been removed. Use sessionManager.readHistory() to iterate older entries.',
				);
			if (options?.history === "tail") {
				const receipts = new Map<string, OversizedSessionEntry>();
				return this.installFork(
					leafId,
					await this.forkWindow(await this.contextBranch(leafId), leafId, "branch", receipts),
					receipts,
				);
			}
			const leaf = await this.findEntrySeq(leafId);
			if (leaf === undefined) throw new SessionEntryError(leafId, "missing");
			const { humanForkStream } = await import("./storage/session/branch-fork-source.js");
			const seed = humanForkStream(
				this.sessionId,
				this.historyEpoch,
				this.lastSeq,
				leaf,
				leafId,
				this.labelsById,
				this.labelTimestampsById,
			);
			const workflow = classifiedWorkflowMetadata(this.getHeader());
			const record = this.recordHeader(
				createSessionHeader(
					createSessionId(),
					this.cwd,
					new Date().toISOString(),
					this.sessionId,
					workflow !== undefined,
					workflow,
				),
			);
			const store = await this.storeForNewSession();
			const location =
				store instanceof JsonlSessionStore
					? this.sessionDir
						? createSessionFilePath(this.sessionDir, record.createdAt, record.id)
						: store.locationFor(record)
					: undefined;
			await createForkArchive(
				store,
				record,
				seed,
				{ store: this.store, sessionId: this.sessionId, epoch: this.historyEpoch, receipts: new Map(), hashes: [] },
				location,
			);
			const opened = await readStoredSession(store, record.id, undefined);
			this.store = store;
			this.restoreOpened(opened, location);
			return this.sessionFile;
		});
	}

	private async installFork(
		leafId: string,
		path: SessionEntry[],
		receipts = new Map<string, OversizedSessionEntry>(),
	): Promise<string | undefined> {
		const result = createBranchedSessionState({
			leafId,
			cwd: this.cwd,
			parentSessionId: this.sessionId,
			workflow: classifiedWorkflowMetadata(this.getHeader()),
			path,
			labelsById: this.labelsById,
			labelTimestampsById: this.labelTimestampsById,
		});
		const header = result.fileEntries[0] as SessionHeader;
		const entries = getEntriesWithoutHeader(result.fileEntries);
		const record = this.recordHeader(header);
		const hashes = sessionBlobHashes(this.store, entries);
		const store = await this.storeForNewSession();
		const location =
			store instanceof JsonlSessionStore
				? this.sessionDir
					? createSessionFilePath(this.sessionDir, record.createdAt, record.id)
					: store.locationFor(record)
				: undefined;
		assertSessionBlobStore(store, record.id, hashes.length);
		await createForkArchive(
			store,
			record,
			entries,
			{ store: this.store, sessionId: this.sessionId, epoch: this.historyEpoch, hashes, receipts },
			location,
		);
		this.store = store;
		this.restoreOpened(await readStoredSession(store, record.id, undefined), location);
		return this.sessionFile;
	}

	/**
	 * The entries a fork of session `sessionId` at `entryId`, or at its leaf, copies (#5500): what a resume of the session
	 * at that entry loads, on the branch to it, as recorded and with their ids, linked into one branch. Labels set after
	 * that entry are not added. Only those entries are read when the store resumes from a saved index. Undefined when the
	 * session has no such entry.
	 */
	static async readForkedBranch(
		store: SessionStore,
		sessionId: string,
		point?: string | { readonly checkpoint: true },
	): Promise<SessionEntry[] | undefined> {
		const entryId = typeof point === "string" ? point : undefined;
		const source = await SessionManager.open(store, sessionId, undefined, {
			history: "tail",
			...(entryId === undefined ? {} : { leafId: entryId }),
		});
		const leafId = entryId ?? source.getLeafId();
		if (leafId === null || source.getEntry(leafId) === undefined) return undefined;
		return source.forkWindow(await source.contextBranch(leafId), leafId, point === undefined ? "session" : "branch");
	}

	/** Keep a launch point, not the live parent or a list of the entries that happen to be resident now. */
	captureFork(leafId: string): () => Promise<SessionManager> {
		return SessionManager.capturedFork(
			this.store,
			this.sessionId,
			this.cwd,
			this.sessionDir,
			this.historyEpoch,
			this.lastSeq,
			leafId,
		);
	}

	/** Open a child at the committed fork point supplied by an SDK caller. */
	static forkContext(store: SessionStore, sessionId: string, leafId: string, cwd: string): Promise<SessionManager> {
		return SessionManager.capturedFork(store, sessionId, cwd, "", undefined, undefined, leafId)();
	}

	private static capturedFork(
		store: SessionStore,
		sessionId: string,
		cwd: string,
		sessionDir: string,
		epoch: string | undefined,
		watermark: number | undefined,
		leafId: string,
	): () => Promise<SessionManager> {
		return async () => {
			const bounded = store.readForkWindow;
			const window = bounded
				? await bounded.call(store, sessionId, leafId, { archivedReceipts: true })
				: (await import("./storage/session/fork-window.js")).fullForkWindow(await store.load(sessionId), leafId);
			if (!window || !leafId) throw new SessionEntryError(leafId, "missing");
			if (window.header.id !== sessionId) throw new SessionIdMismatchError(sessionId, window.header.id);
			if (
				(epoch !== undefined && window.epoch !== undefined && window.epoch !== epoch) ||
				(watermark !== undefined && window.lastSeq < watermark)
			)
				throw new SessionConflictError(sessionId, watermark ?? 0, window.lastSeq);
			const source = new SessionManager(store, cwd, sessionDir);
			source.restore({ header: window.header, entries: [], epoch: window.epoch, lastSeq: window.lastSeq });
			const labels = buildSessionIndex(window.labels);
			source.labelsById = labels.labelsById;
			source.labelTimestampsById = labels.labelTimestampsById;
			const receipts = new Map<string, OversizedSessionEntry>();
			const entries = bounded
				? await includeNamedForkOutputs(
						forkContextPath(window.entries, sessionId),
						store,
						sessionId,
						leafId,
						window.epoch,
						watermark ?? window.lastSeq,
						"branch",
						receipts,
					)
				: window.entries;
			await source.installFork(leafId, entries, receipts);
			return source;
		};
	}

	private forkWindow(
		path: SessionEntry[],
		leafId: string | null,
		scope: "branch" | "session" = "branch",
		receipts?: Map<string, OversizedSessionEntry>,
	): Promise<SessionEntry[]> {
		return includeNamedForkOutputs(
			forkContextPath(path, this.sessionId),
			this.store,
			this.sessionId,
			leafId,
			this.historyEpoch,
			this.lastSeq,
			scope,
			receipts,
		);
	}

	/** Resolve the selected stored branch even when an earlier clear has retired its first kept span. */
	private async contextBranch(leafId: string): Promise<SessionEntry[]> {
		const { resume } = await readStoredSession(this.store, this.sessionId, { leafId });
		if (this.historyEpoch !== undefined && resume.epoch !== this.historyEpoch)
			throw new SessionConflictError(this.sessionId, this.lastSeq, resume.lastSeq);
		if (resume.leafId !== leafId) throw new SessionEntryError(leafId, "missing");
		return [...resume.state.filter((held) => held.onBranch), ...resume.branch]
			.sort((left, right) => left.seq - right.seq)
			.map((held) => held.entry);
	}

	private markForkOrigin(source: SessionStore): void {
		if (
			source === this.store ||
			(source instanceof JsonlSessionStore &&
				this.store instanceof JsonlSessionStore &&
				pathsEqual(source.descriptor.location, this.store.descriptor.location))
		)
			return;
		this.fileEntries[0] = { ...this.getHeader()!, parentInOtherStore: true };
	}

	async forkTo(cwd: string, sessionDir?: string | SessionStore, options?: NewSessionOptions): Promise<SessionManager> {
		const store =
			typeof sessionDir === "string"
				? await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false })
				: (sessionDir ?? (await resolveSessionStore(cwd)));
		const directory = store instanceof JsonlSessionStore ? store.descriptor.location : "";
		return SessionManager.constructWithStore(store, store !== sessionDir, async () => {
			const receipts = new Map<string, OversizedSessionEntry>();
			const source = {
				store: this.store,
				sessionId: this.sessionId,
				epoch: this.historyEpoch,
				entries: await this.forkWindow(this.getBranch(), this.getLeafId(), "session", receipts),
			};
			const manager = new SessionManager(store, cwd, directory, { ...options, parentSession: source.sessionId });
			manager.markForkOrigin(source.store);
			const hashes = sessionBlobHashes(source.store, source.entries);
			assertSessionBlobStore(store, manager.sessionId, hashes.length);
			await createForkArchive(
				store,
				manager.recordHeader(),
				source.entries,
				{ store: source.store, sessionId: source.sessionId, epoch: source.epoch, hashes, receipts },
				manager.sessionFile,
			);
			manager.restoreOpened(await readStoredSession(store, manager.sessionId, undefined), manager.sessionFile);
			return manager;
		});
	}

	static async importFromJsonl(
		inputPath: string,
		cwd: string,
		sessionDir?: string | SessionStore,
	): Promise<SessionManager> {
		const store =
			typeof sessionDir === "string"
				? await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false })
				: (sessionDir ?? (await resolveSessionStore(cwd)));
		return SessionManager.constructWithStore(store, store !== sessionDir, () =>
			new SessionManager(
				store,
				cwd,
				store instanceof JsonlSessionStore ? store.descriptor.location : "",
			).importFromJsonl(inputPath),
		);
	}
	private static async constructWithStore(
		store: SessionStore,
		owned: boolean,
		construct: () => Promise<SessionManager>,
	): Promise<SessionManager> {
		try {
			return await construct();
		} catch (error) {
			if (owned) {
				try {
					await store.close();
				} catch (cause) {
					throw new StorageRollbackError(error as StorageFailureCause, cause as StorageFailureCause);
				}
			}
			throw error;
		}
	}

	static async create(cwd: string, sessionDir?: string, options?: NewSessionOptions): Promise<SessionManager>;
	static async create(store: SessionStore, cwd: string, options?: NewSessionOptions): Promise<SessionManager>;
	static async create(
		cwdOrStore: string | SessionStore,
		directoryOrCwd?: string,
		options?: NewSessionOptions,
	): Promise<SessionManager> {
		const cwd = typeof cwdOrStore === "string" ? cwdOrStore : (directoryOrCwd ?? process.cwd());
		if (typeof cwdOrStore === "string" && directoryOrCwd === undefined) {
			const store = await resolveSessionStore(cwd);
			return SessionManager.constructWithStore(store, true, () => SessionManager.create(store, cwd, options));
		}
		const directory =
			typeof cwdOrStore === "string"
				? directoryOrCwd
					? normalizePath(directoryOrCwd)
					: getDefaultSessionDirPath(cwd)
				: cwdOrStore instanceof JsonlSessionStore
					? cwdOrStore.descriptor.location
					: "";
		const store =
			typeof cwdOrStore === "string"
				? await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false })
				: cwdOrStore;
		return SessionManager.constructWithStore(store, store !== cwdOrStore, async () => {
			const manager = new SessionManager(store, cwd, directory, options);
			if (typeof cwdOrStore !== "string" && store instanceof JsonlSessionStore) {
				manager.sessionFile = store.locationFor(manager.recordHeader());
				manager.sessionDir = dirname(manager.sessionFile);
			}
			await manager.initialize();
			return manager;
		});
	}

	static async open(
		path: string,
		sessionDir?: string,
		cwdOverride?: string,
		options?: SessionOpenOptions,
	): Promise<SessionManager>;
	static async open(
		store: SessionStore,
		sessionId: string,
		cwdOverride?: string,
		options?: SessionOpenOptions,
	): Promise<SessionManager>;
	static async open(
		pathOrStore: string | SessionStore,
		directoryOrId?: string,
		cwdOverride?: string,
		options?: SessionOpenOptions,
	): Promise<SessionManager> {
		if (typeof pathOrStore !== "string") {
			const opened = await readStoredSession(pathOrStore, directoryOrId!, options);
			const header = openedHeader(opened);
			if (header.id !== directoryOrId) throw new SessionIdMismatchError(directoryOrId!, header.id);
			const manager = new SessionManager(
				pathOrStore,
				cwdOverride ?? header.cwd,
				pathOrStore instanceof JsonlSessionStore ? pathOrStore.descriptor.location : "",
			);
			manager.restoreOpened(
				opened,
				pathOrStore instanceof JsonlSessionStore ? await pathOrStore.findFile(directoryOrId!) : undefined,
			);
			if (manager.sessionFile) manager.sessionDir = dirname(manager.sessionFile);
			return manager;
		}
		const path = resolvePath(pathOrStore);
		const directory = directoryOrId ?? dirname(path);
		const { store, opened } = await openSessionFileWindow(path, cwdOverride, options);
		const manager = new SessionManager(store, cwdOverride ?? openedHeader(opened).cwd, directory);
		manager.restoreOpened(opened, path);
		return manager;
	}

	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		options?: { includeInternal?: boolean } & SessionOpenOptions,
	): Promise<SessionManager>;
	static async continueRecent(
		store: SessionStore,
		cwd: string,
		options?: { includeInternal?: boolean } & SessionOpenOptions,
	): Promise<SessionManager>;
	static async continueRecent(
		cwdOrStore: string | SessionStore,
		directoryOrCwd?: string,
		options?: { includeInternal?: boolean } & SessionOpenOptions,
	): Promise<SessionManager> {
		const cwd = typeof cwdOrStore === "string" ? cwdOrStore : directoryOrCwd!;
		if (typeof cwdOrStore === "string" && directoryOrCwd === undefined) {
			const store = await resolveSessionStore(cwd);
			return SessionManager.constructWithStore(store, true, () =>
				SessionManager.continueRecent(store, cwd, options),
			);
		}
		const directory = typeof cwdOrStore === "string" ? (directoryOrCwd ?? getDefaultSessionDirPath(cwd)) : "";
		const store =
			typeof cwdOrStore === "string"
				? await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false })
				: cwdOrStore;
		return SessionManager.constructWithStore(store, store !== cwdOrStore, async () => {
			const recent = await store.findMostRecent({
				cwd: resolvePath(cwd),
				includeInternal: options?.includeInternal,
			});
			const manager = new SessionManager(store, cwd, directory);
			if (recent) manager.restoreOpened(await readStoredSession(store, recent.id, options), recent.location);
			else await manager.initialize();
			return manager;
		});
	}

	async inMemoryBranch(cwd: string): Promise<SessionManager> {
		const header = this.getHeader();
		if (!header) throw new Error("Session header is missing");
		const links = this.branchLinks;
		const path = this.getBranch().map((entry) => {
			const parent = links?.get(entry.id);
			return parent && !this.byId.has(entry.parentId ?? "") ? { ...entry, parentId: parent } : entry;
		});
		return SessionManager.inMemory(cwd, undefined, [header, ...path]);
	}

	static inMemory(cwd?: string, options?: NewSessionOptions): SessionManager;
	static inMemory(
		cwd: string,
		options: NewSessionOptions | undefined,
		entries: readonly FileEntry[],
	): Promise<SessionManager>;
	static inMemory(
		cwd: string = process.cwd(),
		options?: NewSessionOptions,
		entries?: readonly FileEntry[],
	): SessionManager | Promise<SessionManager> {
		const manager = new SessionManager(
			markPrivateMemorySessionStore(new MemorySessionStore(createSessionCwdMatcherAsync)),
			cwd,
			"",
			options,
		);
		if (entries !== undefined) return manager.seedPrivateSession(entries);
		manager.mutation = manager.initialize();
		return manager;
	}

	private async seedPrivateSession(entries: readonly FileEntry[]): Promise<SessionManager> {
		const start = entries[0]?.type === "session" ? 1 : 0;
		const header = start ? validateSessionFileEntries([entries[0]!], "in-memory session") : this.getHeader()!;
		const record = this.recordHeader(header);
		const created = await this.store.create(record, []);
		let seq = 0;
		for (let i = start; i < entries.length; i += SESSION_HISTORY_PAGE_ENTRIES) {
			if (i > start) await yieldToEventLoop();
			const page = entries.slice(i, i + SESSION_HISTORY_PAGE_ENTRIES) as SessionEntry[];
			validateSessionEntryStructure(page, "in-memory session");
			seq = (await this.store.append(record.id, page, { expectSeq: seq, epoch: created.epoch })).lastSeq;
		}
		this.restoreOpened(await readStoredSession(this.store, record.id, undefined));
		return this;
	}

	static async forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string | SessionStore,
		options?: NewSessionOptions,
	): Promise<SessionManager> {
		const sourceStore = await JsonlSessionStore.open(dirname(resolvePath(sourcePath)), {
			exactDirectory: true,
			scanExisting: false,
		});
		let source: { id: string; entries: SessionEntry[] };
		try {
			source = await sourceStore[withForkFileWindow](resolvePath(sourcePath), async (window, history) => {
				const selected = [...window.state.filter(({ onBranch }) => onBranch), ...window.branch]
					.sort((a, b) => a.seq - b.seq)
					.map(({ entry }) => entry);
				const id = window.header.id;
				const entries = await includeNamedForkOutputs(
					forkContextPath(selected, id),
					history,
					id,
					window.leafId,
					window.epoch,
					window.lastSeq,
					"session",
				);
				return { id, entries };
			});
		} finally {
			await sourceStore.close();
		}
		const { entries, blobs } = takeInlineToolOutput(source.entries, source.id);
		const store =
			typeof sessionDir === "string"
				? await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false })
				: (sessionDir ?? (await resolveSessionStore(targetCwd)));
		const directory =
			typeof sessionDir === "string"
				? sessionDir
				: sessionDir instanceof JsonlSessionStore
					? sessionDir.descriptor.location
					: "";
		return SessionManager.constructWithStore(store, store !== sessionDir, async () => {
			const manager = new SessionManager(store, targetCwd, directory, {
				...options,
				parentSession: source.id,
			});
			manager.markForkOrigin(sourceStore);
			assertSessionBlobStore(store, manager.sessionId, blobs.length);
			manager.fileEntries.push(...entries);
			await manager.initialize();
			await storeSessionBlobs(store, manager.sessionId, blobs);
			manager._buildIndex();
			return manager;
		});
	}

	static async findById(cwd: string, id: string, sessionDir?: string): Promise<string | undefined> {
		const store =
			sessionDir === undefined
				? await resolveSessionStore(cwd)
				: await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false });
		try {
			const header = await store.readHeader(id);
			if (
				!header ||
				classifiedWorkflowMetadata(header) ||
				!(await createSessionCwdMatcherAsync(resolvePath(cwd))(resolvePath(header.cwd)))
			)
				return undefined;
			return store instanceof JsonlSessionStore ? await store.findFile(id) : id;
		} catch (error) {
			if (error instanceof SessionFormatVersionError) return undefined;
			throw error;
		} finally {
			await store.close();
		}
	}

	static async list(
		cwd: string,
		sessionDir?: string | SessionStore,
		onProgress?: SessionListProgress,
		options?: { includeInternal?: boolean; signal?: AbortSignal } | AbortSignal,
	): Promise<SessionInfo[]> {
		const signal = options && "aborted" in options ? options : options?.signal;
		if (typeof sessionDir !== "string") {
			const store = sessionDir ?? (await resolveSessionStore(cwd));
			try {
				return await listSessionStore(
					store,
					{
						cwd: resolvePath(cwd),
						signal,
						includeInternal:
							options !== undefined && "includeInternal" in options && options.includeInternal === true,
					},
					onProgress,
				);
			} finally {
				if (sessionDir === undefined) await store.close();
			}
		}
		return listProjectSessions(
			cwd,
			sessionDir,
			onProgress,
			options !== undefined && "includeInternal" in options && options.includeInternal === true,
			signal,
		);
	}

	static async listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string | SessionStore,
		onProgress?: SessionListProgress,
		options?: { includeInternal?: boolean; signal?: AbortSignal } | AbortSignal,
	): Promise<SessionInfo[]>;
	static async listAll(
		directoryOrProgress?: string | SessionStore | SessionListProgress,
		progressOrSignal?: SessionListProgress | AbortSignal,
		options?: { includeInternal?: boolean; signal?: AbortSignal } | AbortSignal,
	): Promise<SessionInfo[]> {
		if (typeof directoryOrProgress !== "string") {
			const supplied = typeof directoryOrProgress === "object" ? directoryOrProgress : undefined;
			const store = supplied ?? (await resolveSessionStore(process.cwd()));
			try {
				return await listSessionStore(
					store,
					{
						includeInternal:
							options !== undefined && "includeInternal" in options && options.includeInternal === true,
						signal:
							options && "aborted" in options
								? options
								: (options?.signal ?? (typeof progressOrSignal === "object" ? progressOrSignal : undefined)),
					},
					typeof directoryOrProgress === "function"
						? directoryOrProgress
						: typeof progressOrSignal === "function"
							? progressOrSignal
							: undefined,
				);
			} finally {
				if (!supplied) await store.close();
			}
		}
		const { listAllSessions } = await import("./session-manager-list.ts");
		return listAllSessions(
			directoryOrProgress,
			typeof progressOrSignal === "function" ? progressOrSignal : undefined,
			options !== undefined && "includeInternal" in options && options.includeInternal === true,
			options && "aborted" in options
				? options
				: (options?.signal ?? (typeof progressOrSignal === "object" ? progressOrSignal : undefined)),
		);
	}
}
