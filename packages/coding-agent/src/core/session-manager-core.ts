import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isProxy } from "node:util/types";
import { getCurrentSystemMessage } from "@bastani/atomic-ai";
import type { ImageContent, Message, TextContent, Usage } from "@bastani/atomic-ai/compat";
import { getAgentDir } from "../config.js";
import { createSessionCwdMatcherAsync, normalizePath, pathsEqual, resolvePath } from "../utils/paths.ts";
import type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
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
import {
	SessionConflictError,
	SessionFormatVersionError,
	SessionIdMismatchError,
	type SessionJsonValue,
	SessionNotFoundError,
	StorageUnavailableError,
} from "./storage/session/errors.js";
import { JsonlSessionStore } from "./storage/session/jsonl-session-store.js";
import { MemorySessionStore, markPrivateMemorySessionStore } from "./storage/session/memory-session-store.js";
import { readSessionRange } from "./storage/session/session-resume.js";
import type {
	SessionBlob,
	SessionHistoryTotals,
	SessionRecordHeader,
	SessionRecoveryState,
	SessionResume,
	SessionSnapshot,
	SessionStore,
} from "./storage/session/types.js";
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

type OpenedSession = { readonly snapshot: SessionSnapshot } | { readonly resume: SessionResume };
async function readStoredSession(
	store: SessionStore,
	sessionId: string,
	options: SessionOpenOptions | undefined,
): Promise<OpenedSession> {
	if (options?.history === "tail" && store.readResume) return { resume: await store.readResume(sessionId) };
	return { snapshot: await store.load(sessionId) };
}

