import { existsSync } from "node:fs";
import {
	discoverLegacyJournal,
	isJournalCatalogError,
	isJournalShardUnavailableError,
	JournalCatalog,
	JournalCatalogError,
	type JournalShardRecord,
	JournalShardUnavailableError,
	type StorageDescriptor,
	type StorageFailureCause,
} from "@bastani/atomic/storage";
import { journalKeyRangeRead } from "./internal.js";
import {
	type AppendOutcome,
	JOURNAL_LEASE,
	JournalClosedError,
	type JournalEntry,
	type Lease,
	type LeaseOutcome,
	type LeaseState,
	RUN_EVENT_TYPES,
	type RunEvent,
	type RunHeader,
	type RunJournal,
	type RunJournalBatchAppend,
	RunNotFoundError,
	type RunSnapshotTail,
	type RunSummary,
	type RunVersion,
	StaleLeaseError,
	StorageUnavailableError,
} from "./types.js";
import { serializeJson, validateText } from "./values.js";

const SHARDED_RUN_JOURNAL = Symbol.for("@bastani/workflows/sharded-run-journal");
/** A read follows its run to another shard at most this often: a consolidation moves it once, a rollback moves it back. */
const READ_FOLLOW_LIMIT = 3;

export interface ShardedRunJournalOptions {
	/** The store's directory: its `catalog.sqlite` and native shard files. */
	readonly directory: string;
	/** Opens a run journal on the SQLite file at `path`, creating the file when it does not exist. */
	readonly openShard: (path: string) => Promise<RunJournal>;
	/** A single-file journal to adopt in place when the store opens, if it holds workflow runs; `false` for none. */
	readonly legacyJournal?: string | false;
}

/** Runs whose status changes the catalog has not recorded yet, and why the last attempt failed. */
export interface ShardedRunJournalCatalogBacklog {
	readonly pending: number;
	readonly failure?: JournalCatalogError;
}

/**
 * A detached copy of a header or payload, taken before the first await, as a single-file journal takes it: a caller
 * that changes the object after the call does not change what is recorded. A value JSON cannot represent is returned
 * as the failure to serialize it.
 */
function detached<T extends RunHeader | RunEvent["payload"]>(value: T): T | { readonly unserializable: Error } {
	try {
		return JSON.parse(serializeJson(value)) as T;
	} catch (cause) {
		return { unserializable: cause as Error };
	}
}

function unserializable<T>(value: T | { readonly unserializable: Error }): value is { readonly unserializable: Error } {
	return (
		typeof value === "object" && value !== null && "unserializable" in value && value.unserializable instanceof Error
	);
}

/** The payload a shard records, or, when it cannot be serialized, the original for the shard to reject as it always did. */
function recordedPayload(payload: RunEvent["payload"]): RunEvent["payload"] {
	const copy = detached(payload);
	return unserializable(copy) ? payload : copy;
}

async function* filterKeyRange(
	entries: AsyncIterable<JournalEntry>,
	fromKey: string,
	toKey: string,
): AsyncIterable<JournalEntry> {
	for await (const entry of entries)
		if (entry.key !== undefined && entry.key >= fromKey && entry.key < toKey) yield entry;
}

function byRunId(left: { runId: string }, right: { runId: string }): number {
	return left.runId < right.runId ? -1 : 1;
}

/**
 * One logical run journal over a catalog and N SQLite shard files (#4325). Each root run and everything recorded for
 * its descendants lives on the one shard the catalog placed it on, so roots on different shards never wait for the
 * same write lock, and every operation on a run is the shard's own, transactional as a single-file journal is. Lookups
 * resolve any run through the catalog, including runs of adopted journal files, which stay where they are.
 */
export class ShardedRunJournal implements RunJournal {
	readonly [SHARDED_RUN_JOURNAL] = true;
	readonly directory: string;
	private readonly catalog: JournalCatalog;
	private readonly openShardFile: (path: string) => Promise<RunJournal>;
	private readonly shardJournals = new Map<number, Promise<RunJournal>>();
	private readonly located = new Map<string, JournalShardRecord>();
	private readonly unavailable = new Map<number, JournalShardUnavailableError>();
	private readonly pendingStatuses = new Map<string, string>();
	private reconciled = false;
	private statusFailure?: JournalCatalogError;
	private closed = false;
	private tail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;

