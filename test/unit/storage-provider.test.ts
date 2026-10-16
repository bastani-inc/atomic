import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	openNodeSqliteDatabase,
	StorageAdapterLoadError,
	StorageConfigError,
	StoragePrefixError,
	StorageProvider,
	StorageSchemaVersionError,
	type StorageSelection,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { test } from "vitest";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	fileExists,
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

test("provider shares a persistent database across domain prefixes until both stores close", async () => {
	const root = makeTempDirectory("storage-provider-");
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	const selection = { kind: "sqlite", path: join(root, "shared.sqlite") } as const;
	const context = { agentDir: root };
	try {
		const [sessions, journal] = await Promise.all([
			provider.openSessionStore(selection, { ...context, domain: "sessions" }),
			provider.openRunJournal({ ...selection, prefix: "journal_" }, { ...context, domain: "journal" }),
		]);
		await sessions.close();
		await sessions.close();
		await journal.createRun({ runId: "run", name: "test", cwd: root, createdAt: 1, status: "running" });
		assert.equal((await journal.getRun("run"))?.runId, "run");
		await journal.close();
	} finally {
		removeTempDirectory(root);
	}
});

test("module adapter resolves secrets verbatim and shares one connection between domain stores", async () => {
	const root = makeTempDirectory("storage-adapter-");
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	const path = join(root, "adapter.sqlite");
	const lifecycle = join(root, "lifecycle.txt");
	await writeFileEnsuringDir(join(root, "secret.txt"), " secret with newline\n");
	const selection = {
		kind: "adapter",
		module: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
		options: { path, lifecycle, token: "overwritten", empty: "", enabled: false },
		secrets: { token: { file: "secret.txt" }, environment: { env: "PATH" }, ["__proto__"]: { env: "PATH" } },
		prefix: "custom_",
	} as const;
	try {
		const context = { agentDir: join(root, "agent") };
		const [sessions, journal] = await Promise.all([
			provider.openSessionStore(selection, { ...context, domain: "sessions" }),
			provider.openRunJournal({ ...selection, prefix: "journal_" }, { ...context, domain: "journal" }),
		]);
		assert.equal(await readText(lifecycle), "open\n");
		const probe = await openNodeSqliteDatabase(path);
		try {
			const rows = await probe.all("SELECT options FROM adapter_probe");
			assert.equal(rows.length, 1);
			assert.deepEqual(JSON.parse(String(rows[0]!.options)), {
				...selection.options,
				token: " secret with newline\n",
				environment: process.env.PATH,
				["__proto__"]: process.env.PATH,
			});
		} finally {
			await probe.close();
		}
		await sessions.close();
		assert.equal(await readText(lifecycle), "open\n");
		await journal.createRun({ runId: "adapter", name: "adapter", cwd: root, createdAt: 1, status: "running" });
		await journal.close();
		await journal.close();
		assert.equal(await readText(lifecycle), "open\nclose\n");
	} finally {
		removeTempDirectory(root);
	}
});

test("domain hooks take priority and unsupported or invalid modules fail with typed errors", async () => {
	const root = makeTempDirectory("storage-domain-");
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	const module = join(moduleDir(import.meta.url), "../fixtures/storage-domain-adapter.ts");
	try {
		const journal = await provider.openRunJournal({ kind: "adapter", module }, { agentDir: root, domain: "journal" });
		const sessions = await provider.openSessionStore(
			{ kind: "adapter", module },
			{ agentDir: root, domain: "sessions" },
		);
		assert.deepEqual(await journal.listRuns(), []);
		assert.equal(sessions.descriptor.adapter, "memory");
		await journal.close();
		await sessions.close();
		await assert.rejects(
			() =>
				provider.openRunJournal(
					{
						kind: "adapter",
						module: join(moduleDir(import.meta.url), "../fixtures/storage-unsupported-adapter.ts"),
					},
					{ agentDir: root, domain: "journal" },
				),
			(error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.reason, "adapter-domain-unsupported");
				return true;
			},
		);
		const badModule = join(root, "bad.mjs");
		await writeFileEnsuringDir(badModule, "export default { atomicStorageAdapter: 2 };\n");
		for (const specifier of [badModule, join(root, "missing.mjs")]) {
			await assert.rejects(
				() =>
					provider.openRunJournal({ kind: "adapter", module: specifier }, { agentDir: root, domain: "journal" }),
				(error: Error) => {
					assert.ok(error instanceof StorageAdapterLoadError);
					assert.equal(error.module, specifier);
					assert.ok(error.cause);
					return true;
				},
			);
		}
	} finally {
		removeTempDirectory(root);
	}
});

test("caller-owned facade stays open after both domain stores close", async () => {
	const root = makeTempDirectory("storage-borrowed-");
	const database = await openNodeSqliteDatabase(join(root, "borrowed.sqlite"));
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	try {
		const selection = { kind: "database", database, prefix: "owned_" } as const;
		const sessions = await provider.openSessionStore(selection, { agentDir: root, domain: "sessions" });
		const journal = await provider.openRunJournal(selection, { agentDir: root, domain: "journal" });
		await sessions.close();
		await journal.close();
		assert.equal((await database.get("SELECT schema_version FROM owned_wf_meta"))?.schema_version, 1);
		assert.equal((await database.get("SELECT schema_version FROM owned_session_meta"))?.schema_version, 1);
	} finally {
		await database.close();
		removeTempDirectory(root);
	}
});

