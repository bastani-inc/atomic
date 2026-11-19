import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { isExtensionCustomState } from "../../packages/coding-agent/src/core/storage/session/session-resume.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionRecordHeader } from "../../packages/coding-agent/src/core/storage/session/types.js";
// Written by main's SqlSessionStore (1a29f40c7d, resume index version 5): the session's entries, the index its
// rebuild from the stored rows saved, and the one its in-memory fold saved when it created the session. The two
// differ in how child records list their keys. `{"__pad": true}` marks a value large enough to be stored in chunks.
import fixture from "../fixtures/resume-index-v5-session.json";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory } from "../helpers/runtime.js";

const PADDING = "x".repeat(1024 * 1024 + 17);
function expand(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if ((value as { __pad?: unknown }).__pad === true) return PADDING;
	if (Array.isArray(value)) return value.map(expand);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
}
const header = fixture.header as SessionRecordHeader;
const entries = fixture.entries.map(expand) as SessionEntry[];
const CHUNKED = 3;

/** The entries whose fields the version-5 index does not carry over in the current format. */
function derivesUpgradedFields(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "system";
	if (entry.type === "custom")
		return (
			isExtensionCustomState(entry.customType) ||
			[
				"atomic.tool-deactivation",
				"codemode-store",
				"event_subscription",
				"event_subscription_processed",
				"event_subscription_child",
				"intercom_released_reply_wait",
				"subagent-child",
				"workflow.run.start",
				"workflow.run.end",
			].includes(entry.customType)
		);
	return ["model_change", "thinking_level_change", "worktree_snapshot"].includes(entry.type);
}

/** Count the rows the resume fold decodes: one per stored entry it projects. */
function countingProjections(database: SqliteDatabase): { database: SqliteDatabase; rows: () => number } {
	let rows = 0;
	const counted = <T extends SqliteRow>(result: T[]): T[] => {
		rows += result.filter((row) => "resume_type" in row).length;
		return result;
	};
	const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => executor.exec(sql),
		run: (sql, ...params) => executor.run(sql, ...params),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const row = await executor.get<T>(sql, ...params);
			if (row !== undefined) counted([row]);
			return row;
		},
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			counted(await executor.all<T>(sql, ...params)),
	});
	const wrapped: SqliteDatabase = {
		readOnly: database.readOnly,
		...wrap(database),
		get descriptor() {
			return database.descriptor;
		},
		...(database.dialect ? { dialect: database.dialect } : {}),
		...(database.supportsJsonbExtract ? { supportsJsonbExtract: () => database.supportsJsonbExtract!() } : {}),
		transaction: (callback, options) => database.transaction((tx) => callback(wrap(tx)), options),
		close: () => database.close(),
	};
	return { database: wrapped, rows: () => rows };
}

type StoredState = Record<string, unknown> & {
	resume?: Record<string, unknown>;
	windowResume?: Record<string, unknown>;
	epoch?: string;
};
async function summaryState(database: SqliteDatabase): Promise<StoredState> {
	const row = await database.get<SqliteRow & { summary_state: string }>(
		"SELECT summary_state FROM session_sessions WHERE id = ?",
		header.id,
	);
	return JSON.parse(row!.summary_state) as StoredState;
}

/** Leave in summary_state only `older`, as main would have saved it, or no index at all. */
async function keepOnly(
	database: SqliteDatabase,
	older: Record<string, unknown> | undefined,
	count = entries.length,
): Promise<void> {
	const { resume: _resume, windowResume: _window, ...state } = await summaryState(database);
	const resume = older && { ...older, epoch: state.epoch, seq: count };
	await database.run(
		"UPDATE session_sessions SET summary_state = ? WHERE id = ?",
		JSON.stringify(resume ? { ...state, resume } : state),
		header.id,
	);
}

/** Open the session as a first resume would; return the resume, the index saved for it and the rows decoded. */
async function firstResume(open: () => Promise<SqliteDatabase>) {
	const { database, rows } = countingProjections(await open());
	const store = await SqlSessionStore.open(database);
	try {
		const resume = await store.readResume(header.id, undefined, { deferChildRecords: true });
		const state = await summaryState(database);
		return { resume, index: state.windowResume ?? state.resume, older: state.resume, rows: rows() };
	} finally {
		await store.close();
	}
}

async function upgradeMatchesRebuild(
	open: () => Promise<SqliteDatabase>,
	older: Record<string, unknown>,
	session: readonly SessionEntry[] = entries,
) {
	const database = await open();
	const store = await SqlSessionStore.open(database);
	try {
		await store.create(header, [...session]);
	} finally {
		await store.close();
	}
	await keepOnly(database, older, session.length);
	const upgraded = await firstResume(open);
	await keepOnly(database, undefined, session.length);
	const rebuilt = await firstResume(open);

	assert.deepEqual(upgraded.resume, rebuilt.resume);
	assert.deepEqual(upgraded.index, rebuilt.index);
	assert.equal(upgraded.older?.version, 5, "an older client's own index stays in place");
	const sources = session.filter(derivesUpgradedFields).length;
	assert.ok(rebuilt.rows >= session.length, `a rebuild decodes every entry (${rebuilt.rows})`);
	assert.ok(
		upgraded.rows <= sources + CHUNKED,
		`the upgrade decoded ${upgraded.rows} rows; ${sources} entries derive its fields and ${CHUNKED} are chunked`,
	);
	return upgraded;
}

