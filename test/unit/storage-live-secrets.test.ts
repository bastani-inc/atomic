import assert from "node:assert/strict";
import { join } from "node:path";
import {
	adapterOpenContext,
	inMemorySecret,
	openNodeSqliteDatabase,
	resolveAdapterOptions,
	type SqliteDatabase,
	type StorageAdapterModule,
	type StorageConfigError,
	type StorageOpenContext,
	StorageProvider,
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
	await writeFileEnsuringDir(join(home, "password"), "first\n");
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
		await writeFileEnsuringDir(join(home, "password"), "rotated\r\n");
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
	const context = adapterOpenContext(selection, { agentDir: "/unused", domain: "journal" });
	assert.deepEqual(await resolveAdapterOptions(selection, context), { token: "value" });
	assert.deepEqual(await resolveAdapterOptions(selection, context, ["token"]), {});
	assert.equal(await context.secret?.("token"), "value");
	const adapter: StorageAdapterModule = { atomicStorageAdapter: 1, liveSecrets: ["token"] };
	assert.deepEqual(adapter.liveSecrets, ["token"]);
});
