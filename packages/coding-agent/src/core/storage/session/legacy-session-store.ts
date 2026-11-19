import { access, stat } from "node:fs/promises";
import { isProxy } from "node:util/types";
import { createSessionCwdMatcherAsync } from "../../../utils/canonical-path.ts";
import type { SessionEntry } from "../../session-manager-types.ts";
import type { SnapshotBlobStore } from "../../worktree-snapshot/types.ts";
import type { SqliteDatabase } from "../database.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { SessionExistsError, SessionNotFoundError } from "./errors.js";
import { type JsonlSessionFile, JsonlSessionStore } from "./jsonl-session-store.js";
import { latestLegacyMessageTime, summarizeLegacySession } from "./legacy-session-summary.js";
import { findSessionCompaction, readSessionTail, sessionRangeOf } from "./session-resume.js";
import { summarizeSession } from "./session-summary.js";
import type {
	OversizedSessionEntry,
	SessionBlob,
	SessionBranchPageCut,
	SessionCompactionPoint,
	SessionEntriesPage,
	SessionEntriesQuery,
	SessionEntryRange,
	SessionEntrySizes,
	SessionListQuery,
	SessionRecordHeader,
	SessionResume,
	SessionSearchIndex,
	SessionSnapshot,
	SessionStore,
	SessionSummary,
	SessionTail,
	SessionTaskReferenceDuplicatePage,
	SessionTaskReferenceDuplicateQuery,
	SessionWriteOptions,
	SessionWriteResult,
	StorageDescriptor,
} from "./types.js";
import { entrySizeLimit, matchesSessionIdPrefix } from "./types.js";

const DELETED_TABLE = "session_legacy_deleted";

/**
 * The default session store, plus the JSONL sessions saved before it existed.
 *
 * Sessions from before the SQLite default stay in `<agentDir>/sessions` and are
 * listed from there, so `/resume` and `--continue` show them without any upfront
 * work. A legacy session is converted into the database only when it is opened,
 * following pi's migrate-on-load pattern; afterwards it is read from the database
 * like any other session. The JSONL files are never modified. Deleting a session
 * records its ID so a legacy copy of it is not listed again. Listing reads a large legacy
 * session only from its two ends, so its cost does not grow with the size of the history.
 */
export class LegacySessionStore implements SessionStore {
	private readonly inner: SessionStore;
	private readonly legacyDirectory: string;
	private readonly databasePath: string;
	private legacy?: Promise<JsonlSessionStore | undefined>;
	private index?: Promise<ReadonlyMap<string, readonly JsonlSessionFile[]>>;
	private readonly summaries = new Map<string, { readonly stamp: string; readonly summary: SessionSummary | null }>();
	private deletions?: Promise<SqliteDatabase>;
	/** The wrapped store's blobs; a legacy session is converted before it stores one. */
	readonly putBlob?: (sessionId: string, data: Uint8Array) => Promise<SessionBlob>;
	readonly getBlob?: (sessionId: string, hash: string) => Promise<Uint8Array | undefined>;
	readonly readEntryRange?: (sessionId: string, query: SessionEntriesQuery) => Promise<SessionEntriesPage>;
	readonly searchIndex?: SessionSearchIndex;
	readonly readTreeOutline?: SessionStore["readTreeOutline"];
	readonly readChildCatalogCut?: SessionStore["readChildCatalogCut"];
	readonly readSelectedPage?: SessionStore["readSelectedPage"];
	readonly readForkWindow?: SessionStore["readForkWindow"];
	readonly readSnapshotCut?: SessionStore["readSnapshotCut"];

