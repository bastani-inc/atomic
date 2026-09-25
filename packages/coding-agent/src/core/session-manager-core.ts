import { getCurrentSystemMessage } from "@bastani/pi-ai";
import type { ImageContent, Message, TextContent, Usage } from "@bastani/pi-ai/compat";
import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { APP_TITLE } from "../config.js";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { createBackupSnapshot, createBranchedSessionState, forkSessionFromFile } from "./session-manager-archive.ts";
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
import {
	buildContextEntries,
	buildSessionIndex,
	buildSessionProjection,
	buildSessionTree,
	getBranchPath,
} from "./session-manager-history.ts";
import { listAllSessions, listProjectSessions } from "./session-manager-list.ts";
import { migrateToCurrentVersion } from "./session-manager-migrations.ts";
import { getDefaultSessionDir, getDefaultSessionDirPath } from "./session-manager-paths.ts";
import {
	ensureDirectory,
	findMostRecentSession,
	getSessionHeaderCwd,
	isInternalHeader,
	loadEntriesFromFile,
	persistAppendedEntry,
	readSessionHeader,
	sessionCwdMatches,
	writeSessionEntries,
} from "./session-manager-storage.ts";
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
import { assertValidSessionId, createSessionId, generateId } from "./session-manager-validation.ts";

