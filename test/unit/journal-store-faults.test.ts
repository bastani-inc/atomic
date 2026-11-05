import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { closeEach, withCleanup } from "../../packages/coding-agent/src/core/storage/cleanup.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Failures injected into the storage layer's SQLite connections, by database path. */
const faults = vi.hoisted(() => ({ open: new Map<string, Error>(), close: new Map<string, Error>() }));

vi.mock("../../packages/coding-agent/src/core/storage/node-sqlite.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../packages/coding-agent/src/core/storage/node-sqlite.js")>();
	return {
		...original,
		openNodeSqliteDatabase: async (...args: Parameters<typeof original.openNodeSqliteDatabase>) => {
			const [path] = args;
			const refused = faults.open.get(path);
			if (refused !== undefined) throw refused;
			const database = await original.openNodeSqliteDatabase(...args);
			const closeFailure = faults.close.get(path);
			if (closeFailure === undefined) return database;
			return new Proxy(database, {
				get(target, property) {
					if (property === "close")
						return async () => {
							await target.close();
							throw closeFailure;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});

type Storage = typeof import("@bastani/atomic/storage");
let adoptJournals: Storage["adoptJournals"];
let discoverLegacyJournal: Storage["discoverLegacyJournal"];
let inspectJournalFile: Storage["inspectJournalFile"];
let isJournalAdoptError: Storage["isJournalAdoptError"];
let isJournalCatalogError: Storage["isJournalCatalogError"];
let JournalCatalog: Storage["JournalCatalog"];
beforeAll(async () => {
	// The setup files loaded the storage layer before this file's mock; load it again so it opens through the mock.
	vi.resetModules();
	({
		adoptJournals,
		discoverLegacyJournal,
		inspectJournalFile,
		isJournalAdoptError,
		isJournalCatalogError,
		JournalCatalog,
	} = await import("@bastani/atomic/storage"));
});

let root: string;
let store: string;
beforeEach(() => {
	root = makeTempDirectory("journal-store-faults-");
	store = join(root, "journal");
});
afterEach(() => {
	faults.open.clear();
	faults.close.clear();
	removeTempDirectory(root);
});

function sqlite(path: string, sql: string): void {
	const database = new DatabaseSync(path);
	try {
		database.exec(sql);
	} finally {
		database.close();
	}
}

async function journalFile(path: string): Promise<string> {
	mkdirSync(join(path, ".."), { recursive: true });
	const sql = await openSqlRunJournal(path);
	await sql.createRun({ runId: "run", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await sql.close();
	return path;
}

test("a journal that passes the header check but cannot be opened is refused as not SQLite, with the cause (#4325)", async () => {
	const path = await journalFile(join(root, "old", "journal.sqlite"));
	const cause = new Error("unable to open database file");
	faults.open.set(path, cause);
	const refused = await inspectJournalFile(path).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused));
	assert.deepEqual([refused.code, refused.reason, refused.cause], ["not-a-journal", "not-sqlite", cause]);
});

test("an inspection that fails keeps its error when closing the file fails too (#4325)", async () => {
	const path = join(root, "notes.sqlite");
	sqlite(path, "CREATE TABLE notes(id TEXT)");
	const closeFailure = new Error("close failed");
	faults.close.set(path, closeFailure);
	const refused = await inspectJournalFile(path).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused));
	assert.equal(refused.reason, "no-journal-tables");
	assert.equal((refused as Error & { cleanupCause?: unknown }).cleanupCause, closeFailure);
});

test("legacy discovery fails with a storage failure while inspecting, and records no skip for it (#4325)", async () => {
	const legacy = await journalFile(join(root, "journal.sqlite"));
	const closeFailure = new Error("close failed");
	faults.close.set(legacy, closeFailure);
	const catalog = await JournalCatalog.open(store);
	try {
		await assert.rejects(discoverLegacyJournal(catalog, legacy), (error: Error) => error === closeFailure);
		assert.deepEqual(await catalog.discoveries(), []);
	} finally {
		await catalog.close();
	}
});

test("a catalog that fails to open keeps its failure and carries a failed close as its cleanup cause (#4325)", async () => {
	mkdirSync(store, { recursive: true });
	const path = join(store, "catalog.sqlite");
	sqlite(path, "CREATE TABLE catalog_runs(unrelated TEXT)");
	const closeFailure = new Error("close failed");
	faults.close.set(path, closeFailure);
	const refused = await JournalCatalog.open(store).catch((error: Error) => error);
	assert.ok(isJournalCatalogError(refused));
	assert.deepEqual([refused.code, refused.fields.phase], ["catalog-unavailable", "opening"]);
	assert.deepEqual(Object.getOwnPropertyDescriptor(refused, "cleanupCause"), {
		value: closeFailure,
		configurable: true,
		enumerable: false,
		writable: false,
	});
});

test("adoption keeps its own failure when closing the catalog fails too (#4325)", async () => {
	await (await JournalCatalog.open(store)).close();
	const closeFailure = new Error("close failed");
	faults.close.set(join(store, "catalog.sqlite"), closeFailure);
	const refused = await adoptJournals(store, [join(root, "absent.sqlite")]).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused) && refused.code === "path-not-found");
	assert.equal((refused as Error & { cleanupCause?: unknown }).cleanupCause, closeFailure);
});

test("cleanup runs once after the body; a failed cleanup is the error only when the body succeeded (#4325)", async () => {
	const order: string[] = [];
	assert.equal(
		await withCleanup(
			async () => {
				order.push("body");
				return 7;
			},
			async () => {
				order.push("cleanup");
			},
		),
		7,
	);
	assert.deepEqual(order, ["body", "cleanup"]);
	const bodyFailure = new Error("body failed");
	const cleanupFailure = new Error("cleanup failed");
	const both = await withCleanup(
		async () => {
			throw bodyFailure;
		},
		async () => {
			throw cleanupFailure;
		},
	).catch((error: Error) => error);
	assert.equal(both, bodyFailure);
	assert.equal((both as Error & { cleanupCause?: unknown }).cleanupCause, cleanupFailure);
	let cleaned = 0;
	const bodyOnly = await withCleanup(
		async () => {
			throw bodyFailure;
		},
		async () => {
			cleaned++;
		},
	).catch((error: Error) => error);
	assert.deepEqual([bodyOnly, cleaned], [bodyFailure, 1]);
	await assert.rejects(
		withCleanup(
			async () => 1,
			async () => {
				throw cleanupFailure;
			},
		),
		(error: Error) => error === cleanupFailure,
	);
});

test("closing several databases closes all of them and reports every failure (#4325)", async () => {
	const closed: string[] = [];
	const database = (name: string, failure?: Error) => ({
		async close() {
			closed.push(name);
			if (failure !== undefined) throw failure;
		},
	});
	await closeEach([database("a"), database("b")]);
	assert.deepEqual(closed, ["a", "b"]);
	const first = new Error("first");
	await assert.rejects(closeEach([database("c", first), database("d")]), (error: Error) => error === first);
	const second = new Error("second");
	await assert.rejects(closeEach([database("e", first), database("f", second)]), (error: Error) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [first, second]);
		assert.equal(error.message, "2 journal store databases failed to close");
		return true;
	});
	assert.deepEqual(closed, ["a", "b", "c", "d", "e", "f"]);
});
