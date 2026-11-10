import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCurrentSystemMessage } from "@bastani/pi-ai";
import type { ImageContent, Message, TextContent, Usage } from "@bastani/pi-ai/compat";
import { getAgentDir } from "../config.js";
import { createSessionCwdMatcher, normalizePath, pathsEqual, resolvePath } from "../utils/paths.ts";
import type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
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
	getLatestSessionName,
} from "./session-manager-entries.ts";
import { SessionEntryError } from "./session-manager-errors.js";
import {
	buildContextEntries,
	buildSessionIndex,
	buildSessionProjection,
	buildSessionTree,
	getBranchPath,
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
import { adoptInlineSnapshotBlobs } from "./session-worktree-snapshots.ts";
import { SessionBlobError, type StorageFailureCause, StorageRollbackError } from "./storage/errors.js";
import {
	SessionFormatVersionError,
	SessionIdMismatchError,
	type SessionJsonValue,
	SessionNotFoundError,
	StorageUnavailableError,
} from "./storage/session/errors.js";
import { JsonlSessionStore } from "./storage/session/jsonl-session-store.js";
import { MemorySessionStore, markPrivateMemorySessionStore } from "./storage/session/memory-session-store.js";
import type { SessionBlob, SessionRecordHeader, SessionSnapshot, SessionStore } from "./storage/session/types.js";
import { WorkspaceConfigError } from "./worktree-snapshot/errors.ts";
import type { WorktreeRootMapping, WorktreeSnapshot } from "./worktree-snapshot/types.ts";

async function resolveSessionStore(cwd: string): Promise<SessionStore> {
	// Selection loads settings and tools, which depend on the completed session module.
	return (await import("./session-storage.js")).resolveSessionStore(cwd);
}

/** An in-memory session tree whose mutations await the backing store. */
export class SessionManager {
	private sessionId = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private store: SessionStore;
	private lastSeq = 0;
	private mutation: Promise<void> = Promise.resolve();
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;

	private constructor(store: SessionStore, cwd: string, sessionDir: string, options?: NewSessionOptions) {
		this.store = store;
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.start(options);
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
		const header = snapshot.header;
		this.fileEntries = [{ type: "session", ...header }, ...snapshot.entries];
		this.sessionId = header.id;
		this.lastSeq = snapshot.lastSeq;
		this.sessionFile =
			location ?? (this.store instanceof JsonlSessionStore ? this.store.locationFor(header) : undefined);
		this._buildIndex();
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
				{ header: opened.recordHeader(), entries: opened.getEntries(), lastSeq: opened.lastSeq },
				opened.sessionFile,
			);
		});
	}

	private async initialize(): Promise<void> {
		this.lastSeq = (
			await (this.store instanceof JsonlSessionStore
				? this.store.create(this.recordHeader(), this.getEntries(), this.sessionFile)
				: this.store.create(this.recordHeader(), this.getEntries()))
		).lastSeq;
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
			this.restore({ header: record, entries: [], lastSeq: result.lastSeq }, location);
			return this.sessionFile;
		});
	}

	markSessionInternal(workflow?: SessionWorkflowMetadata): Promise<void> {
		return this.runMutation(async () => {
			const previous = this.getHeader()!;
			if (classifiedWorkflowMetadata(previous)) return;
			const validWorkflow = validSessionWorkflowMetadata(workflow);
			if (!validWorkflow) return;
			const header: SessionHeader = { ...previous, internal: true, workflow: validWorkflow };
			const result = await this.store.replace(this.sessionId, this.recordHeader(header), this.getEntries(), {
				expectSeq: this.lastSeq,
			});
			this.lastSeq = result.lastSeq;
			this.fileEntries[0] = header;
		});
	}

	private _buildIndex(): void {
		validateSessionFileEntries(this.fileEntries, this.sessionFile ?? "in-memory session");
		const index = buildSessionIndex(this.fileEntries);
		this.byId = index.byId;
		this.labelsById = index.labelsById;
		this.labelTimestampsById = index.labelTimestampsById;
		this.leafId = index.leafId;
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
		try {
			await this.store.delete(sessionId);
		} catch (error) {
			if (!(error instanceof SessionNotFoundError)) throw error;
		}
	}

	/** @internal Finalize provisional startup storage after project trust resolves. */
	rebindStore(store: SessionStore, removeProvisionalRecord: boolean): Promise<void> {
		return this.runMutation(async () => {
			if (store === this.store) return;
			const header = this.recordHeader();
			const entries = this.getEntries();
			const hashes = sessionBlobHashes(this.store, entries);
			assertSessionBlobStore(store, this.sessionId, hashes.length);
			const result = await store.create(header, entries);
			await copySessionBlobs(this.store, this.sessionId, store, this.sessionId, hashes);
			if (removeProvisionalRecord) await this.store.delete(this.sessionId);
			this.store = store;
			this.sessionDir = store instanceof JsonlSessionStore ? store.descriptor.location : "";
			this.restore({ header, entries, lastSeq: result.lastSeq });
		});
	}

	async openSessionById(sessionId: string, cwdOverride?: string, sessionDirectory?: string): Promise<SessionManager> {
		let store =
			sessionDirectory === undefined
				? this.store
				: await JsonlSessionStore.open(sessionDirectory, { exactDirectory: true, scanExisting: false });
		let snapshot: SessionSnapshot;
		try {
			snapshot = await store.load(sessionId);
		} catch (error) {
			if (
				!(error instanceof SessionNotFoundError) ||
				sessionDirectory !== undefined ||
				!this.usesDefaultSessionDir()
			)
				throw error;
			store = await JsonlSessionStore.open(join(getAgentDir(), "sessions"), { scanExisting: false });
			snapshot = await store.load(sessionId);
		}
		const location = store instanceof JsonlSessionStore ? await store.findFile(sessionId) : undefined;
		if (location !== undefined) {
			store = await JsonlSessionStore.open(dirname(location), { exactDirectory: true, scanExisting: false });
			snapshot = await store.load(sessionId);
		}
		if (snapshot.header.id !== sessionId) throw new SessionIdMismatchError(sessionId, snapshot.header.id);
		const manager = new SessionManager(store, cwdOverride ?? snapshot.header.cwd, this.sessionDir);
		manager.restore(snapshot, location);
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
		const result = await this.store.append(this.sessionId, entries, { expectSeq: this.lastSeq });
		this.lastSeq = result.lastSeq;
		for (const entry of entries) {
			this.fileEntries.push(entry);
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
		}
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
				{ has: (id) => id === modelEntry?.id || this.byId.has(id) },
				modelEntry?.id ?? this.leafId,
			);
			await this._appendEntries(modelEntry === undefined ? [thinkingEntry] : [modelEntry, thinkingEntry]);
		});
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id. */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): Promise<string> {
		return this.runMutation(async () => {
			const entry = createMessageEntry(message, this.byId, this.leafId);
			await this._appendEntry(entry);
			return entry.id;
		});
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
	appendCompaction(
		compactedText: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details: VerbatimCompactionDetails,
		usage?: Usage,
		coveredThroughEntryId?: string,
		precondition?: () => void,
	): Promise<string> {
		return this.runMutation(async () => {
			precondition?.();
			if (firstKeptEntryId !== null && !this.byId.has(firstKeptEntryId))
				throw new SessionEntryError(firstKeptEntryId, "missing");
			if (coveredThroughEntryId !== undefined && !this.byId.has(coveredThroughEntryId))
				throw new SessionEntryError(coveredThroughEntryId, "missing");
			const entry = createCompactionEntry(
				compactedText,
				firstKeptEntryId,
				tokensBefore,
				details,
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
			const target = this.byId.get(targetId);
			if (!target) throw new SessionEntryError(targetId, "missing");
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

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry<T = SessionJsonValue>(customType: string, data?: T): Promise<string> {
		return this.runMutation(async () => {
			const entry = createCustomEntry(customType, data, this.byId, this.leafId);
			await this._appendEntry(entry);
			return entry.id;
		});
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
	 * this host into `root`, and `restoreWarnings` what that restore reported beyond its snapshot record.
	 */
	appendWorktreeSnapshot(
		root: string,
		snapshotId: string,
		snapshot?: WorktreeSnapshot,
		restore?: WorktreeRootMapping,
		restoreWarnings: readonly WorktreeRestoreHostWarning[] = [],
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
			if (restore === undefined && restoreWarnings.length > 0) {
				throw new WorkspaceConfigError("sdk", "restoreWarnings", "warnings recorded together with their restore");
			}
			const entry = createWorktreeSnapshotEntry(
				root,
				snapshotId,
				snapshot,
				restore,
				restoreWarnings,
				this.byId,
				this.leafId,
			);
			await this._appendEntry(entry);
			return entry.id;
		});
	}

	/** Restores recorded on the active branch, oldest first: work recorded under `from` continues under `to`. */
	getWorktreeRootMappings(): WorktreeRootMapping[] {
		return this.getBranch().flatMap((entry) =>
			entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : [],
		);
	}

	/** Every snapshot record in the session, by id. */
	getWorktreeSnapshotRecords(): Map<string, WorktreeSnapshot> {
		const records = new Map<string, WorktreeSnapshot>();
		for (const entry of this.fileEntries) {
			if (entry.type === "worktree_snapshot" && entry.snapshot) records.set(entry.snapshotId, entry.snapshot);
		}
		return records;
	}

	/** The latest snapshot of each checkout root on the active branch, keyed by the root it was last recorded under. */
	getLatestWorktreeSnapshots(): Map<string, WorktreeSnapshot> {
		const records = this.getWorktreeSnapshotRecords();
		const latest = new Map<string, WorktreeSnapshot>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "worktree_snapshot") continue;
			const snapshot = records.get(entry.snapshotId);
			if (snapshot) latest.set(entry.root, snapshot);
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
			if (!this.byId.has(summarizedThroughId)) throw new SessionEntryError(summarizedThroughId, "missing");
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
		return getLatestSessionName(this.fileEntries);
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

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/** Get all direct children of an entry. */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
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
			if (!this.byId.has(targetId)) {
				throw new SessionEntryError(targetId, "missing");
			}
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
		return getBranchPath(fromId ?? this.leafId, this.byId);
	}

	/** Return the active branch entries after applying the latest compaction boundary. */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	/** Build provenance-preserving, compaction-aware model context from the current leaf. */
	buildSessionProjection(): SessionProjection {
		return buildSessionProjection(this.getEntries(), this.leafId, this.byId, this.sessionId);
	}

	/** Build the session context (what gets sent to the LLM). */
	buildSessionContext(): SessionContext {
		const { messages, thinkingLevel, model } = this.buildSessionProjection();
		return { messages, thinkingLevel, model };
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

	/** Start a new branch from an earlier entry. */
	branch(branchFromId: string): Promise<void> {
		return this.runMutation(async () => {
			if (!this.byId.has(branchFromId)) {
				throw new SessionEntryError(branchFromId, "missing");
			}
			this.leafId = branchFromId;
		});
	}

	/** Reset the leaf pointer to null (before any entries). */
	resetLeaf(): Promise<void> {
		return this.runMutation(async () => {
			this.leafId = null;
		});
	}

	/** Start a new branch with a summary of the abandoned path. */
	branchWithSummary<T = SessionJsonValue>(
		branchFromId: string | null,
		summary: string,
		details?: T,
		fromHook?: boolean,
		usage?: import("@bastani/pi-ai/compat").Usage,
		fromId?: string,
	): Promise<string> {
		return this.runMutation(async () => {
			if (branchFromId !== null && !this.byId.has(branchFromId)) {
				throw new SessionEntryError(branchFromId, "missing");
			}
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
			const lastSeq = (
				await (store instanceof JsonlSessionStore
					? store.create(record, entries, location)
					: store.create(record, entries))
			).lastSeq;
			await copySessionBlobs(this.store, this.sessionId, store, record.id, hashes);
			this.store = store;
			this.fileEntries = result.fileEntries;
			this.sessionId = header.id;
			this.lastSeq = lastSeq;
			this.sessionFile = location;
			this._buildIndex();
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

	static async open(path: string, sessionDir?: string, cwdOverride?: string): Promise<SessionManager>;
	static async open(store: SessionStore, sessionId: string, cwdOverride?: string): Promise<SessionManager>;
	static async open(
		pathOrStore: string | SessionStore,
		directoryOrId?: string,
		cwdOverride?: string,
	): Promise<SessionManager> {
		if (typeof pathOrStore !== "string") {
			const snapshot = await pathOrStore.load(directoryOrId!);
			if (snapshot.header.id !== directoryOrId) throw new SessionIdMismatchError(directoryOrId!, snapshot.header.id);
			const manager = new SessionManager(
				pathOrStore,
				cwdOverride ?? snapshot.header.cwd,
				pathOrStore instanceof JsonlSessionStore ? pathOrStore.descriptor.location : "",
			);
			manager.restore(
				snapshot,
				pathOrStore instanceof JsonlSessionStore ? await pathOrStore.findFile(directoryOrId!) : undefined,
			);
			if (manager.sessionFile) manager.sessionDir = dirname(manager.sessionFile);
			return manager;
		}
		const path = resolvePath(pathOrStore);
		const directory = directoryOrId ?? dirname(path);
		const store = await JsonlSessionStore.open(dirname(path), { exactDirectory: true, scanExisting: false });
		let snapshot: SessionSnapshot;
		try {
			snapshot = await store.loadFile(path);
		} catch (error) {
			if (!(error instanceof StorageUnavailableError) || (error.cause as NodeJS.ErrnoException).code !== "ENOENT")
				throw error;
			const manager = new SessionManager(store, cwdOverride ?? process.cwd(), directory);
			manager.lastSeq = (await store.create(manager.recordHeader(), [], path)).lastSeq;
			manager.sessionFile = path;
			return manager;
		}
		const manager = new SessionManager(store, cwdOverride ?? snapshot.header.cwd, directory);
		manager.restore(snapshot, path);
		return manager;
	}

	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		options?: { includeInternal?: boolean },
	): Promise<SessionManager>;
	static async continueRecent(
		store: SessionStore,
		cwd: string,
		options?: { includeInternal?: boolean },
	): Promise<SessionManager>;
	static async continueRecent(
		cwdOrStore: string | SessionStore,
		directoryOrCwd?: string,
		options?: { includeInternal?: boolean },
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
			if (recent) manager.restore(await store.load(recent.id), recent.location);
			else await manager.initialize();
			return manager;
		});
	}

	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		const manager = new SessionManager(
			markPrivateMemorySessionStore(new MemorySessionStore(createSessionCwdMatcher)),
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
				!createSessionCwdMatcher(resolvePath(cwd))(resolvePath(header.cwd))
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
