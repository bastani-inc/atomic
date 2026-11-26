import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	loadStorageAdapter,
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

import {
	fileExists,
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

test("provider shares a persistent database across session prefixes until both stores close", async () => {
	const root = makeTempDirectory("storage-provider-");
	const provider = new StorageProvider();
	const selection = { kind: "sqlite", path: join(root, "shared.sqlite") } as const;
	const context = { agentDir: root };
	try {
		const [sessions, second] = await Promise.all([
			provider.openSessionStore(selection, { ...context, domain: "sessions" }),
			provider.openSessionStore({ ...selection, prefix: "second_" }, { ...context, domain: "sessions" }),
		]);
		await sessions.close();
		await sessions.close();
		await second.create({ id: "run", version: 4, cwd: root, createdAt: new Date(0).toISOString() }, []);
		assert.equal((await second.readHeader("run"))?.id, "run");
		await second.close();
	} finally {
		removeTempDirectory(root);
	}
});

test("module adapter resolves secrets and shares one connection between session stores", async () => {
	const root = makeTempDirectory("storage-adapter-");
	const provider = new StorageProvider();
	const path = join(root, "adapter.sqlite");
	const lifecycle = join(root, "lifecycle.txt");
	const agentDir = join(root, "agent");
	await writeFileEnsuringDir(join(agentDir, "secret.txt"), " secret with newline\n");
	const selection = {
		kind: "adapter",
		module: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
		options: { path, lifecycle, token: "overwritten", empty: "", enabled: false },
		secrets: { token: { file: "secret.txt" }, environment: { env: "PATH" }, ["__proto__"]: { env: "PATH" } },
		prefix: "custom_",
	} as const;
	try {
		const context = { agentDir };
		const [sessions, second] = await Promise.all([
			provider.openSessionStore(selection, { ...context, domain: "sessions" }),
			provider.openSessionStore({ ...selection, prefix: "second_" }, { ...context, domain: "sessions" }),
		]);
		assert.equal(await readText(lifecycle), "open\n");
		const probe = await openNodeSqliteDatabase(path);
		try {
			const rows = await probe.all("SELECT options FROM adapter_probe");
			assert.equal(rows.length, 1);
			assert.deepEqual(JSON.parse(String(rows[0]!.options)), {
				...selection.options,
				token: " secret with newline",
				environment: process.env.PATH,
				["__proto__"]: process.env.PATH,
			});
		} finally {
			await probe.close();
		}
		await sessions.close();
		assert.equal(await readText(lifecycle), "open\n");
		await second.create({ id: "adapter", version: 4, cwd: root, createdAt: new Date(0).toISOString() }, []);
		await second.close();
		await second.close();
		assert.equal(await readText(lifecycle), "open\nclose\n");
	} finally {
		removeTempDirectory(root);
	}
});

test("domain hooks take priority and unsupported or invalid modules fail with typed errors", async () => {
	const root = makeTempDirectory("storage-domain-");
	const provider = new StorageProvider();
	const module = join(moduleDir(import.meta.url), "../fixtures/storage-domain-adapter.ts");
	try {
		const sessions = await provider.openSessionStore(
			{ kind: "adapter", module },
			{ agentDir: root, domain: "sessions" },
		);
		assert.equal(sessions.descriptor.adapter, "memory");
		await sessions.close();
		await assert.rejects(
			() =>
				provider.openSessionStore(
					{
						kind: "adapter",
						module: join(moduleDir(import.meta.url), "../fixtures/storage-unsupported-adapter.ts"),
					},
					{ agentDir: root, domain: "sessions" },
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
					provider.openSessionStore(
						{ kind: "adapter", module: specifier },
						{ agentDir: root, domain: "sessions" },
					),
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

test("caller-owned facade stays open after the session store closes", async () => {
	const root = makeTempDirectory("storage-borrowed-");
	const database = await openNodeSqliteDatabase(join(root, "borrowed.sqlite"));
	const provider = new StorageProvider();
	try {
		const selection = { kind: "database", database, prefix: "owned_" } as const;
		const sessions = await provider.openSessionStore(selection, { agentDir: root, domain: "sessions" });
		await sessions.close();
		assert.equal((await database.get("SELECT schema_version FROM owned_session_meta"))?.schema_version, 1);
	} finally {
		await database.close();
		removeTempDirectory(root);
	}
});

test("opening a session fails on unavailable storage and missing secrets fail before adapter invocation", async () => {
	const root = makeTempDirectory("storage-failure-");
	const provider = new StorageProvider();
	await writeFileEnsuringDir(join(root, "file"), "not a directory");
	try {
		await assert.rejects(
			() =>
				provider.openSessionStore(
					{ kind: "sqlite", path: join(root, "file", "db.sqlite") },
					{ agentDir: root, domain: "sessions" },
				),
			StorageUnavailableError,
		);
		const module = join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts");
		await assert.rejects(
			() =>
				provider.openSessionStore(
					{ kind: "adapter", module, secrets: { token: { env: "ATOMIC_TEST_ABSENT_STORAGE_SECRET" } } },
					{ agentDir: root, domain: "sessions" },
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
				provider.openSessionStore(
					{ kind: "adapter", module, secrets: { token: { file: "missing-token" } } },
					{ agentDir: root, domain: "sessions" },
				),
			StorageUnavailableError,
		);
	} finally {
		removeTempDirectory(root);
	}
});

test("bare adapter package specifiers resolve from the supplied agent directory", async () => {
	const root = makeTempDirectory("storage-module-");
	const provider = new StorageProvider();
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
		const store = await provider.openSessionStore(
			{ kind: "adapter", module: "@atomic-test/storage", options: { path: join(root, "sessions.sqlite") } },
			{ agentDir: root, domain: "sessions" },
		);
		await store.create({ id: "module", version: 4, cwd: root, createdAt: new Date(0).toISOString() }, []);
		assert.equal((await store.readHeader("module"))?.id, "module");
		await store.close();
	} finally {
		removeTempDirectory(root);
	}
});

test("a schema failure closes its owned database and evicts the failed selection for retry", async () => {
	const root = makeTempDirectory("storage-retry-");
	const path = join(root, "sessions.sqlite");
	const lifecycle = join(root, "lifecycle.txt");
	const database = await openNodeSqliteDatabase(path);
	await database.exec("CREATE TABLE session_meta (schema_version INTEGER); INSERT INTO session_meta VALUES (99)");
	await database.close();
	const provider = new StorageProvider();
	const selection = {
		kind: "adapter",
		module: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
		options: { path, lifecycle },
	} as const;
	try {
		await assert.rejects(
			() => provider.openSessionStore(selection, { agentDir: root, domain: "sessions" }),
			StorageSchemaVersionError,
		);
		assert.equal(await readText(lifecycle), "open\nclose\n");
		const repair = await openNodeSqliteDatabase(path);
		await repair.run("UPDATE session_meta SET schema_version = ?", 1);
		await repair.close();
		const store = await provider.openSessionStore(selection, { agentDir: root, domain: "sessions" });
		assert.deepEqual(await Array.fromAsync(store.list({})), []);
		await store.close();
		assert.equal(await readText(lifecycle), "open\nclose\nopen\nclose\n");
	} finally {
		removeTempDirectory(root);
	}
});

test("the public provider rejects malformed selections before opening storage", async () => {
	const provider = new StorageProvider();
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
			() => provider.openSessionStore(JSON.parse(json) as StorageSelection, { agentDir: ".", domain: "sessions" }),
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
	const provider = new StorageProvider();
	try {
		for (const [prefix, reason] of [
			["bad-prefix", "pattern"],
			["sqlite_reserved", "reserved"],
		] as const) {
			const path = join(root, `${prefix}.sqlite`);
			await assert.rejects(
				() => provider.openSessionStore({ kind: "sqlite", path, prefix }, { agentDir: root, domain: "sessions" }),
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

test("domain session hooks isolate records and deletion by selected prefix (#3699)", async () => {
	const root = makeTempDirectory("storage-domain-prefix-");
	const provider = new StorageProvider();
	const selection = {
		kind: "adapter",
		module: join(moduleDir(import.meta.url), "../fixtures/storage-prefixed-domain-adapter.ts"),
		options: { path: join(root, "domains.sqlite") },
	} as const;
	const first = await provider.openSessionStore(
		{ ...selection, prefix: "first_" },
		{ agentDir: root, domain: "sessions" },
	);
	const second = await provider.openSessionStore(
		{ ...selection, prefix: "second_" },
		{ agentDir: root, domain: "sessions" },
	);
	try {
		const header = { id: "same", version: 4, cwd: root, createdAt: "2026-01-01T00:00:00.000Z" } as const;
		await first.create(header, []);
		assert.equal(await second.readHeader("same"), undefined);
		await second.create({ ...header, cwd: "second" }, []);
		await second.delete("same");
		assert.equal((await first.readHeader("same"))?.cwd, root);
	} finally {
		await first.close();
		await second.close();
		removeTempDirectory(root);
	}
});

for (const kind of ["memory", "jsonl", "database", "sqlite", "adapter-domain", "adapter-database"] as const) {
	{
		const domain = "sessions" as const;
		test(`session provider close is repeatable for ${kind} (#3699)`, async () => {
			const root = makeTempDirectory("storage-close-");
			const database = await openNodeSqliteDatabase(":memory:");
			const provider = new StorageProvider();
			const selections = {
				memory: { kind: "memory" },
				jsonl: { kind: "jsonl", dir: join(root, "sessions") },
				database: { kind: "database", database },
				sqlite: { kind: "sqlite", path: join(root, "owned.sqlite") },
				"adapter-domain": {
					kind: "adapter",
					module: join(moduleDir(import.meta.url), "../fixtures/storage-domain-adapter.ts"),
				},
				"adapter-database": {
					kind: "adapter",
					module: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
					options: { path: join(root, "adapter.sqlite") },
				},
			} satisfies Record<string, StorageSelection>;
			try {
				const context = { agentDir: root, domain };
				const store = await provider.openSessionStore(selections[kind], context);
				await store.close();
				await store.close();
				assert.equal((await database.get("SELECT 42 AS answer"))?.answer, 42);
			} finally {
				await database.close();
				removeTempDirectory(root);
			}
		});
	}
}

{
	const domain = "sessions" as const;
	test(`${domain} opening retains the typed schema error when cleanup also rejects (#3699)`, async () => {
		const root = makeTempDirectory("storage-open-cleanup-");
		const path = join(root, "schema.sqlite");
		const lifecycle = join(root, "lifecycle.txt");
		const database = await openNodeSqliteDatabase(path);
		const table = "session_meta";
		await database.exec(`CREATE TABLE ${table} (schema_version INTEGER); INSERT INTO ${table} VALUES (99)`);
		await database.close();
		const provider = new StorageProvider();
		const selection = {
			kind: "adapter",
			module: join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"),
			options: { path, lifecycle, closeFailure: true },
		} as const;
		try {
			const context = { agentDir: root, domain };
			type FailureAdapter = typeof import("../fixtures/storage-adapter.js").default;
			const adapter = (await loadStorageAdapter(selection.module, context)) as FailureAdapter;
			await assert.rejects(
				() => provider.openSessionStore(selection, context),
				(error: Error) => {
					assert.ok(error instanceof StorageSchemaVersionError);
					assert.equal(error.domain, domain);
					assert.equal(error.found, 99);
					// Sessions read up to version 3, which turns on shared-history forks (#6560).
					assert.equal(error.supported, 3);
					assert.ok(error.cleanupCause instanceof adapter.cleanupErrorType);
					assert.equal(error.cleanupCause, adapter.cleanupFailure);
					assert.ok(error.cleanupCause.cause instanceof Error);
					assert.equal(error.cleanupCause.cause.message, "injected-close-failure");
					return true;
				},
			);
			assert.equal(await readText(lifecycle), "open\nclose\n");
		} finally {
			removeTempDirectory(root);
		}
	});
}