function openedHeader(opened: OpenedSession): SessionRecordHeader {
	return "snapshot" in opened ? opened.snapshot.header : opened.resume.header;
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
	private readonly historyIndex = new SessionHistoryIndex();

	private historyStartSeq = 1;

	private entrySeqs = new Map<string, number>();
	private historyEpoch: string | undefined;
	private lastEntryId: string | null = null;
	private compactionSeq = 0;
	private recoveryState: SessionRecoveryState = { admissionKeys: [], intercomDeliveredIds: [] };

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
		if ("snapshot" in opened) {
			this.restore(opened.snapshot, location);
			return;
		}
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
		this.lastEntryId = resume.lastEntryId;
		this.compactionSeq = resume.compaction?.seq ?? 0;
		this.recoveryState = resume.recovery;
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
		this.entrySeqs = new Map(entries.map((entry, i) => [entry.id, i + 1]));
		this.lastEntryId = entries.at(-1)?.id ?? null;
		this.historyEpoch = undefined;
		this.compactionSeq = 0;
		this.recoveryState = { admissionKeys: [], intercomDeliveredIds: [] };
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
		if (this.historyStartSeq <= 1) return Promise.resolve();
		this.historyLoad ??= this.readHistory().finally(() => {
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
			const range = await readSessionRange(store, sessionId, start, end);
			if (historyEpoch !== undefined && range.epoch !== historyEpoch)
				throw new SessionConflictError(sessionId, watermark, range.lastSeq);
			for (const [i, read] of range.entries.entries()) visit(read, range.seqs?.[i] ?? start + i, false);
			start = end + 1;
		}
		return watermark;
	}

	private async readHistory(): Promise<void> {
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
		const range = await readSessionRange(store, sessionId, Math.max(1, lastSeq), Number.MAX_SAFE_INTEGER);
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
	getSessionRecoveryState(): SessionRecoveryState {
		return this.recoveryState;
	}
	async findEntrySeq(id: string): Promise<number | undefined> {
		const held = this.entrySeqs.get(id);
		if (held !== undefined) return held;
		if (this.store.findEntrySeq) return this.store.findEntrySeq(this.sessionId, id);
		await this.loadFullHistory();
		return this.entrySeqs.get(id);
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
			const opened = await SessionManager.open(sessionFile, this.sessionDir, this.cwd);
			this.store = opened.store;
			this.restore(
				{
					header: opened.recordHeader(),
					entries: opened.getEntries(),
					lastSeq: opened.lastSeq,
					epoch: opened.historyEpoch,
				},
				opened.sessionFile,
			);
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
			await this.loadFullHistory();
			const header: SessionHeader = { ...previous, internal: true, workflow: validWorkflow };
			const result = await this.store.replace(this.sessionId, this.recordHeader(header), this.getEntries(), {
				expectSeq: this.lastSeq,
				...(this.historyEpoch === undefined ? {} : { epoch: this.historyEpoch }),
			});
			this.lastSeq = result.lastSeq;
			this.historyEpoch = result.epoch;
			this.fileEntries[0] = header;
		});
	}

	private _buildIndex(): void {
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

	/** @internal Finalize provisional startup storage after project trust resolves. */
	rebindStore(store: SessionStore, removeProvisionalRecord: boolean): Promise<void> {
		return this.runMutation(async () => {
			if (store === this.store) return;
			await this.loadFullHistory();
			const header = this.recordHeader();
			const entries = this.getEntries();
			const hashes = sessionBlobHashes(this.store, entries);
			assertSessionBlobStore(store, this.sessionId, hashes.length);
			const result = await store.create(header, entries);
			await copySessionBlobs(this.store, this.sessionId, store, this.sessionId, hashes);
			if (removeProvisionalRecord) await this.store.delete(this.sessionId);
			this.store = store;
			this.sessionDir = store instanceof JsonlSessionStore ? store.descriptor.location : "";
			this.restore({ header, entries, lastSeq: result.lastSeq, epoch: result.epoch });
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
			store = await JsonlSessionStore.open(dirname(location), { exactDirectory: true, scanExisting: false });
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

	private _appendEntry(entry: SessionEntry): Promise<void> {
		return this._appendEntries([entry]);
	}

	private async _appendEntries(entries: readonly SessionEntry[]): Promise<void> {
		if (this.appendHalt !== undefined) throw this.appendHalt;
		// #4971: the session was deleted from its store; that was reported once, and nothing more is saved.
		if (this.deletedFromStore) return this.applyAppended(entries);
		for (let attempt = 1; ; attempt++) {
			const expectSeq = this.lastSeq;
			try {
				this.lastSeq = (
					await this.store.append(this.sessionId, entries, {
						expectSeq,
						...(this.historyEpoch === undefined ? {} : { epoch: this.historyEpoch }),
					})
				).lastSeq;
			} catch (error) {
				if (error instanceof SessionNotFoundError) {
					this.deletedFromStore = true;
					throw new SessionDeletedError(this.sessionId, { cause: error });
				}
				if (appendFailureWroteNothing(error) || attempt > MAX_APPEND_RECONCILES) throw error;
				const unknown = isStorageTransientError(error) && error.outcome === "unknown";
				if (await this.reconcileAppend(entries, error, unknown, expectSeq)) return;
				continue;
			}
			this.applyAppended(entries);
			return;
		}
	}

	private applyAppended(entries: readonly SessionEntry[]): void {
		for (const [position, entry] of entries.entries()) {
			this.entrySeqs.set(entry.id, this.lastSeq - entries.length + position + 1);
			this.lastEntryId = entry.id;
			this.fileEntries.push(entry);
			this.byId.set(entry.id, entry);
			if (entry.type === "context_edit") this.contextEdits++;
			else if (entry.type !== "compaction" && this.projectedEdits?.leafId === entry.parentId)
				this.projectedEdits.leafId = entry.id;
			this.historyIndex.appended(entry, this.byId);
			this.leafId = entry.id;
		}
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
	): Promise<boolean> {
		// Entries of an append that failed for certain are never in the store, so marking them too changes nothing.
		for (const entry of entries) this.unconfirmed.add(entry.id);
		let read: { readonly entries: readonly SessionEntry[]; readonly lastSeq: number };
		try {
			read = await readSessionRange(this.store, this.sessionId, Math.max(1, this.lastSeq), Number.MAX_SAFE_INTEGER);
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
		const leafId = saved ? entries.at(-1)!.id : this.leafId;
		for (const [i, entry] of tail.entries()) this.entrySeqs.set(entry.id, this.lastSeq + i + 1);
		this.lastEntryId = tail.at(-1)?.id ?? this.lastEntryId;
		this.fileEntries = [...this.fileEntries, ...tail];
		this._buildIndex();
		this.leafId = leafId;
		this.lastSeq = read.lastSeq;
		if (saved) return true;
		const conflict = error instanceof SessionConflictError;
		if (foreign || (conflict && tail.length === 0)) {
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
			if (firstKeptEntryId !== null) await this.requireEntry(firstKeptEntryId);
			if (coveredThroughEntryId !== undefined) await this.requireEntry(coveredThroughEntryId);
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
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	/** Save a JSONL backup; database-backed sessions have no file snapshot. */
	writeBackupSnapshot(label = "compact"): Promise<string | undefined> {
		return this.runMutation(async () => {
			if (!(this.store instanceof JsonlSessionStore) || !this.sessionFile) return undefined;
			await this.loadFullHistory();
			const path = `${this.sessionFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.${label.replace(/[^a-z0-9_-]/gi, "-") || "backup"}.bak`;
			try {
				await writeFile(
					path,
					`${[JSON.stringify({ type: "session", ...this.recordHeader() }), ...this.getEntries().map((entry) => JSON.stringify(entry))].join("\n")}\n`,
				);
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
			const target = await this.requireEntry(targetId);
			if (!this.getBranch().some((entry) => entry.id === targetId)) {
				throw new SessionEntryError(targetId, "inactive");
			}
			const editable =
				target.type === "custom_message" ||
				(target.type === "message" &&
					(target.message.role === "user" ||
						target.message.role === "assistant" ||
						target.message.role === "toolResult"));
			if (!editable) throw new SessionEntryError(targetId, "not-editable");
			const targetRole = target.type === "message" ? target.message.role : "custom";
			const normalizedReplacement =
				replacement !== null &&
				(targetRole === "assistant" || targetRole === "toolResult") &&
				typeof replacement.content === "string"
					? { content: [{ type: "text" as const, text: replacement.content }] }
					: replacement;
			const entry = createContextEditEntry(targetId, normalizedReplacement, this.byId, this.leafId);
			await this._appendEntry(entry);
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
			await this.requireEntry(summarizedThroughId);
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

	private async requireEntry(id: string): Promise<SessionEntry> {
		if (!this.byId.has(id)) await this.loadFullHistory();
		const entry = this.byId.get(id);
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

	/** Set or clear a label on an entry. */
	appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
		return this.runMutation(async () => {
			await this.requireEntry(targetId);
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

	private async requireBranchTarget(id: string): Promise<void> {
		const seq = this.entrySeqs.get(id);
		if (
			!this.hasFullHistory() &&
			(seq === undefined || seq < this.compactionSeq || !this.getBranch().some((entry) => entry.id === id))
		)
			await this.loadFullHistory();
		await this.requireEntry(id);
	}

	/** Start a new branch from an earlier entry. */
	branch(branchFromId: string): Promise<void> {
		return this.runMutation(async () => {
			await this.requireBranchTarget(branchFromId);
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
			if (branchFromId !== null) await this.requireBranchTarget(branchFromId);
			await this._appendEntry(createCustomEntry(LEAF_MOVE_ENTRY_TYPE, undefined, this.byId, branchFromId));
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
			if (branchFromId !== null) await this.requireBranchTarget(branchFromId);
			const entry: BranchSummaryEntry = createBranchSummaryEntry(
				branchFromId,
				fromId ?? this.leafId ?? "root",
				summary,
				details,
				usage,
				fromHook,
				this.byId,
			);
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	createBranchedSession(leafId: string): Promise<string | undefined> {
		return this.runMutation(async () => {
			await this.loadFullHistory();
			const result = createBranchedSessionState({
				leafId,
				cwd: this.cwd,
				parentSessionId: this.sessionId,
				workflow: classifiedWorkflowMetadata(this.getHeader()),
				path: this.getBranch(leafId),
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
			const created = await (store instanceof JsonlSessionStore
				? store.create(record, entries, location)
				: store.create(record, entries));
			await copySessionBlobs(this.store, this.sessionId, store, record.id, hashes);
			this.store = store;
			this.restore({ header: record, entries, lastSeq: created.lastSeq, epoch: created.epoch }, location);
			return this.sessionFile;
		});
	}

	async forkTo(cwd: string, sessionDir?: string | SessionStore, options?: NewSessionOptions): Promise<SessionManager> {
		const store =
			typeof sessionDir === "string"
				? await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false })
				: (sessionDir ?? (await resolveSessionStore(cwd)));
		const directory = store instanceof JsonlSessionStore ? store.descriptor.location : "";
		return SessionManager.constructWithStore(store, store !== sessionDir, async () => {
			await this.loadFullHistory();
			const source = { store: this.store, sessionId: this.sessionId, entries: this.getEntries() };
			const manager = new SessionManager(store, cwd, directory, { ...options, parentSession: source.sessionId });
			const hashes = sessionBlobHashes(source.store, source.entries);
			assertSessionBlobStore(store, manager.sessionId, hashes.length);
			manager.fileEntries.push(...source.entries);
			await manager.initialize();
			await copySessionBlobs(source.store, source.sessionId, store, manager.sessionId, hashes);
			manager._buildIndex();
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
		const store = await JsonlSessionStore.open(dirname(path), { exactDirectory: true, scanExisting: false });
		let opened: OpenedSession;
		try {
			opened =
				options?.history === "tail"
					? await readStoredSession(store, (await store.readHeaderFile(path)).id, options)
					: { snapshot: await store.loadFile(path) };
		} catch (error) {
			if (!(error instanceof StorageUnavailableError) || (error.cause as NodeJS.ErrnoException).code !== "ENOENT")
				throw error;
			const manager = new SessionManager(store, cwdOverride ?? process.cwd(), directory);
			manager.lastSeq = (await store.create(manager.recordHeader(), [], path)).lastSeq;
			manager.sessionFile = path;
			return manager;
		}
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

	inMemoryBranch(cwd: string): SessionManager {
		const header = this.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(cwd, undefined, [header, ...this.getBranch()]);
		manager.branchLinks = this.branchLinks;
		return manager;
	}

	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		const manager = new SessionManager(
			markPrivateMemorySessionStore(new MemorySessionStore(createSessionCwdMatcherAsync)),
			cwd,
			"",
			options,
		);
		if (entries?.length) {
			manager.fileEntries = entries[0].type === "session" ? entries : [...manager.fileEntries, ...entries];
			manager.sessionId = manager.getHeader()!.id;
			manager._buildIndex();
		}
		manager.mutation = manager.initialize();
		return manager;
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
		let source: SessionSnapshot;
		try {
			source = await sourceStore.loadFile(resolvePath(sourcePath));
		} finally {
			await sourceStore.close();
		}
		const { entries, blobs } = takeInlineToolOutput(source.entries, source.header.id);
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
				parentSession: source.header.id,
			});
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