	private constructor(directory: string, catalog: JournalCatalog, openShard: (path: string) => Promise<RunJournal>) {
		this.directory = directory;
		this.catalog = catalog;
		this.openShardFile = openShard;
	}

	static async open(options: ShardedRunJournalOptions): Promise<ShardedRunJournal> {
		const catalog = await JournalCatalog.open(options.directory, {
			prepareShard: async (path) => (await options.openShard(path)).close(),
		});
		try {
			if (options.legacyJournal !== undefined && options.legacyJournal !== false)
				await discoverLegacyJournal(catalog, options.legacyJournal);
		} catch (error) {
			await catalog.close().catch((cleanupCause: unknown) => {
				Object.defineProperty(error as object, "cleanupCause", { value: cleanupCause, configurable: true });
			});
			throw error;
		}
		return new ShardedRunJournal(catalog.directory, catalog, options.openShard);
	}

	/**
	 * Before this process places its first new root, brings the catalog's status of each root it counts as running up to
	 * the status its own shard saved. A status the catalog could not record before its process ended is lost from
	 * memory, and left alone it would keep an idle shard busy for placement; a root that is still running, or crashed
	 * while running, is unchanged. Processes that only open existing roots, such as pool workers, never do this.
	 */
	private async reconcileStatuses(): Promise<void> {
		if (this.reconciled) return;
		this.reconciled = true;
		for (const run of await this.catalog.busyRuns()) {
			const record = await this.catalog.shard(run.shard);
			const journal = record === undefined ? undefined : await this.listable(record);
			const saved = (await journal?.getRun(run.runId))?.status;
			if (saved === undefined || saved === run.status) continue;
			try {
				await this.catalog.reconcileStatus(run, saved);
			} catch (error) {
				if (!isJournalCatalogError(error)) throw error;
				this.statusFailure = error;
				return;
			}
		}
	}

	get descriptor(): StorageDescriptor {
		return { adapter: "journal-store", location: this.directory };
	}

	/** The catalog's file. */
	get catalogPath(): string {
		return this.catalog.path;
	}

	private assertOpen(): void {
		if (this.closed) throw new StorageUnavailableError(this.descriptor, new JournalClosedError());
	}

	private operation<T>(action: () => Promise<T>): Promise<T> {
		this.assertOpen();
		const result = action();
		this.tail = Promise.all([this.tail, result]).then(
			() => {},
			() => {},
		);
		return result;
	}

	private shardJournal(record: JournalShardRecord, runId?: string): Promise<RunJournal> {
		let opened = this.shardJournals.get(record.id);
		if (opened !== undefined) return opened;
		if (!existsSync(record.path))
			return Promise.reject(
				new JournalShardUnavailableError({
					code: "shard-missing",
					shardId: record.id,
					shardPath: record.path,
					runId,
				}),
			);
		opened = this.openShardFile(record.path).catch((cause: StorageFailureCause) => {
			throw new JournalShardUnavailableError({
				code: "shard-open-failed",
				shardId: record.id,
				shardPath: record.path,
				runId,
				cause,
			});
		});
		this.shardJournals.set(record.id, opened);
		opened.then(
			() => this.unavailable.delete(record.id),
			() => this.shardJournals.delete(record.id),
		);
		return opened;
	}

	/** A shard for a listing: undefined, with the typed reason recorded in `unavailableShards()`, when it cannot open. */
	private async listable(record: JournalShardRecord): Promise<RunJournal | undefined> {
		try {
			return await this.shardJournal(record);
		} catch (error) {
			if (!isJournalShardUnavailableError(error)) throw error;
			this.unavailable.set(record.id, error);
			return undefined;
		}
	}

	/**
	 * The shard holding `runId`: the native shard this process last saw it on, else the catalog's, else an adopted
	 * journal that holds it although the catalog does not list it yet (another process wrote it there), which is then
	 * indexed. A run seen in an adopted journal is looked up again, since a consolidation may have moved it since.
	 */
	private async locate(runId: string): Promise<{ record: JournalShardRecord; journal: RunJournal } | undefined> {
		const cached = this.located.get(runId);
		if (cached?.kind === "native") return { record: cached, journal: await this.shardJournal(cached, runId) };
		const found = await this.catalog.locate(runId);
		if (found !== undefined) {
			const journal = await this.shardJournal(found.shard, runId);
			this.located.set(runId, found.shard);
			return { record: found.shard, journal };
		}
		for (const record of await this.catalog.shards()) {
			if (record.kind !== "adopted") continue;
			const run = await (await this.listable(record))?.getRun(runId);
			if (run === undefined) continue;
			const shard = await this.catalog.shard(await this.catalog.index(record.id, run));
			if (shard === undefined) return undefined;
			this.located.set(runId, shard);
			return { record: shard, journal: await this.shardJournal(shard, runId) };
		}
		return undefined;
	}