	constructor(inner: SessionStore, options: { readonly legacyDirectory: string; readonly databasePath: string }) {
		this.inner = inner;
		this.legacyDirectory = options.legacyDirectory;
		this.databasePath = options.databasePath;
		const { putBlob, getBlob, readForkWindow } = inner;
		if (readForkWindow)
			this.readForkWindow = async (id, entryId) => {
				await this.convert(id);
				return readForkWindow.call(inner, id, entryId);
			};
		if (putBlob !== undefined && getBlob !== undefined) {
			this.putBlob = async (sessionId, data) => {
				await this.convert(sessionId);
				return putBlob.call(inner, sessionId, data);
			};
			this.getBlob = (sessionId, hash) => getBlob.call(inner, sessionId, hash);
		}
		if (inner.readChildCatalogCut)
			this.readChildCatalogCut = async (id) => {
				await this.convert(id);
				return inner.readChildCatalogCut!(id);
			};
		if (inner.readSelectedPage)
			this.readSelectedPage = async (id, seqs, epoch, options) => {
				await this.convert(id);
				return inner.readSelectedPage!(id, seqs, epoch, options);
			};
		if (inner.readSnapshotCut)
			this.readSnapshotCut = async (id, options) => {
				await this.convert(id);
				return inner.readSnapshotCut!(id, options);
			};
		if (inner.readTreeOutline)
			this.readTreeOutline = async (id, from, to, epoch) => {
				await this.convert(id);
				return inner.readTreeOutline!(id, from, to, epoch);
			};
		const { readEntryRange, searchIndex } = inner;
		if (readEntryRange !== undefined)
			this.readEntryRange = async (sessionId, query) => {
				query.signal?.throwIfAborted();
				if ((await inner.readHeader(sessionId)) !== undefined) {
					return readEntryRange.call(inner, sessionId, query);
				}
				if (!(await this.isDeleted(sessionId))) {
					const legacy = await this.legacyStore();
					if (legacy !== undefined) {
						for (const file of (await this.legacyIndex()).get(sessionId) ?? []) {
							try {
								return await legacy.readFileEntryRange(file.location, query);
							} catch (error) {
								if (query.signal?.aborted) throw error;
							}
						}
					}
				}
				return readEntryRange.call(inner, sessionId, query);
			};
		if (searchIndex !== undefined) this.searchIndex = searchIndex;
	}

	get descriptor(): StorageDescriptor {
		return this.inner.descriptor;
	}

	/** The blob table of the wrapped store, so sessions on the default database record snapshots and collect them. */
	get snapshotBlobs(): SnapshotBlobStore | undefined {
		return this.inner.snapshotBlobs;
	}

	create(header: SessionRecordHeader, entries: readonly SessionEntry[]): Promise<SessionWriteResult> {
		return this.inner.create(header, entries);
	}

