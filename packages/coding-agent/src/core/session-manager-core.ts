import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getCurrentSystemMessage } from "@bastani/pi-ai";
import type { ImageContent, Message, TextContent, Usage } from "@bastani/pi-ai/compat";
import { getAgentDir } from "../config.js";
import { normalizePath, resolvePath } from "../utils/paths.ts";
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
} from "./session-manager-types.ts";
import {
	assertValidSessionId,
	createSessionId,
	generateId,
	validateSessionFileEntries,
} from "./session-manager-validation.ts";
import { resolveSessionStore } from "./session-storage.js";
import { listSessionStore } from "./session-store-list.js";
import {
	SessionFormatVersionError,
	SessionIdMismatchError,
	type SessionJsonValue,
	SessionNotFoundError,
	StorageUnavailableError,
} from "./storage/session/errors.js";
import { JsonlSessionStore } from "./storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "./storage/session/memory-session-store.js";
import type { SessionRecordHeader, SessionSnapshot, SessionStore } from "./storage/session/types.js";

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
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
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
			const snapshot = await source.loadFile(inputPath);
			const manager = new SessionManager(this.store, cwdOverride ?? snapshot.header.cwd, this.sessionDir);
			manager.restore(snapshot);
			await manager.initialize();
			return manager;
		} finally {
			await source.close();
		}
	}

	private async _appendEntry(entry: SessionEntry): Promise<void> {
		const result = await this.store.append(this.sessionId, [entry], { expectSeq: this.lastSeq });
		this.lastSeq = result.lastSeq;
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
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

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.runMutation(async () => {
			const entry = createModelChangeEntry(provider, modelId, this.byId, this.leafId);
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
	): Promise<string> {
		return this.runMutation(async () => {
			if (firstKeptEntryId !== null && !this.byId.has(firstKeptEntryId))
				throw new SessionEntryError(firstKeptEntryId, "missing");
			const entry = createCompactionEntry(
				compactedText,
				firstKeptEntryId,
				tokensBefore,
				details,
				usage,
				this.byId,
				this.leafId,
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
		return buildSessionProjection(this.getEntries(), this.leafId, this.byId);
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
		const manager = new SessionManager(store, cwd, directory, { ...options, parentSession: this.sessionId });
		manager.fileEntries.push(...this.getEntries());
		await manager.initialize();
		manager._buildIndex();
		return manager;
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
		return new SessionManager(
			store,
			cwd,
			store instanceof JsonlSessionStore ? store.descriptor.location : "",
		).importFromJsonl(inputPath);
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
			return SessionManager.create(await resolveSessionStore(cwd), cwd, options);
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
		const manager = new SessionManager(store, cwd, directory, options);
		if (typeof cwdOrStore !== "string" && store instanceof JsonlSessionStore) {
			manager.sessionFile = store.locationFor(manager.recordHeader());
			manager.sessionDir = dirname(manager.sessionFile);
		}
		await manager.initialize();
		return manager;
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
			return SessionManager.continueRecent(await resolveSessionStore(cwd), cwd, options);
		}
		const directory = typeof cwdOrStore === "string" ? (directoryOrCwd ?? getDefaultSessionDirPath(cwd)) : "";
		const store =
			typeof cwdOrStore === "string"
				? await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false })
				: cwdOrStore;
		const recent = await store.findMostRecent({ cwd: resolvePath(cwd), includeInternal: options?.includeInternal });
		const manager = new SessionManager(store, cwd, directory);
		if (recent) manager.restore(await store.load(recent.id), recent.location);
		else await manager.initialize();
		return manager;
	}

	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		const manager = new SessionManager(new MemorySessionStore(), cwd, "", options);
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
		sessionDir?: string,
		options?: NewSessionOptions,
	): Promise<SessionManager> {
		const sourceStore = await JsonlSessionStore.open(dirname(resolvePath(sourcePath)), {
			exactDirectory: true,
			scanExisting: false,
		});
		const source = await sourceStore.loadFile(resolvePath(sourcePath));
		await sourceStore.close();
		const store =
			sessionDir === undefined
				? await resolveSessionStore(targetCwd)
				: await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false });
		const manager = new SessionManager(store, targetCwd, sessionDir ?? "", {
			...options,
			parentSession: source.header.id,
		});
		manager.fileEntries.push(...source.entries);
		await manager.initialize();
		manager._buildIndex();
		return manager;
	}

	static async findById(cwd: string, id: string, sessionDir?: string): Promise<string | undefined> {
		const store =
			sessionDir === undefined
				? await resolveSessionStore(cwd)
				: await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false });
		try {
			const header = await store.readHeader(id);
			if (!header || classifiedWorkflowMetadata(header) || resolvePath(header.cwd) !== resolvePath(cwd))
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