test("opening failures never construct a memory journal and missing secrets fail before adapter invocation", async () => {
	const root = makeTempDirectory("storage-failure-");
	let memoryConstructed = 0;
	const provider = new StorageProvider({
		memory: () => {
			memoryConstructed++;
			return new MemoryRunJournal();
		},
		sql: SqlRunJournal.open,
	});
	await writeFileEnsuringDir(join(root, "file"), "not a directory");
	try {
		await assert.rejects(
			() =>
				provider.openRunJournal(
					{ kind: "sqlite", path: join(root, "file", "db.sqlite") },
					{ agentDir: root, domain: "journal" },
				),
			StorageUnavailableError,
		);
		const module = join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts");
		await assert.rejects(
			() =>
				provider.openRunJournal(
					{ kind: "adapter", module, secrets: { token: { env: "ATOMIC_TEST_ABSENT_STORAGE_SECRET" } } },
					{ agentDir: root, domain: "journal" },
				),
			(error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.field, "secrets.token");
				assert.equal(error.reason, "secret-env-missing");
				return true;
			},
		);
		await assert.rejects(
			() =>
				provider.openRunJournal(
					{ kind: "adapter", module, secrets: { token: { file: "missing-token" } } },
					{ agentDir: root, domain: "journal" },
				),
			StorageUnavailableError,
		);
		assert.equal(memoryConstructed, 0);
	} finally {
		removeTempDirectory(root);
	}
});

test("bare adapter package specifiers resolve from the supplied agent directory", async () => {
	const root = makeTempDirectory("storage-module-");
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	const packageDir = join(root, "node_modules", "@atomic-test", "storage");
	await writeFileEnsuringDir(
		join(packageDir, "package.json"),
		JSON.stringify({ name: "@atomic-test/storage", type: "module", exports: "./index.mjs" }),
	);
	await writeFileEnsuringDir(
		join(packageDir, "index.mjs"),
		`export { default } from ${JSON.stringify(pathToFileURL(join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts")).href)};\n`,
	);
	try {
		const journal = await provider.openRunJournal(
			{ kind: "adapter", module: "@atomic-test/storage", options: { path: join(root, "runs.sqlite") } },
			{ agentDir: root, domain: "journal" },
		);
		await journal.createRun({ runId: "module", name: "module", cwd: root, createdAt: 1, status: "running" });
		assert.equal((await journal.getRun("module"))?.runId, "module");
		await journal.close();
	} finally {
		removeTempDirectory(root);
	}
});

test("a schema failure closes its owned database and evicts the failed selection for retry", async () => {
	const root = makeTempDirectory("storage-retry-");
	const path = join(root, "runs.sqlite");
	const lifecycle = join(root, "lifecycle.txt");
	const database = await openNodeSqliteDatabase(path);
	await database.exec("CREATE TABLE wf_meta (schema_version INTEGER); INSERT INTO wf_meta VALUES (99)");
	await database.close();
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	const selection = {
		kind: "adapter",
		module: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
		options: { path, lifecycle },
	} as const;
	try {
		await assert.rejects(
			() => provider.openRunJournal(selection, { agentDir: root, domain: "journal" }),
			StorageSchemaVersionError,
		);
		assert.equal(await readText(lifecycle), "open\nclose\n");
		const repair = await openNodeSqliteDatabase(path);
		await repair.run("UPDATE wf_meta SET schema_version = ?", 1);
		await repair.close();
		const journal = await provider.openRunJournal(selection, { agentDir: root, domain: "journal" });
		assert.deepEqual(await journal.listRuns(), []);
		await journal.close();
		assert.equal(await readText(lifecycle), "open\nclose\nopen\nclose\n");
	} finally {
		removeTempDirectory(root);
	}
});

test("the public provider rejects malformed selections before opening storage", async () => {
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	for (const [json, reason] of [
		["null", "selection-object-required"],
		['{"kind":"other"}', "invalid-kind"],
		['{"kind":"sqlite"}', "invalid-path"],
		['{"kind":"adapter","module":""}', "invalid-adapter"],
		['{"kind":"database","database":null}', "async-database-required"],
		['{"kind":"memory","path":"x"}', "multiple-selection-forms"],
		['{"kind":"memory","module":"x"}', "multiple-selection-forms"],
	] as const) {
		await assert.rejects(
			() => provider.openRunJournal(JSON.parse(json) as StorageSelection, { agentDir: ".", domain: "journal" }),
			(error: Error) => {
				assert.ok(error instanceof StorageConfigError);
				assert.equal(error.source, "sdk");
				assert.equal(error.field, "storage");
				assert.equal(error.reason, reason);
				return true;
			},
		);
	}
});

test("invalid prefix strings retain typed prefix errors before a database file is created", async () => {
	const root = makeTempDirectory("storage-prefix-");
	const provider = new StorageProvider({ memory: () => new MemoryRunJournal(), sql: SqlRunJournal.open });
	try {
		for (const [prefix, reason] of [
			["bad-prefix", "pattern"],
			["sqlite_reserved", "reserved"],
		] as const) {
			const path = join(root, `${prefix}.sqlite`);
			await assert.rejects(
				() => provider.openRunJournal({ kind: "sqlite", path, prefix }, { agentDir: root, domain: "journal" }),
				(error: Error) => {
					assert.ok(error instanceof StoragePrefixError);
					assert.equal(error.prefix, prefix);
					assert.equal(error.reason, reason);
					return true;
				},
			);
			assert.equal(await fileExists(path), false);
		}
	} finally {
		removeTempDirectory(root);
	}
});