	async append(
		sessionId: string,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<{ readonly lastSeq: number }> {
		await this.convert(sessionId);
		return this.inner.append(sessionId, entries, options);
	}

	async replace(
		sessionId: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	): Promise<SessionWriteResult> {
		await this.convert(sessionId);
		return this.inner.replace(sessionId, header, entries, options);
	}

	async updateHeader(header: SessionRecordHeader, options: SessionWriteOptions): Promise<SessionWriteResult> {
		await this.convert(header.id);
		return (await import("./snapshot-history.js")).updateStoredHeader(this.inner, header, options);
	}

	async load(sessionId: string): Promise<SessionSnapshot> {
		await this.convert(sessionId);
		return this.inner.load(sessionId);
	}

	async readTail(sessionId: string, fromSeq: number): Promise<SessionTail> {
		await this.convert(sessionId);
		return readSessionTail(this.inner, sessionId, fromSeq);
	}

	async readRange(
		sessionId: string,
		startSeq: number,
		endSeq: number,
		expectedEpoch?: string,
	): Promise<SessionEntryRange> {
		await this.convert(sessionId);
		if (this.inner.readRange) return this.inner.readRange(sessionId, startSeq, endSeq, expectedEpoch);
		const snapshot = await this.inner.load(sessionId);
		const { assertSnapshotCut, snapshotStamp } = await import("./snapshot-history.js");
		assertSnapshotCut(snapshot, expectedEpoch, Math.min(endSeq, snapshot.lastSeq));
		return { ...sessionRangeOf(snapshot.entries, startSeq, endSeq), epoch: expectedEpoch ?? snapshotStamp(snapshot) };
	}

	async readBranchSpan(sessionId: string, cut: SessionBranchPageCut) {
		await this.convert(sessionId);
		if (this.inner.readBranchSpan) return this.inner.readBranchSpan(sessionId, cut);
		return (await import("./snapshot-history.js")).snapshotBranchSpan(this.inner, sessionId, cut);
	}

	async readEntrySizes(
		sessionId: string,
		startSeq: number,
		endSeq: number,
		limit?: number,
	): Promise<SessionEntrySizes> {
		await this.convert(sessionId);
		if (this.inner.readEntrySizes)
			return limit === undefined
				? this.inner.readEntrySizes(sessionId, startSeq, endSeq)
				: this.inner.readEntrySizes(sessionId, startSeq, endSeq, limit);
		const snapshot = await this.inner.load(sessionId);
		const { snapshotStamp } = await import("./snapshot-history.js");
		const start = Math.max(startSeq, 1);
		return {
			epoch: snapshotStamp(snapshot),
			lastSeq: snapshot.lastSeq,
			sizes: snapshot.entries
				.slice(start - 1, Math.min(endSeq, start - 1 + entrySizeLimit(limit)))
				.map((entry, i) => ({ seq: start + i, bytes: Buffer.byteLength(JSON.stringify(entry)) })),
		};
	}

	async readEntryChunk(reference: OversizedSessionEntry, offset: number): Promise<Uint8Array> {
		await this.convert(reference.sessionId);
		if (this.inner.readEntryChunk) return this.inner.readEntryChunk(reference, offset);
		return (await import("./snapshot-history.js")).snapshotChunk(this.inner, reference, offset);
	}

	async findLatestCompaction(sessionId: string, leafId?: string): Promise<SessionCompactionPoint | undefined> {
		await this.convert(sessionId);
		return findSessionCompaction(this.inner, sessionId, leafId);
	}

	async readResume(sessionId: string, leafId?: string, options?: { deferChildRecords: true }): Promise<SessionResume> {
		await this.convert(sessionId);
		if (this.inner.readResume)
			return options ? this.inner.readResume(sessionId, leafId, options) : this.inner.readResume(sessionId, leafId);
		return (await import("./snapshot-history.js")).snapshotWindow(
			this.inner,
			sessionId,
			leafId,
			undefined,
			undefined,
			isProxy,
		);
	}
	async findEntrySeq(sessionId: string, entryId: string): Promise<number | undefined> {
		await this.convert(sessionId);
		if (this.inner.findEntrySeq) return this.inner.findEntrySeq(sessionId, entryId);
		const index = (await this.inner.load(sessionId)).entries.findLastIndex((entry) => entry.id === entryId);
		return index < 0 ? undefined : index + 1;
	}

	/**
	 * The wrapped store's answer, or `undefined` when it has no entry-ID index or the session is still only a legacy
	 * file: a legacy session is never converted, nor its history loaded, for this query.
	 */
	async findTaskReferenceDuplicateCandidates(
		sessionId: string,
		query: SessionTaskReferenceDuplicateQuery,
	): Promise<SessionTaskReferenceDuplicatePage | undefined> {
		if (this.inner.findTaskReferenceDuplicateCandidates === undefined) return undefined;
		try {
			return await this.inner.findTaskReferenceDuplicateCandidates(sessionId, query);
		} catch (error) {
			if (error instanceof SessionNotFoundError && (await this.findLegacy(sessionId)) !== undefined)
				return undefined;
			throw error;
		}
	}

	async readHeader(sessionId: string): Promise<SessionRecordHeader | undefined> {
		const header = await this.inner.readHeader(sessionId);
		if (header !== undefined) return header;
		return (await this.findLegacy(sessionId))?.header;
	}

	async delete(sessionId: string): Promise<void> {
		const legacy = await this.findLegacy(sessionId);
		if (legacy !== undefined) await this.markDeleted(sessionId);
		try {
			await this.inner.delete(sessionId);
		} catch (error) {
			if (!(error instanceof SessionNotFoundError) || legacy === undefined) throw error;
		}
	}

	async *list(query: SessionListQuery): AsyncIterable<SessionSummary> {
		const listed = new Set<string>();
		for await (const summary of this.inner.list(query)) {
			listed.add(summary.id);
			yield summary;
		}
		for await (const file of this.legacyFiles(query)) {
			if (listed.has(file.header.id) || (await this.inner.readHeader(file.header.id)) !== undefined) continue;
			const summary = await this.summarize(file.header.id, query.withoutSearchText === true);
			if (summary === undefined) continue;
			listed.add(summary.id);
			yield summary;
		}
	}

	async findMostRecent(query: {
		readonly cwd: string;
		readonly includeInternal?: boolean;
	}): Promise<SessionSummary | undefined> {
		let latest = await this.inner.findMostRecent(query);
		for await (const file of this.legacyFiles(query)) {
			if ((await this.inner.readHeader(file.header.id)) !== undefined) continue;
			const summary = await this.summarize(file.header.id);
			if (summary !== undefined && (!latest || Date.parse(summary.modifiedAt) > Date.parse(latest.modifiedAt))) {
				latest = summary;
			}
		}
		return latest;
	}

	async close(): Promise<void> {
		const legacy = this.legacy;
		const deletions = this.deletions;
		this.legacy = undefined;
		this.deletions = undefined;
		this.index = undefined;
		this.summaries.clear();
		await Promise.all([
			legacy?.then((store) => store?.close()).catch(() => {}),
			deletions?.then((database) => database.close()).catch(() => {}),
		]);
		await this.inner.close();
	}

	/** Convert one legacy session into the database the first time it is needed. */
	private async convert(sessionId: string): Promise<void> {
		if ((await this.inner.readHeader(sessionId)) !== undefined) return;
		const snapshot = await this.readLegacy(sessionId);
		if (snapshot === undefined) return;
		try {
			await this.inner.create(snapshot.header, snapshot.entries);
		} catch (error) {
			if (!(error instanceof SessionExistsError)) throw error;
		}
		if (await this.isDeleted(sessionId)) await this.inner.delete(sessionId).catch(() => {});
	}

	/** The first readable copy of a legacy session; a damaged duplicate does not hide a readable one. */
	private async readLegacy(sessionId: string): Promise<SessionSnapshot | undefined> {
		if (await this.isDeleted(sessionId)) return undefined;
		for (const file of (await this.legacyIndex()).get(sessionId) ?? []) {
			try {
				const snapshot = await file.read();
				summarizeSession(snapshot);
				return snapshot;
			} catch {
				// Try the next copy.
			}
		}
		return undefined;
	}

	private async findLegacy(sessionId: string): Promise<JsonlSessionFile | undefined> {
		const file = (await this.legacyIndex()).get(sessionId)?.[0];
		if (file === undefined || (await this.isDeleted(sessionId))) return undefined;
		return file;
	}

	private async *legacyFiles(query: {
		readonly cwd?: string;
		readonly idPrefix?: string;
		readonly includeInternal?: boolean;
	}): AsyncIterable<JsonlSessionFile> {
		const matchesCwd = query.cwd === undefined ? undefined : createSessionCwdMatcherAsync(query.cwd);
		for (const [file] of (await this.legacyIndex()).values()) {
			if (file === undefined) continue;
			if (!matchesSessionIdPrefix(file.header.id, query.idPrefix)) continue;
			if (matchesCwd && !(await matchesCwd(file.header.cwd))) continue;
			if (!query.includeInternal && file.header.internal) continue;
			if (await this.isDeleted(file.header.id)) continue;
			yield file;
		}
	}

	/**
	 * Header-only index of the legacy directory, read once; nothing writes legacy sessions any more.
	 * Copies of one session, such as conflict copies left by a sync tool, are ordered newest first.
	 */
	private legacyIndex(): Promise<ReadonlyMap<string, readonly JsonlSessionFile[]>> {
		this.index ??= (async () => {
			const files = new Map<string, JsonlSessionFile[]>();
			const legacy = await this.legacyStore();
			if (legacy === undefined) return files;
			try {
				for await (const file of legacy.scanFiles()) {
					const copies = files.get(file.header.id);
					if (copies) copies.push(file);
					else files.set(file.header.id, [file]);
				}
			} catch {
				// An unreadable legacy directory leaves only the sessions already in the database.
			}
			for (const [sessionId, copies] of files) {
				if (copies.length > 1) files.set(sessionId, await newestCopiesFirst(copies));
			}
			return files;
		})();
		return this.index;
	}

	/**
	 * Listing rows are cached per store until a copy of the session changes on disk. A row is built
	 * from bounded reads, not a full parse, so listing does not cost the size of the history.
	 */
	private async summarize(sessionId: string, withoutSearchText = false): Promise<SessionSummary | undefined> {
		const copies = await Promise.all(
			((await this.legacyIndex()).get(sessionId) ?? []).map(async (file) => ({
				file,
				stats: await stat(file.location).catch(() => undefined),
			})),
		);
		const stamp = `${withoutSearchText ? "light:" : ""}${copies
			.map(({ stats }) => (stats === undefined ? "missing" : `${stats.size}:${stats.mtimeMs}`))
			.join("|")}`;
		const key = `${withoutSearchText ? "light:" : ""}${sessionId}`;
		const cached = this.summaries.get(key);
		if (cached !== undefined && cached.stamp === stamp) return cached.summary ?? undefined;
		let summary: SessionSummary | null = null;
		for (const { file, stats } of copies) {
			if (stats === undefined) continue;
			try {
				summary = await summarizeLegacySession(
					file,
					stats.size,
					stats.mtimeMs,
					withoutSearchText ? { whole: false } : undefined,
				);
				break;
			} catch {
				// Try the next copy.
			}
		}
		this.summaries.set(key, { stamp, summary });
		return summary ?? undefined;
	}

	private legacyStore(): Promise<JsonlSessionStore | undefined> {
		this.legacy ??= access(this.legacyDirectory).then(
			() => JsonlSessionStore.open(this.legacyDirectory, { scanExisting: false }).catch(() => undefined),
			() => undefined,
		);
		return this.legacy;
	}

	/**
	 * A second connection to the default database. It writes only in transactions, which wait for the write lock without
	 * holding the event loop and queue behind this process's other transactions on the file, never in a statement of its
	 * own, which would wait for the lock synchronously while another connection of this process holds it (#5530).
	 */
	private deletionDatabase(): Promise<SqliteDatabase> {
		this.deletions ??= openNodeSqliteDatabase(this.databasePath).then(async (database) => {
			// Read first, so a database that has the table, as every one this store opened before does, takes no write lock.
			const exists = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${DELETED_TABLE}'`;
			if ((await database.get(exists)) === undefined)
				await database.transaction((transaction) =>
					transaction.exec(
						`CREATE TABLE IF NOT EXISTS ${DELETED_TABLE}(id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)`,
					),
				);
			return database;
		});
		return this.deletions;
	}

	private async isDeleted(sessionId: string): Promise<boolean> {
		const database = await this.deletionDatabase();
		return (await database.get(`SELECT id FROM ${DELETED_TABLE} WHERE id = ?`, sessionId)) !== undefined;
	}

	private async markDeleted(sessionId: string): Promise<void> {
		const database = await this.deletionDatabase();
		await database.transaction((transaction) =>
			transaction.run(`INSERT INTO ${DELETED_TABLE} VALUES (?, ?) ON CONFLICT DO NOTHING`, sessionId, Date.now()),
		);
	}
}

/**
 * Orders copies of one session by their latest message, newest first. Each copy is dated from its
 * end backwards, one copy at a time, so a large set of conflict copies is never parsed whole or held
 * in memory together. File modification time never stands in for a message time, because a sync
 * tool can rewrite it; it only breaks ties, then directory order. A copy without messages sorts
 * after every copy with one, and a damaged or unreadable copy sorts last.
 */
async function newestCopiesFirst(copies: readonly JsonlSessionFile[]): Promise<JsonlSessionFile[]> {
	const ranked: { file: JsonlSessionFile; order: number; damaged: number; latest: number; modified: number }[] = [];
	for (const [order, file] of copies.entries()) {
		const stats = await stat(file.location).catch(() => undefined);
		let damaged = stats === undefined;
		let latest: number | undefined;
		if (stats !== undefined) {
			try {
				latest = await latestLegacyMessageTime(file.location, stats.size);
			} catch {
				damaged = true;
			}
		}
		ranked.push({
			file,
			order,
			damaged: damaged ? 1 : 0,
			latest: latest ?? Number.NEGATIVE_INFINITY,
			modified: stats?.mtimeMs ?? Number.NEGATIVE_INFINITY,
		});
	}
	return ranked
		.sort((a, b) => a.damaged - b.damaged || b.latest - a.latest || b.modified - a.modified || a.order - b.order)
		.map(({ file }) => file);
}