/** Manages conversation sessions as append-only trees stored in JSONL files.  Each session entry has an id and parentId forming a tree structure. The "leaf" pointer tracks the current position. Appending creates a child of the current leaf. Branching moves the leaf to an earlier entry, allowing new branches without modifying history.  Use buildSessionContext() to get the resolved message list for the LLM, which applies context-deletion filtering and follows the path from root to current leaf. */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir) {
			ensureDirectory(this.sessionDir);
		}

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else if (preloadedFileEntries?.length) {
			this._loadEntries(preloadedFileEntries, newSessionOptions);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	private _loadEntries(entries: FileEntry[], options?: NewSessionOptions): void {
		const header = entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		if (header) {
			this.fileEntries = entries;
			this.sessionId = header.id;
			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}
		} else {
			this.newSession(options);
			this.fileEntries = this.fileEntries.concat(entries);
		}
		this._buildIndex();
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries = preloadedFileEntries ?? loadEntriesFromFile(this.sessionFile);

			// If file was empty, initialize it with a valid session header. If it was non-empty but did not parse as a session, fail without modifying it.
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid ${APP_TITLE} session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
			this.sessionId = header?.id ?? createSessionId();

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header = createSessionHeader(
			this.sessionId,
			this.cwd,
			timestamp,
			options?.parentSession,
			options?.internal,
			options?.workflow,
		);
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			this.sessionFile = createSessionFilePath(this.getSessionDir(), timestamp, this.sessionId);
		}
		return this.sessionFile;
	}

	/** Mark the session as workflow-owned, repairing malformed markers while preserving valid ownership. */
	markSessionInternal(workflow?: SessionWorkflowMetadata): void {
		const header = this.fileEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		if (!header || classifiedWorkflowMetadata(header)) return;
		const validWorkflow = validSessionWorkflowMetadata(workflow);
		if (!validWorkflow) return;
		header.internal = true;
		header.workflow = validWorkflow;
		if (this.flushed) this._rewriteFile();
	}

	private _buildIndex(): void {
		const index = buildSessionIndex(this.fileEntries);
		this.byId = index.byId;
		this.labelsById = index.labelsById;
		this.labelTimestampsById = index.labelTimestampsById;
		this.leafId = index.leafId;
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		writeSessionEntries(this.sessionFile, this.fileEntries);
	}

	isPersisted(): boolean {
		return this.persist;
	}

	/** Persist the current session tree before an in-process attempt is force-finalized. */
	flush(): void {
		if (!this.persist || !this.sessionFile) return;
		this._rewriteFile();
		this.flushed = true;
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

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;
		this.flushed = persistAppendedEntry(this.sessionFile, this.fileEntries, entry, this.flushed);
	}

	private _appendEntry(entry: SessionEntry): void {
		const previousLeafId = this.leafId;
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		try {
			this._persist(entry);
		} catch (error) {
			// Unpublish on write failure, so retries cannot point at an unwritten parent.
			this.fileEntries.pop();
			this.byId.delete(entry.id);
			this.leafId = previousLeafId;
			throw error;
		}
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id. */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry = createMessageEntry(message, this.byId, this.leafId);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry = createThinkingLevelChangeEntry(thinkingLevel, this.byId, this.leafId);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Record auxiliary model usage without adding it to the LLM context. */
	appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): UsageEntry {
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
		this._appendEntry(entry);
		return entry;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry = createModelChangeEntry(provider, modelId, this.byId, this.leafId);
		this._appendEntry(entry);
		return entry.id;
	}
	appendCompaction(
		compactedText: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details: VerbatimCompactionDetails,
		usage?: Usage,
	): string {
		if (firstKeptEntryId !== null && !this.byId.has(firstKeptEntryId))
			throw new Error(`Entry ${firstKeptEntryId} not found`);
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
		this._appendEntry(entry);
		return entry.id;
	}

	/** Write a recoverable snapshot of the current session entries without mutating the active JSONL. */
	writeBackupSnapshot(label = "compact"): string | undefined {
		if (!this.persist) return undefined;
		return createBackupSnapshot(this.sessionFile, this.fileEntries, label);
	}

	/** Append a branch-local edit to an earlier model-visible entry. */
	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string {
		if (
			replacement !== null &&
			(typeof replacement !== "object" ||
				!("content" in replacement) ||
				(typeof replacement.content !== "string" && !Array.isArray(replacement.content)))
		) {
			throw new Error("Context edit replacement must be null or contain string/array content");
		}
		const target = this.byId.get(targetId);
		if (!target) throw new Error(`Entry ${targetId} not found`);
		if (!this.getBranch().some((entry) => entry.id === targetId)) {
			throw new Error(`Entry ${targetId} is not on the active branch`);
		}
		const editable =
			target.type === "custom_message" ||
			(target.type === "message" &&
				(target.message.role === "user" ||
					target.message.role === "assistant" ||
					target.message.role === "toolResult"));
		if (!editable) throw new Error(`Entry ${targetId} does not contribute editable model content`);
		const targetRole = target.type === "message" ? target.message.role : "custom";
		const normalizedReplacement =
			replacement !== null &&
			(targetRole === "assistant" || targetRole === "toolResult") &&
			typeof replacement.content === "string"
				? { content: [{ type: "text" as const, text: replacement.content }] }
				: replacement;
		const entry = createContextEditEntry(targetId, normalizedReplacement, this.byId, this.leafId);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry = createCustomEntry(customType, data, this.byId, this.leafId);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const entry = createSessionInfoEntry(name, this.byId, this.leafId);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a generated resume summary anchored to the message it describes. Returns entry id. */
	appendSessionSummary(summary: string, summarizedThroughId: string, usage?: Usage): string {
		if (!this.byId.has(summarizedThroughId)) throw new Error(`Entry ${summarizedThroughId} not found`);
		const entry = createSessionSummaryEntry(summary, summarizedThroughId, usage, this.byId, this.leafId);
		this._appendEntry(entry);
		return entry.id;
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
		return getLatestSessionName(this.getEntries());
	}

	/** Append a custom message entry (for extensions) that participates in LLM context unless excluded. */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		excludeFromContext?: boolean,
		protectedReconciliation?: { delivery: "steer" | "followUp" },
		stageAdmissionKey?: string,
	): string {
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
		this._appendEntry(entry);
		return entry.id;
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
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry = createLabelEntry(targetId, label, this.byId, this.leafId);
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
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

	/** Get all session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return getEntriesWithoutHeader(this.fileEntries);
	}

	/**
	 * Read the current entries directly from disk when this session is persisted,
	 * bypassing this instance's in-memory snapshot. A separate `SessionManager`
	 * instance over the same session file (for example the interactive TUI host's
	 * view of an isolated engine-child session) only re-syncs at coarse points such
	 * as `agent_end`, so between those points it can lag entries the owning process
	 * already flushed — including a `cache_prefix` custom entry appended just before
	 * the request whose response this call is inspecting. In-memory sessions have no
	 * file to re-read and return the same view as `getEntries()`. Does not mutate
	 * this instance's cached state.
	 */
	getFreshEntries(): SessionEntry[] {
		if (!this.persist || !this.sessionFile) return this.getEntries();
		return getEntriesWithoutHeader(loadEntriesFromFile(this.sessionFile));
	}

	/** Get the session as a tree structure. Returns a shallow defensive copy of all entries. */
	getTree(): SessionTreeNode[] {
		return buildSessionTree(this.getEntries(), this.labelsById, this.labelTimestampsById);
	}

	/** Start a new branch from an earlier entry. */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/** Reset the leaf pointer to null (before any entries). */
	resetLeaf(): void {
		this.leafId = null;
	}

	/** Start a new branch with a summary of the abandoned path. */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: import("@bastani/pi-ai/compat").Usage,
		fromId: string = this.leafId ?? "root",
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = createBranchSummaryEntry(
			branchFromId,
			fromId,
			summary,
			details,
			usage,
			fromHook,
			this.byId,
		);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Create a new session file containing only the path from root to the specified leaf. */
	createBranchedSession(leafId: string): string | undefined {
		const result = createBranchedSessionState({
			leafId,
			persist: this.persist,
			sessionDir: this.getSessionDir(),
			cwd: this.cwd,
			previousSessionFile: this.sessionFile,
			workflow: classifiedWorkflowMetadata(this.getHeader()),
			path: this.getBranch(leafId),
			labelsById: this.labelsById,
			labelTimestampsById: this.labelTimestampsById,
		});
		this.fileEntries = result.fileEntries;
		this.sessionId = result.sessionId;
		if (result.sessionFile) this.sessionFile = result.sessionFile;
		this._buildIndex();

		if (this.persist) {
			if (result.shouldRewriteFile) this._rewriteFile();
			this.flushed = result.flushed ?? false;
			return result.sessionFile;
		}
		return undefined;
	}

	/** Create a new session. */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/** Open a specific session file. */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		const entries = loadEntriesFromFile(resolvedPath);
		const header = entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, entries);
	}

	/** Continue the most recent session (skips internal workflow sessions unless `includeInternal: true`). */
	static continueRecent(cwd: string, sessionDir?: string, options?: { includeInternal?: boolean }): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined, options?.includeInternal === true);
		return new SessionManager(cwd, dir, mostRecent ?? undefined, true);
	}

	/** Create an in-memory session (no file persistence), optionally preloaded with entries. */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options, entries);
	}

	/** Fork a session from another project directory into the current project. */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const forked = forkSessionFromFile(sourcePath, targetCwd, sessionDir, options);
		return new SessionManager(forked.cwd, forked.sessionDir, forked.sessionFile, true);
	}

	/** Find an exact, non-internal session ID by reading headers, not transcripts. */
	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(dir, file);
				const header = readSessionHeader(path);
				if (header?.id !== id || isInternalHeader(header)) continue;
				if (filterCwd && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) continue;
				return path;
			}
		} catch {
			// Discovery is best-effort, matching list().
		}
		return undefined;
	}

	/** List sessions for a directory. Internal (workflow) sessions are excluded unless `includeInternal: true`. */
	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		options?: { includeInternal?: boolean; signal?: AbortSignal } | AbortSignal,
	): Promise<SessionInfo[]> {
		const signal = options && "aborted" in options ? options : options?.signal;
		return listProjectSessions(
			cwd,
			sessionDir,
			onProgress,
			options !== undefined && "includeInternal" in options && options.includeInternal === true,
			signal,
		);
	}

	/** List sessions across all directories. Internal (workflow) sessions are excluded unless `includeInternal: true`. */
	static async listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		options?: { includeInternal?: boolean; signal?: AbortSignal } | AbortSignal,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress | AbortSignal,
		options?: { includeInternal?: boolean; signal?: AbortSignal } | AbortSignal,
	): Promise<SessionInfo[]> {
		const signal =
			options && "aborted" in options
				? options
				: (options?.signal ?? (typeof onProgress === "object" ? onProgress : undefined));
		return listAllSessions(
			sessionDirOrOnProgress,
			typeof onProgress === "function" ? onProgress : undefined,
			options !== undefined && "includeInternal" in options && options.includeInternal === true,
			signal,
		);
	}
}
