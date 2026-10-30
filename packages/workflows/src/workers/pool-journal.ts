import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type AdapterOptions, type StorageSelection, storageSelectionKey } from "@bastani/atomic/storage";
import { sqlPoolStorage } from "../durable/journal/internal.js";
import "../durable/journal/workflows-host-module.js";
import { openSelectedRunJournal, resolveRunJournal, runJournalOrigin } from "../durable/journal/resolution.js";
import { SqlRunJournal } from "../durable/journal/sql-run-journal.js";
import type { RunJournal } from "../durable/journal/types.js";

/**
 * Where a root's durable journal lives when it is not the local SQLite file the pool shares (an adapter, such as a
 * libSQL or Turso database), in a form every pool process can open again. It carries no secret value: an adapter's
 * `secrets` are references to environment variables or files, which each process resolves for itself.
 */
export interface PoolDurableJournal {
	/** The journal's storage selection, as JSON (see {@link encodeSelection}). */
	readonly selection: string;
	/** The agent directory the root resolved the selection against. */
	readonly agentDir: string;
}

/** A {@link PoolDurableJournal} the pool's processes get through the environment, never through argv. */
export const POOL_DURABLE_JOURNAL_ENV = "ATOMIC_POOL_DURABLE_JOURNAL";

type DurableSelection = Extract<StorageSelection, { kind: "sqlite" | "adapter" }>;
type EncodedValue = string | number | boolean | null | { readonly $bigint: string } | { readonly $bytes: string };

function encodeOption(value: AdapterOptions[string]): EncodedValue {
	if (typeof value === "bigint") return { $bigint: value.toString() };
	if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
	return value;
}

function decodeOption(value: EncodedValue): AdapterOptions[string] {
	if (value !== null && typeof value === "object") {
		if ("$bigint" in value) return BigInt(value.$bigint);
		return new Uint8Array(Buffer.from(value.$bytes, "base64"));
	}
	return value;
}

/** Whether another process can open a journal chosen with `selection` by its own means. */
export function isReopenableSelection(selection: StorageSelection): selection is DurableSelection {
	return selection.kind === "sqlite" || selection.kind === "adapter";
}

export function encodeSelection(selection: DurableSelection): string {
	// A relative path names the same file to every process only against the root's working directory.
	if (selection.kind === "sqlite") return JSON.stringify({ ...selection, path: resolve(selection.path) });
	return JSON.stringify({
		...selection,
		...(selection.options === undefined
			? {}
			: {
					options: Object.fromEntries(
						Object.entries(selection.options).map(([key, value]) => [key, encodeOption(value)]),
					),
				}),
	});
}

export function decodeSelection(text: string): DurableSelection {
	const value = JSON.parse(text) as {
		readonly kind: string;
		readonly options?: Readonly<Record<string, EncodedValue>>;
	};
	if (value.kind === "sqlite" || value.options === undefined) return value as DurableSelection;
	return {
		...value,
		options: Object.fromEntries(Object.entries(value.options).map(([key, option]) => [key, decodeOption(option)])),
	} as DurableSelection;
}

/**
 * Whether the pool shares `journal`'s own database: a default-prefix SQLite file every pool process opens by path. Any
 * other journal is a durable journal in another database, whose pool state lives in a coordination database.
 */
export function isLocalPoolJournal(journal: RunJournal): journal is SqlRunJournal {
	return (
		journal instanceof SqlRunJournal &&
		journal.descriptor.adapter === "node-sqlite" &&
		journal.path !== ":memory:" &&
		sqlPoolStorage(journal)?.tables.runs === "wf_runs"
	);
}

/**
 * How pool processes reach the durable journal of a root whose journal is not a local SQLite file they open by path;
 * an error when no other process can open it.
 */
export function poolDurableJournal(journal: RunJournal): PoolDurableJournal {
	const origin = runJournalOrigin(journal);
	if (origin === undefined)
		throw new Error(
			"Local workers cannot reopen a journal passed as an object; select the journal with workflows.journal, --storage or ATOMIC_WORKFLOWS_JOURNAL so every worker process can open it",
		);
	if (!isReopenableSelection(origin.selection))
		throw new Error(
			`Local workers need a journal their processes can open by selection, a SQLite file or a storage adapter, not ${origin.selection.kind}`,
		);
	return { selection: encodeSelection(origin.selection), agentDir: origin.agentDir };
}

