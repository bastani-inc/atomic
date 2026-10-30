import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StorageSelection } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSelectedRunJournal, resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	closeCoordinationJournals,
	coordinationPath,
	decodeSelection,
	encodeSelection,
	isLocalPoolJournal,
	openCoordinationJournal,
	poolDurableJournal,
	poolHostId,
	poolJournalFor,
	poolJournalOf,
	registerPoolJournal,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const adapter = fileURLToPath(new URL("../fixtures/delegating-run-journal-adapter.mjs", import.meta.url));
const libsqlAdapter = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));

afterEach(async () => {
	await closeCoordinationJournals();
});

test("an adapter selection reaches another process unchanged, binary and bigint options included", () => {
	const selection: Extract<StorageSelection, { kind: "adapter" }> = {
		kind: "adapter",
		module: "@acme/storage",
		options: {
			url: "libsql://db.example",
			retries: 3,
			big: 12345678901234567890n,
			bytes: new Uint8Array([0, 1, 254, 255]),
			secure: true,
			none: null,
		},
		secrets: { authToken: { env: "ACME_TOKEN" }, certificate: { file: "certs/acme.pem" } },
		prefix: "wf_",
	};
	const text = encodeSelection(selection);
	assert.deepEqual(decodeSelection(text), selection);
	assert.doesNotMatch(text, /ACME_SECRET/, "a secret is a reference to the environment or a file, never a value");
});

test("a local SQLite selection is sent as an absolute path", () => {
	const text = encodeSelection({ kind: "sqlite", path: "journal.sqlite", prefix: "x_" });
	assert.deepEqual(decodeSelection(text), { kind: "sqlite", path: resolve("journal.sqlite"), prefix: "x_" });
});

test("only journals another process can open by selection get a pool, and the ones that cannot say why", async () => {
	const directory = makeTempDirectory("pool-journal-selection-");
	try {
		const agentDir = join(directory, "home", "agent");
		await assert.rejects(
			Promise.resolve().then(() => poolDurableJournal(new MemoryRunJournal())),
			/cannot reopen a journal passed as an object/,
		);
		const memory = await openSelectedRunJournal({ kind: "memory" }, agentDir);
		assert.throws(() => poolDurableJournal(memory), /not memory/);
		const remote = await resolveRunJournal({
			agentDir,
			journal: { adapter, options: { path: join(directory, "r.sqlite") } },
		});
		try {
			const durable = poolDurableJournal(remote);
			assert.equal(durable.agentDir, agentDir);
			assert.equal(decodeSelection(durable.selection).kind, "adapter");
		} finally {
			await remote.close();
		}
	} finally {
		removeTempDirectory(directory);
	}
});

test("the pool shares a default-prefix SQLite file as it is, and every other journal gets a coordination database", async () => {
	// A libSQL file cannot be deleted on Windows until its native handles are collected.
	const directory = makeLibsqlDirectory();
	try {
		const agentDir = join(directory, "home", "agent");
		const local = await resolveRunJournal({ agentDir, journal: { path: join(directory, "journal.sqlite") } });
		const prefixed = await resolveRunJournal({
			agentDir,
			journal: { path: join(directory, "prefixed.sqlite"), prefix: "x_" },
		});
		const remote = await resolveRunJournal({
			agentDir,
			journal: { adapter, options: { path: join(directory, "r.sqlite") } },
		});
		// The shipped libSQL adapter: a SQL journal with the default tables whose driver is not node:sqlite, so its file
		// path means nothing to another process the way a local SQLite path does.
		const libsql = await resolveRunJournal({
			agentDir,
			journal: { adapter: libsqlAdapter, options: { url: pathToFileURL(join(directory, "libsql.sqlite")).href } },
		});
		try {
			assert.equal(sqlPoolStorage(libsql)?.tables.runs, "wf_runs");
			assert.equal(isLocalPoolJournal(libsql), false);
			assert.deepEqual(
				{ ...decodeSelection(poolDurableJournal(libsql).selection), module: undefined },
				{
					kind: "adapter",
					module: undefined,
					options: { url: pathToFileURL(join(directory, "libsql.sqlite")).href },
				},
			);
			assert.equal(isLocalPoolJournal(local), true);
			assert.equal(isLocalPoolJournal(prefixed), false);
			assert.equal(isLocalPoolJournal(remote), false);
			assert.equal(isLocalPoolJournal(new MemoryRunJournal()), false);
			assert.equal(isLocalPoolJournal(await resolveRunJournal({ agentDir, journal: { memory: true } })), false);
		} finally {
			await Promise.all([local.close(), prefixed.close(), remote.close(), libsql.close()]);
		}
	} finally {
		await removeLibsqlDirectory(directory);
	}
});

