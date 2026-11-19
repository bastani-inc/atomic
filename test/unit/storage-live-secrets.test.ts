import assert from "node:assert/strict";
import { join } from "node:path";
import {
	adapterOpenContext,
	inMemorySecret,
	openNodeSqliteDatabase,
	resolveAdapterOptions,
	type SqliteDatabase,
	type StorageAdapterModule,
	StorageConfigError,
	type StorageOpenContext,
	StorageProvider,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { test } from "vitest";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

interface LiveSecretProbe {
	options?: Readonly<Record<string, unknown>>;
	context?: StorageOpenContext;
	database?: SqliteDatabase;
}

const PROBE = Symbol.for("atomic-test/storage-live-secrets-4793");

test("a live secret is re-read on every context.secret call and never reaches options (#4793)", async () => {
	const home = makeTempDirectory("storage-live-secrets-");
	const agentDir = join(home, "agent");
	const probe: LiveSecretProbe = {};
	Reflect.set(globalThis, PROBE, probe);
	await writeFileEnsuringDir(
		join(agentDir, "adapter.ts"),
		[
			`const probe = (globalThis as Record<symbol, any>)[Symbol.for("atomic-test/storage-live-secrets-4793")];`,
			"export default {",
			"\tatomicStorageAdapter: 1 as const,",
			'\tliveSecrets: ["password"],',
			"\tasync openDatabase(options: Record<string, unknown>, context: unknown) {",
			"\t\tprobe.options = options;",
			"\t\tprobe.context = context;",
			"\t\treturn probe.database;",
			"\t},",
			"};",
			"",
		].join("\n"),
	);
	await writeFileEnsuringDir(join(agentDir, "password"), "first\n");
	probe.database = await openNodeSqliteDatabase(join(home, "sessions.sqlite"));
	const provider = new StorageProvider();
	try {
		const store = await provider.openSessionStore(
			{
				kind: "adapter",
				module: "./adapter.ts",
				options: { url: "postgres://example" },
				secrets: { password: { file: "password" }, token: inMemorySecret("fixed") },
			},
			{ agentDir, domain: "sessions" },
		);
		assert.deepEqual(probe.options, { url: "postgres://example", token: "fixed" });
		const secret = probe.context?.secret;
		assert.ok(secret);
		assert.equal(await secret("password"), "first");
		await writeFileEnsuringDir(join(agentDir, "password"), "rotated\r\n");
		assert.equal(await secret("password"), "rotated");
		await assert.rejects(secret("missing"), (error: StorageConfigError) => error.field === "secrets.missing");
		await store.close();
	} finally {
		Reflect.deleteProperty(globalThis, PROBE);
		removeTempDirectory(home);
	}
});

test("adapters without liveSecrets keep every secret in options (#4793)", async () => {
	const selection = {
		kind: "adapter",
		module: "unused",
		secrets: { token: inMemorySecret("value") },
	} as const;
	const context = adapterOpenContext(selection, { agentDir: "/unused", domain: "sessions" });
	assert.deepEqual(await resolveAdapterOptions(selection, context), { token: "value" });
	assert.deepEqual(await resolveAdapterOptions(selection, context, ["token"]), {});
	assert.equal(await context.secret?.("token"), "value");
	const adapter: StorageAdapterModule = { atomicStorageAdapter: 1, liveSecrets: ["token"] };
	assert.deepEqual(adapter.liveSecrets, ["token"]);
});

test("context.secret re-reads environment references and names missing ones (#4793)", async () => {
	const home = makeTempDirectory("storage-live-secret-env-");
	const name = "ATOMIC_TEST_LIVE_SECRET_4793";
	const selection = {
		kind: "adapter",
		module: "probe-module",
		secrets: { env: { env: name }, file: { file: "absent" } },
	} as const;
	const context = adapterOpenContext(selection, { agentDir: join(home, "agent"), domain: "sessions" });
	try {
		process.env[name] = "first";
		assert.equal(await context.secret?.("env"), "first");
		process.env[name] = "second";
		assert.equal(await context.secret?.("env"), "second");
		delete process.env[name];
		await assert.rejects(
			context.secret?.("env") ?? Promise.resolve(),
			(error: StorageConfigError) =>
				error instanceof StorageConfigError &&
				error.source === "sdk" &&
				error.field === "secrets.env" &&
				error.reason === "secret-env-missing",
		);
		await assert.rejects(
			context.secret?.("file") ?? Promise.resolve(),
			(error: StorageUnavailableError) =>
				error instanceof StorageUnavailableError && error.adapter === "probe-module" && error.location === "absent",
		);
		await assert.rejects(
			context.secret?.("toString") ?? Promise.resolve(),
			(error: StorageConfigError) =>
				error.source === "sdk" && error.field === "secrets.toString" && error.reason === "secret-missing",
		);
	} finally {
		delete process.env[name];
		removeTempDirectory(home);
	}
});

test("store hooks of an adapter receive the live-secret context and the prefix, and an earlier openRunJournal hook is never called (#4793)", async () => {
	const home = makeTempDirectory("storage-live-secret-hooks-");
	const agentDir = join(home, "agent");
	const seen: { hook: string; options: unknown; prefix?: string; secret: string }[] = [];
	Reflect.set(globalThis, PROBE, {
		async record(hook: string, options: unknown, context: StorageOpenContext, storage: { prefix?: string }) {
			seen.push({ hook, options, prefix: storage.prefix, secret: (await context.secret?.("password")) ?? "" });
			return { close: async () => {} };
		},
	});
	await writeFileEnsuringDir(
		join(agentDir, "adapter.ts"),
		[
			`const probe = (globalThis as Record<symbol, any>)[Symbol.for("atomic-test/storage-live-secrets-4793")];`,
			"export default {",
			"\tatomicStorageAdapter: 1 as const,",
			'\tliveSecrets: ["password"],',
			'\topenSessionStore: (options: unknown, context: unknown, storage: unknown) => probe.record("sessions", options, context, storage),',
			'\topenRunJournal: (options: unknown, context: unknown, storage: unknown) => probe.record("journal", options, context, storage),',
			"};",
			"",
		].join("\n"),
	);
	const selection = {
		kind: "adapter",
		module: "./adapter.ts",
		options: { url: "postgres://example" },
		secrets: { password: inMemorySecret("pw") },
		prefix: "team_",
	} as const;
	const provider = new StorageProvider();
	try {
		const sessions = await provider.openSessionStore(selection, { agentDir, domain: "sessions" });
		await sessions.close();
		assert.deepEqual(seen, [
			{ hook: "sessions", options: { url: "postgres://example" }, prefix: "team_", secret: "pw" },
		]);
	} finally {
		Reflect.deleteProperty(globalThis, PROBE);
		removeTempDirectory(home);
	}
});

test("a session store through an adapter with only openDatabase gets the database and the live-secret context (#4793)", async () => {
	const home = makeTempDirectory("storage-live-secret-database-");
	const agentDir = join(home, "agent");
	const probe: LiveSecretProbe = {};
	Reflect.set(globalThis, PROBE, probe);
	await writeFileEnsuringDir(
		join(agentDir, "adapter.ts"),
		[
			`const probe = (globalThis as Record<symbol, any>)[Symbol.for("atomic-test/storage-live-secrets-4793")];`,
			"export default {",
			"\tatomicStorageAdapter: 1 as const,",
			'\tliveSecrets: ["password"],',
			"\tasync openDatabase(options: Record<string, unknown>, context: unknown) {",
			"\t\tprobe.options = options;",
			"\t\tprobe.context = context;",
			"\t\treturn probe.database;",
			"\t},",
			"};",
			"",
		].join("\n"),
	);
	probe.database = await openNodeSqliteDatabase(join(home, "sessions.sqlite"));
	try {
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "adapter", module: "./adapter.ts", secrets: { password: inMemorySecret("pw") } },
			{ agentDir, domain: "sessions" },
		);
		assert.equal(sessions.descriptor.location, probe.database.descriptor.location);
		assert.deepEqual(probe.options, {});
		assert.equal(await probe.context?.secret?.("password"), "pw");
		await sessions.close();
	} finally {
		Reflect.deleteProperty(globalThis, PROBE);
		await probe.database?.close();
		removeTempDirectory(home);
	}
});