export function openDurableJournal(durable: PoolDurableJournal): Promise<RunJournal> {
	return openSelectedRunJournal(decodeSelection(durable.selection), durable.agentDir);
}

/** The directory of machine-local pool state, beside the default journal: `<agent dir's parent>/workflows/pool`. */
export function poolStateDirectory(agentDir: string): string {
	return join(dirname(agentDir), "workflows", "pool");
}

/**
 * The local SQLite database holding the work queue, leases, usage, admission permits and pooled-stage sessions of every
 * root whose durable journal is `durable`, on this machine. It belongs to the journal's identity, not to one root, so
 * a root resumed on this machine reopens it.
 */
export function coordinationPath(durable: PoolDurableJournal): string {
	const selection = decodeSelection(durable.selection);
	const identity = createHash("sha256").update(storageSelectionKey(selection, durable.agentDir)).digest("hex");
	return join(poolStateDirectory(durable.agentDir), `${identity.slice(0, 24)}.sqlite`);
}

const coordinationJournals = new Map<string, Promise<RunJournal>>();

/**
 * Opens (creating it) the local SQLite database at `path` as a journal, which hosts the pool's tables. A process keeps
 * one connection per database for every root it runs.
 */
export function openCoordinationJournal(path: string): Promise<RunJournal> {
	const file = resolve(path);
	let opened = coordinationJournals.get(file);
	if (opened === undefined) {
		mkdirSync(dirname(file), { recursive: true });
		opened = resolveRunJournal({ journal: { path: file } });
		coordinationJournals.set(file, opened);
		opened.catch(() => {
			if (coordinationJournals.get(file) === opened) coordinationJournals.delete(file);
		});
	}
	return opened;
}

/** Closes the coordination databases this process opened, for a process that is done with its pools. */
export async function closeCoordinationJournals(): Promise<void> {
	const all = [...coordinationJournals.values()];
	coordinationJournals.clear();
	await Promise.all(all.map((journal) => journal.then((opened) => opened.close()).catch(() => {})));
}

const coordinations = new WeakMap<RunJournal, RunJournal>();

/** Makes `coordination` the journal that holds the pool tables of runs in `durable`. */
export function registerPoolJournal(durable: RunJournal, coordination: RunJournal): void {
	coordinations.set(durable, coordination);
}

/**
 * The journal holding a durable journal's pool tables: the one registered for a journal in another database, else the
 * journal itself, whose own SQLite file hosts them.
 */
export function poolJournalFor(journal: RunJournal): RunJournal {
	return coordinations.get(journal) ?? journal;
}

/**
 * This machine's identity for pool state: a random id kept in the pool state directory. A root records it when it
 * first runs a pool against a journal in another database, so a resume elsewhere can say its pool state is not here.
 */
export function poolHostId(agentDir: string): string {
	const file = join(poolStateDirectory(agentDir), "host-id");
	try {
		const existing = readFileSync(file, "utf8").trim();
		if (existing !== "") return existing;
	} catch {}
	mkdirSync(dirname(file), { recursive: true });
	const id = randomUUID();
	try {
		writeFileSync(file, `${id}\n`, { flag: "wx" });
		return id;
	} catch {
		return readFileSync(file, "utf8").trim();
	}
}

/**
 * The journal holding `journal`'s pool tables, for a reader that is not itself running a pool (a finished pooled
 * stage's transcript, opened later): the coordination journal registered for it, else the one this machine kept for
 * its durable journal if that exists, else the journal itself.
 */
export async function poolJournalOf(journal: RunJournal): Promise<RunJournal> {
	const registered = coordinations.get(journal);
	if (registered !== undefined || isLocalPoolJournal(journal)) return registered ?? journal;
	const origin = runJournalOrigin(journal);
	if (origin === undefined || !isReopenableSelection(origin.selection)) return journal;
	const path = coordinationPath(poolDurableJournal(journal));
	if (!existsSync(path)) return journal;
	const coordination = await openCoordinationJournal(path);
	registerPoolJournal(journal, coordination);
	return coordination;
}
