import { journalCounter, storageBoundary } from "./node-sqlite.js";
import {
	type AppendOutcome,
	JOURNAL_LEASE,
	JournalCasConflictError,
	type JournalEntry,
	type Lease,
	type LeaseOutcome,
	type RunEvent,
	type RunHeader,
	type RunJournal,
	RunNotFoundError,
	type RunSummary,
	StaleLeaseError,
	StorageUnavailableError,
} from "./types.js";
import { serializeJson, validateText } from "./values.js";

interface MemoryRun {
	header: RunHeader;
	entries: JournalEntry[];
}

export class MemoryRunJournal implements RunJournal {
	private readonly runs = new Map<string, MemoryRun>();
	private readonly leases = new Map<string, { holderId: string | null; epoch: number }>();
	private closed = false;

	private ensureOpen(): void {
		if (this.closed) throw new StorageUnavailableError(":memory:", new Error("Journal is closed"));
	}

	async createRun(header: RunHeader): Promise<"created" | "exists"> {
		validateText("runId", header.runId);
		validateText("name", header.name);
		validateText("cwd", header.cwd);
		validateText("status", header.status);
		this.ensureOpen();
		const stored = storageBoundary(":memory:", () => JSON.parse(serializeJson(header)) as RunHeader);
		if (this.runs.has(header.runId)) return "exists";
		this.runs.set(header.runId, { header: stored, entries: [] });
		return "created";
	}

	async listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]> {
		if (filter?.cwd !== undefined) validateText("cwd", filter.cwd);
		this.ensureOpen();
		return [...this.runs.values()]
			.filter((run) => filter?.cwd === undefined || run.header.cwd === filter.cwd)
			.sort((a, b) => Buffer.compare(Buffer.from(a.header.runId), Buffer.from(b.header.runId)))
			.map((run) => JSON.parse(serializeJson(run.header)) as RunSummary);
	}

	private requireRun(runId: string): MemoryRun {
		this.ensureOpen();
		const run = this.runs.get(runId);
		if (!run) throw new RunNotFoundError(runId);
		return run;
	}

	private grant(runId: string, holderId: string): LeaseOutcome {
		const current = this.leases.get(runId);
		const epoch = current
			? journalCounter(runId, "epoch", current.epoch + JOURNAL_LEASE.epochIncrement, "overflow")
			: JOURNAL_LEASE.initialEpoch;
		this.leases.set(runId, { holderId, epoch });
		return { status: "acquired", lease: { runId, holderId, epoch } };
	}

	async acquire(runId: string, holderId: string): Promise<LeaseOutcome> {
		validateText("runId", runId);
		validateText("holderId", holderId);
		this.requireRun(runId);
		const current = this.leases.get(runId);
		if (current?.holderId === holderId)
			return { status: "acquired", lease: { runId, holderId, epoch: current.epoch } };
		if (current && current.holderId !== JOURNAL_LEASE.unheld) return { status: "held", ...current };
		return this.grant(runId, holderId);
	}

	async takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome> {
		validateText("runId", runId);
		validateText("holderId", holderId);
		validateText("expectedHolder", expectedHolder);
		this.requireRun(runId);
		const current = this.leases.get(runId);
		if (current?.holderId !== expectedHolder)
			return {
				status: "held",
				holderId: current?.holderId ?? JOURNAL_LEASE.unheld,
				epoch: current?.epoch ?? JOURNAL_LEASE.absentEpoch,
			};
		return this.grant(runId, holderId);
	}

	private checkLease(lease: Lease): void {
		this.ensureOpen();
		const current = this.leases.get(lease.runId);
		if (current?.holderId !== lease.holderId || current.epoch !== lease.epoch) {
			throw new StaleLeaseError(lease.runId, lease.epoch, current?.epoch ?? JOURNAL_LEASE.absentEpoch);
		}
	}

	async renew(lease: Lease): Promise<void> {
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		this.checkLease(lease);
	}

	async release(lease: Lease): Promise<void> {
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		this.checkLease(lease);
		this.leases.set(lease.runId, { holderId: JOURNAL_LEASE.unheld, epoch: lease.epoch });
	}

	async append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome> {
		validateText("runId", lease.runId);
		validateText("holderId", lease.holderId);
		if (options?.key !== undefined) validateText("key", options.key);
		if (event.type === "StatusChanged") validateText("status", event.payload.status);
		this.checkLease(lease);
		const run = this.requireRun(lease.runId);
		const actualSeq = run.entries.at(-1)?.seq ?? 0;
		if (options?.expectSeq !== undefined && options.expectSeq !== actualSeq) {
			throw new JournalCasConflictError(lease.runId, options.expectSeq, actualSeq);
		}
		if (options?.key !== undefined) {
			const existing = run.entries.find((entry) => entry.key === options.key);
			if (existing) return { status: "exists", entry: this.copyEntry(existing) };
		}
		const seq = journalCounter(lease.runId, "seq", actualSeq + 1, "overflow");
		const payload = storageBoundary(
			":memory:",
			() => JSON.parse(serializeJson(event.payload)) as RunEvent["payload"],
		);
		const entry: JournalEntry = {
			runId: lease.runId,
			seq,
			epoch: lease.epoch,
			...(options?.key === undefined ? {} : { key: options.key }),
			event: { type: event.type, payload } as RunEvent,
			at: Date.now(),
		};
		run.entries.push(entry);
		if (event.type === "StatusChanged") run.header = { ...run.header, status: event.payload.status };
		return { status: "appended", entry: this.copyEntry(entry) };
	}

	private copyEntry(entry: JournalEntry): JournalEntry {
		return {
			...entry,
			event: { type: entry.event.type, payload: JSON.parse(serializeJson(entry.event.payload)) } as RunEvent,
		};
	}

	async *read(runId: string, fromSeq = 1): AsyncIterable<JournalEntry> {
		validateText("runId", runId);
		this.ensureOpen();
		yield* (this.runs.get(runId)?.entries ?? [])
			.filter((entry) => entry.seq >= fromSeq)
			.map((entry) => this.copyEntry(entry));
	}

	async readKey(runId: string, key: string): Promise<JournalEntry | undefined> {
		validateText("runId", runId);
		validateText("key", key);
		this.ensureOpen();
		const entry = this.runs.get(runId)?.entries.find((entry) => entry.key === key);
		return entry ? this.copyEntry(entry) : undefined;
	}

	async deleteRun(runId: string): Promise<void> {
		validateText("runId", runId);
		this.ensureOpen();
		const current = this.leases.get(runId);
		if (current) this.leases.set(runId, { holderId: JOURNAL_LEASE.unheld, epoch: current.epoch });
		this.runs.delete(runId);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