	/**
	 * The shard holding a lease's run. A run no shard holds rejects as a single-file journal does, with a stale lease
	 * and no lease epoch, before anything is written: no catalog entry and no shard file are made for it.
	 */
	private async route(lease: Lease): Promise<RunJournal> {
		const located = await this.locate(lease.runId);
		if (located === undefined) throw new StaleLeaseError(lease.runId, lease.epoch, JOURNAL_LEASE.absentEpoch);
		return located.journal;
	}

	/**
	 * Where to ask again after a miss on a run's cached native shard: a move that was undone since deleted the native
	 * copy, so a shard that no longer holds the run at all is replaced by the catalog's current one. A shard that holds
	 * the run and only lacks the key or the lease costs one lookup of the run on that shard, and no catalog read.
	 */
	private async afterMiss(
		runId: string,
		located: { record: JournalShardRecord; journal: RunJournal },
	): Promise<{ record: JournalShardRecord; journal: RunJournal } | undefined> {
		if (located.record.kind !== "native" || (await located.journal.getRun(runId)) !== undefined) return undefined;
		return this.relocated(runId, located.record);
	}

	/** A cached location can go stale when a consolidation moved a finished run: look it up again, once. */
	private async relocated(
		runId: string,
		before: JournalShardRecord,
	): Promise<{ record: JournalShardRecord; journal: RunJournal } | undefined> {
		this.located.delete(runId);
		const now = await this.locate(runId);
		return now !== undefined && now.record.id !== before.id ? now : undefined;
	}

	/**
	 * The journal holding `rootRunId`'s runs, reserving its shard when the root is new: a pool started before its root
	 * is created opens exactly the shard the root will be created on.
	 */
	async journalFor(rootRunId: string): Promise<RunJournal> {
		this.assertOpen();
		validateText("runId", rootRunId);
		return this.operation(async () => {
			const located = await this.locate(rootRunId);
			if (located !== undefined) return located.journal;
			await this.reconcileStatuses();
			const { shard } = await this.catalog.place({ runId: rootRunId });
			this.located.set(rootRunId, shard);
			return this.shardJournal(shard, rootRunId);
		});
	}

	/** The shard this process last placed or found `rootRunId` on. */
	shardOf(rootRunId: string): JournalShardRecord | undefined {
		return this.located.get(rootRunId);
	}

	/** The journal holding an existing root's runs; undefined when the store does not know the root. */
	async existingJournalFor(rootRunId: string): Promise<RunJournal | undefined> {
		this.assertOpen();
		validateText("runId", rootRunId);
		return this.operation(async () => (await this.locate(rootRunId))?.journal);
	}

	/** Shards a listing skipped because they could not be opened, each with its typed reason. */
	unavailableShards(): readonly JournalShardUnavailableError[] {
		return [...this.unavailable.values()];
	}

	/**
	 * Status changes the catalog has not recorded. A checkpoint is committed on its shard before the catalog records the
	 * status it carries; a failed catalog write leaves the checkpoint as it is and is retried with the next change.
	 */
	catalogBacklog(): ShardedRunJournalCatalogBacklog {
		return {
			pending: this.pendingStatuses.size,
			...(this.statusFailure === undefined ? {} : { failure: this.statusFailure }),
		};
	}

	private async recordStatus(runId: string, status: string): Promise<void> {
		this.pendingStatuses.set(runId, status);
		for (const [pendingRun, pendingStatus] of [...this.pendingStatuses]) {
			try {
				await this.catalog.setStatus(pendingRun, pendingStatus);
			} catch (error) {
				if (!isJournalCatalogError(error)) throw error;
				this.statusFailure = error;
				return;
			}
			if (this.pendingStatuses.get(pendingRun) === pendingStatus) this.pendingStatuses.delete(pendingRun);
		}
		this.statusFailure = undefined;
	}

	/** The status a status change carries; the shard has already refused one whose status is not text. */
	private statusOf(event: RunEvent): string | undefined {
		return event.type === RUN_EVENT_TYPES.statusChanged ? (event.payload as { status?: string }).status : undefined;
	}