// Two entries an extension saved with `pi.appendEntry` after the fixture's last entry, on its branch; the second is
// stored in chunks. main's index of that session differs from the fixture's only in where it ends: extension entries
// are history, not branch state.
const extended: SessionEntry[] = [
	...entries,
	...["x1", "x2"].map(
		(id, i) =>
			({
				type: "custom",
				customType: "todo-extension",
				id,
				parentId: i === 0 ? entries.at(-1)!.id : "x1",
				timestamp: header.createdAt,
				data: { todos: [i === 0 ? id : PADDING] },
			}) as SessionEntry,
	),
];
const olderOfExtended = { ...fixture.rebuilt, lastId: "x2", leafSeq: extended.length };

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
});

describe("first resume after an upgrade from a version-5 index (#5554)", () => {
	for (const provenance of ["rebuilt", "created"] as const) {
		it(`upgrades main's ${provenance} index from the state entries alone, exactly as a full rebuild`, async () => {
			const directory = makeTempDirectory("atomic-resume-upgrade-");
			directories.push(directory);
			const path = join(directory, "sessions.sqlite");
			const opened: SqliteDatabase[] = [];
			try {
				await upgradeMatchesRebuild(async () => {
					const database = await openNodeSqliteDatabase(path);
					opened.push(database);
					return database;
				}, fixture[provenance]);
			} finally {
				for (const database of opened) await database.close();
			}
		});
	}

	// An index saved before the extension-state field (#5500) does not list those entries. The upgrade lists them as a
	// rebuild does, so a subagent fork reads them from the index instead of scanning the retired conversation.
	it("lists the extension state an index from before that field leaves out", async () => {
		const directory = makeTempDirectory("atomic-resume-upgrade-");
		directories.push(directory);
		const path = join(directory, "sessions.sqlite");
		const opened: SqliteDatabase[] = [];
		try {
			const upgraded = await upgradeMatchesRebuild(
				async () => {
					const database = await openNodeSqliteDatabase(path);
					opened.push(database);
					return database;
				},
				olderOfExtended,
				extended,
			);
			assert.deepEqual(upgraded.index?.extensionState, [entries.length + 1, entries.length + 2]);
		} finally {
			for (const database of opened) await database.close();
		}
	});

	it("publishes no upgrade of a cut another writer extended while it read", async () => {
		const directory = makeTempDirectory("atomic-resume-upgrade-");
		directories.push(directory);
		const path = join(directory, "sessions.sqlite");
		const opened: SqliteDatabase[] = [];
		const open = async () => {
			const database = await openNodeSqliteDatabase(path);
			opened.push(database);
			return database;
		};
		try {
			const setup = await open();
			const created = await SqlSessionStore.open(setup);
			await created.create(header, entries);
			await created.close();
			await keepOnly(setup, fixture.rebuilt);
			const extra = {
				type: "message",
				id: "appended",
				parentId: entries.at(-1)!.id,
				timestamp: header.createdAt,
				message: { role: "user", content: "appended while the upgrade read", timestamp: 1 },
			} as SessionEntry;
			const writer = await SqlSessionStore.open(await open());
			const reader = await open();
			const all = reader.all.bind(reader);
			let appended = false;
			reader.all = async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const rows = await all<T>(sql, ...params);
				if (!appended && rows.some((row) => "resume_type" in row)) {
					appended = true;
					await writer.append(header.id, [extra], { expectSeq: entries.length });
				}
				return rows;
			};
			const store = await SqlSessionStore.open(reader);
			const resume = await store.readResume(header.id, undefined, { deferChildRecords: true });
			await store.close();
			await writer.close();
			assert.ok(appended);
			assert.equal(resume.lastSeq, entries.length + 1);
			assert.equal(resume.lastEntryId, extra.id);
			const state = await summaryState(setup);
			assert.equal((state.windowResume ?? state.resume)?.seq, entries.length + 1);

			await keepOnly(setup, undefined);
			const rebuilt = await firstResume(open);
			assert.deepEqual(resume, rebuilt.resume);
		} finally {
			for (const database of opened) await database.close();
		}
	});

	it.skipIf(postgresSkipReason !== undefined)("upgrades the same way on Postgres", async () => {
		await withPostgresDatabase(({ open }) => upgradeMatchesRebuild(() => open(), fixture.rebuilt));
		await withPostgresDatabase(({ open }) => upgradeMatchesRebuild(() => open(), olderOfExtended, extended));
	});
});