test("a journal's coordination database is the same on this machine every time, and its own for each selection", () => {
	const agentDir = join("/tmp", "pool-home", "agent");
	const select = (options: Record<string, string>, prefix?: string) => ({
		agentDir,
		selection: encodeSelection({ kind: "adapter", module: "@acme/storage", options, ...(prefix ? { prefix } : {}) }),
	});
	const first = coordinationPath(select({ url: "libsql://a" }));
	assert.equal(first, coordinationPath(select({ url: "libsql://a" })));
	assert.ok(first.startsWith(join("/tmp", "pool-home", "workflows", "pool")), first);
	assert.match(first, /\.sqlite$/);
	// A credential reference names where a secret is read from, not which database it opens: renaming it keeps the database.
	const withToken = (env: string) => ({
		agentDir,
		selection: encodeSelection({
			kind: "adapter",
			module: "@acme/storage",
			options: { url: "libsql://a" },
			secrets: { authToken: { env } },
		}),
	});
	assert.equal(coordinationPath(withToken("ACME_TOKEN")), coordinationPath(withToken("ACME_TOKEN_RENAMED")));
	assert.equal(coordinationPath(withToken("ACME_TOKEN")), first);
	assert.notEqual(first, coordinationPath(select({ url: "libsql://b" })));
	assert.notEqual(first, coordinationPath(select({ url: "libsql://a" }, "other_")));
	assert.notEqual(
		first,
		coordinationPath({ ...select({ url: "libsql://a" }), agentDir: join("/tmp", "elsewhere", "agent") }),
	);
});

test("this machine's pool identity is made once and kept", () => {
	const directory = makeTempDirectory("pool-host-id-");
	try {
		const agentDir = join(directory, "home", "agent");
		const id = poolHostId(agentDir);
		assert.match(id, /^[0-9a-f-]{36}$/);
		assert.equal(poolHostId(agentDir), id);
		assert.notEqual(poolHostId(join(directory, "other", "agent")), id);
	} finally {
		removeTempDirectory(directory);
	}
});

test("a journal in another database finds the coordination database this machine kept for it, only if there is one", async () => {
	const directory = makeTempDirectory("pool-journal-of-");
	try {
		const agentDir = join(directory, "home", "agent");
		const remote = await resolveRunJournal({
			agentDir,
			journal: { adapter, options: { path: join(directory, "r.sqlite") } },
		});
		try {
			// No pool ever ran against it here: the journal answers for itself.
			assert.equal(await poolJournalOf(remote), remote);
			assert.equal(poolJournalFor(remote), remote);
			const path = coordinationPath(poolDurableJournal(remote));
			assert.equal(existsSync(path), false);
			const coordination = await openCoordinationJournal(path);
			assert.equal(await openCoordinationJournal(path), coordination, "a process keeps one connection per database");
			assert.equal(await poolJournalOf(remote), coordination);
			assert.equal(poolJournalFor(remote), coordination, "the lookup is remembered");
		} finally {
			await remote.close();
		}
		// A journal registered by a running pool wins, and a local file is its own pool database.
		const local = await openSqlRunJournal(join(directory, "local.sqlite"));
		try {
			assert.equal(await poolJournalOf(local), local);
			const other = new MemoryRunJournal();
			registerPoolJournal(other, local);
			assert.equal(poolJournalFor(other), local);
		} finally {
			await local.close();
		}
	} finally {
		// The coordination database is cached for the process; Windows cannot delete it while it is open.
		await closeCoordinationJournals();
		removeTempDirectory(directory);
	}
});