	async createRun(header: RunHeader): Promise<"created" | "exists"> {
		this.assertOpen();
		validateText("runId", header.runId);
		validateText("name", header.name);
		validateText("cwd", header.cwd);
		validateText("status", header.status);
		const recorded = detached(header);
		if (unserializable(recorded))
			throw new StorageUnavailableError(this.descriptor, recorded.unserializable as StorageFailureCause);
		return this.operation(async () => {
			// A run another writer added to an adopted file since the catalog last indexed it already exists: finding it
			// indexes it, so the reservation below names that file and not a new, empty shard.
			if ((await this.catalog.locate(header.runId)) === undefined && (await this.locate(header.runId)) === undefined)
				await this.reconcileStatuses();
			// The root is reserved first and gets its status once its shard has accepted it: a failure in between leaves
			// a reservation that stops counting as busy, not a running root that does not exist.
			const reserved = await this.catalog.place({ runId: header.runId });
			this.located.set(header.runId, reserved.shard);
			const created = await (await this.shardJournal(reserved.shard, header.runId)).createRun(recorded);
			if (reserved.status === undefined)
				await this.catalog.place({
					runId: header.runId,
					name: header.name,
					cwd: header.cwd,
					status: header.status,
				});
			return created;
		});
	}

	async getRun(runId: string): Promise<RunSummary | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const located = await this.locate(runId);
			if (located === undefined) return undefined;
			const run = await located.journal.getRun(runId);
			if (run !== undefined) return run;
			return (await this.relocated(runId, located.record))?.journal.getRun(runId);
		});
	}

	/**
	 * Every run of every shard, each listed once: from the shard the catalog places it on, or, for a run the catalog
	 * does not list yet, from the first shard that holds it. A shard that cannot be opened is skipped and recorded in
	 * `unavailableShards()`; its runs still fail with the typed reason when they are used.
	 */
	async listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]> {
		this.assertOpen();
		if (filter?.cwd !== undefined) validateText("cwd", filter.cwd);
		return this.operation(async () => {
			const [records, owners] = await Promise.all([this.catalog.shards(), this.catalog.owners()]);
			const listed = new Map<string, RunSummary>();
			for (const record of records) {
				const journal = await this.listable(record);
				if (journal === undefined) continue;
				for (const run of await journal.listRuns(filter)) {
					const owner = owners.get(run.runId);
					if (owner === undefined ? listed.has(run.runId) : owner !== record.id) continue;
					listed.set(run.runId, run);
				}
			}
			return [...listed.values()].sort(byRunId);
		});
	}

	async changeToken(): Promise<string> {
		this.assertOpen();
		return this.operation(async () => {
			const tokens = [await this.catalog.changeToken()];
			for (const record of await this.catalog.shards()) {
				const journal = await this.listable(record);
				tokens.push(
					journal === undefined
						? `unavailable:${this.unavailable.get(record.id)!.code}`
						: ((await journal.changeToken?.()) ?? "untracked"),
				);
			}
			return JSON.stringify(tokens);
		});
	}

	async runVersions(): Promise<ReadonlyMap<string, RunVersion>> {
		this.assertOpen();
		return this.operation(async () => {
			const [records, owners] = await Promise.all([this.catalog.shards(), this.catalog.owners()]);
			const versions = new Map<string, RunVersion>();
			for (const record of records) {
				const journal = await this.listable(record);
				if (journal === undefined) continue;
				const shardVersions =
					(await journal.runVersions?.()) ??
					new Map((await journal.listRuns()).map((run) => [run.runId, { seq: 0, at: 0 }]));
				for (const [runId, version] of shardVersions) {
					const owner = owners.get(runId);
					if (owner === undefined ? versions.has(runId) : owner !== record.id) continue;
					versions.set(runId, version);
				}
			}
			return versions;
		});
	}

	async snapshotTail(runId: string): Promise<RunSnapshotTail | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const located = await this.locate(runId);
			if (located === undefined) return undefined;
			const tail = await located.journal.snapshotTail?.(runId);
			if (tail !== undefined) return tail;
			return (await this.relocated(runId, located.record))?.journal.snapshotTail?.(runId);
		});
	}

	async acquire(runId: string, holderId: string): Promise<LeaseOutcome> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("holderId", holderId);
		return this.operation(async () => {
			return this.leaseOnLocated(runId, (journal) => journal.acquire(runId, holderId));
		});
	}

	/**
	 * A lease operation on the run's shard. A shard that does not hold the run, because a consolidation moved it or
	 * undid its move since this process located it, is asked again once after looking the run up in the catalog.
	 */
	private async leaseOnLocated(
		runId: string,
		operation: (journal: RunJournal) => Promise<LeaseOutcome>,
	): Promise<LeaseOutcome> {
		const located = await this.locate(runId);
		if (located === undefined) throw new RunNotFoundError(runId);
		try {
			return await operation(located.journal);
		} catch (error) {
			if (!(error instanceof RunNotFoundError)) throw error;
			const moved = await this.relocated(runId, located.record);
			if (moved === undefined) throw error;
			return operation(moved.journal);
		}
	}

	async takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("holderId", holderId);
		validateText("expectedHolder", expectedHolder);
		return this.operation(async () => {
			return this.leaseOnLocated(runId, (journal) => journal.takeover(runId, holderId, expectedHolder));
		});
	}

	async takeoverExpired(runId: string, holderId: string, staleAfterMs: number): Promise<LeaseOutcome> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("holderId", holderId);
		return this.operation(async () => {
			return this.leaseOnLocated(runId, (journal) => journal.takeoverExpired(runId, holderId, staleAfterMs));
		});
	}

	async leaseState(runId: string): Promise<LeaseState | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			const located = await this.locate(runId);
			const state = await located?.journal.leaseState(runId);
			if (located === undefined || state !== undefined) return state;
			return (await this.afterMiss(runId, located))?.journal.leaseState(runId);
		});
	}

	async renew(lease: Lease): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(async () => (await this.route(owned)).renew(owned));
	}

	async release(lease: Lease): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(async () => (await this.route(owned)).release(owned));
	}

	async append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		const recorded = { type: event.type, payload: recordedPayload(event.payload) } as RunEvent;
		const settings = { ...options };
		return this.operation(async () => {
			const outcome = await (await this.route(owned)).append(owned, recorded, settings);
			const status = this.statusOf(recorded);
			if (outcome.status === "appended" && status !== undefined) await this.recordStatus(owned.runId, status);
			return outcome;
		});
	}

	async appendMany(
		lease: Lease,
		appends: readonly RunJournalBatchAppend[],
	): Promise<readonly PromiseSettledResult<AppendOutcome>[]> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		const recorded = appends.map((append) => ({
			...append,
			event: { type: append.event.type, payload: recordedPayload(append.event.payload) } as RunEvent,
		}));
		return this.operation(async () => {
			const journal = await this.route(owned);
			const results = journal.appendMany
				? await journal.appendMany(owned, recorded)
				: await Promise.allSettled(
						recorded.map((append) =>
							append.context(() => journal.append(owned, append.event, { key: append.key })),
						),
					);
			let status: string | undefined;
			results.forEach((result, index) => {
				const changed = this.statusOf(recorded[index]!.event);
				if (result.status === "fulfilled" && result.value.status === "appended" && changed !== undefined)
					status = changed;
			});
			if (status !== undefined) await this.recordStatus(owned.runId, status);
			return results;
		});
	}

	/**
	 * A run's entries in order. The shard pages through them, so a consolidation can move the run between two pages: when
	 * the shard's entries end, the catalog is asked again, and a read that finds the run elsewhere continues there with the
	 * next sequence number. A continuation that does not follow on fails with the retryable `run-moved`, never a short read.
	 */
	async *read(runId: string, fromSeq = 1): AsyncIterable<JournalEntry> {
		this.assertOpen();
		validateText("runId", runId);
		let current = await this.operation(() => this.locate(runId));
		let next = fromSeq;
		for (let follows = 0; current !== undefined; follows++) {
			for await (const entry of current.journal.read(runId, next)) {
				this.assertOpen();
				if (follows > 0 && entry.seq !== next) throw this.runMoved(runId, current.record, next - 1);
				next = entry.seq + 1;
				yield entry;
			}
			const from = current.record;
			current = await this.operation(() => this.relocated(runId, from));
			if (current !== undefined && follows + 1 > READ_FOLLOW_LIMIT) throw this.runMoved(runId, from, next - 1);
		}
	}

	/**
	 * A run's events whose key is at least `fromKey` and below `toKey`, read through its shard's key index, so a durable
	 * backend narrows the checkpoints of a root without reading the whole root. A run that moved to another shard while
	 * it was read is read again there, and an event already returned is not returned twice.
	 */
	async *readKeyRange(runId: string, fromKey: string, toKey: string): AsyncIterable<JournalEntry> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("key", fromKey);
		validateText("key", toKey);
		let current = await this.operation(() => this.locate(runId));
		const returned = new Set<number>();
		for (let follows = 0; current !== undefined; follows++) {
			const shard = current.journal;
			const read = journalKeyRangeRead(shard);
			const entries: AsyncIterable<JournalEntry> =
				read === undefined ? filterKeyRange(shard.read(runId), fromKey, toKey) : read(runId, fromKey, toKey);
			for await (const entry of entries) {
				this.assertOpen();
				if (returned.has(entry.seq)) continue;
				returned.add(entry.seq);
				yield entry;
			}
			const from = current.record;
			current = await this.operation(() => this.relocated(runId, from));
			if (current !== undefined && follows + 1 > READ_FOLLOW_LIMIT)
				throw this.runMoved(runId, from, Math.max(0, ...returned));
		}
	}

	private runMoved(runId: string, record: JournalShardRecord, lastSeq: number): JournalCatalogError {
		return new JournalCatalogError({
			code: "run-moved",
			catalogPath: this.catalog.path,
			runId,
			shardId: record.id,
			shardPath: record.path,
			lastSeq,
		});
	}

	async readKey(runId: string, key: string): Promise<JournalEntry | undefined> {
		this.assertOpen();
		validateText("runId", runId);
		validateText("key", key);
		return this.operation(async () => {
			const located = await this.locate(runId);
			const entry = await located?.journal.readKey(runId, key);
			if (located === undefined || entry !== undefined) return entry;
			return (await this.afterMiss(runId, located))?.journal.readKey(runId, key);
		});
	}

	async deleteRun(runId: string): Promise<void> {
		this.assertOpen();
		validateText("runId", runId);
		return this.operation(async () => {
			let located = await this.locate(runId);
			// A consolidation can move the run between finding it and deleting it: its entry then names another shard,
			// so it is deleted there, and the entry that names the copy is never removed while the copy stays.
			for (let follows = 0; located !== undefined; follows++) {
				await located.journal.deleteRun(runId);
				if (await this.catalog.removeFrom(runId, located.record.id)) break;
				const from = located.record;
				located = await this.relocated(runId, from);
				if (located !== undefined && follows + 1 > READ_FOLLOW_LIMIT) throw this.runMoved(runId, from, 0);
			}
			this.located.delete(runId);
		});
	}

	async deleteOwnedRun(lease: Lease, expectSeq?: number): Promise<void> {
		this.assertOpen();
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		const owned = { ...lease };
		return this.operation(async () => {
			await (await this.route(owned)).deleteOwnedRun(owned, expectSeq);
			await this.catalog.remove(owned.runId);
			this.located.delete(owned.runId);
		});
	}

	close(): Promise<void> {
		if (this.closePromise === undefined) {
			this.closed = true;
			this.closePromise = this.tail.then(async () => {
				const journals = await Promise.allSettled([...this.shardJournals.values()]);
				const closing = journals.flatMap((opened) => (opened.status === "fulfilled" ? [opened.value.close()] : []));
				const results = await Promise.allSettled([...closing, this.catalog.close()]);
				const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (failures.length > 1)
					throw new AggregateError(failures, `${failures.length} journal store databases failed to close`);
				if (failures.length === 1) throw failures[0];
			});
		}
		return this.closePromise;
	}
}

/** Whether `journal` is a journal store, in this or another loaded copy of the workflows runtime. */
export function isShardedRunJournal(journal: RunJournal): journal is ShardedRunJournal {
	return (journal as { [SHARDED_RUN_JOURNAL]?: boolean })[SHARDED_RUN_JOURNAL] === true;
}

/**
 * The journal that holds `rootRunId`'s runs and its pool's tables: its shard in a journal store, reserved when the root
 * is new, else `journal` itself.
 */
export async function rootRunJournal(journal: RunJournal, rootRunId: string): Promise<RunJournal> {
	return isShardedRunJournal(journal) ? journal.journalFor(rootRunId) : journal;
}

/** `rootRunJournal` for a reader: never reserves a shard, and falls back to the store when the root is unknown. */
export async function existingRootRunJournal(journal: RunJournal, rootRunId: string): Promise<RunJournal> {
	return isShardedRunJournal(journal) ? ((await journal.existingJournalFor(rootRunId)) ?? journal) : journal;
}
