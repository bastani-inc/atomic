import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { loadStorageAdapter, StorageConfigError, StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import adapter, { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

/** Asserts that `open` fails with `StorageConfigError` for `field`/`reason`, and that no secret reaches the error. */
async function assertRefused(
	open: () => Promise<unknown>,
	field: string,
	reason: string,
	secrets: readonly string[] = [],
): Promise<void> {
	await assert.rejects(open, (error: Error) => {
		assert.ok(error instanceof StorageConfigError, inspect(error));
		assert.equal(error.field, field);
		assert.equal(error.reason, reason);
		const rendered = inspect(error, { depth: null });
		for (const secret of secrets) assert.equal(rendered.includes(secret), false, `${secret} leaked: ${rendered}`);
		return true;
	});
}

test("Postgres refuses a password in the URL's userinfo without connecting (#4793)", async () => {
	for (const url of [
		"postgres://atomic:fixture-secret@127.0.0.1:1/atomic",
		"postgresql://atomic:fixture-secret@db.invalid/atomic?sslmode=verify-full",
	])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "credential-in-url", ["fixture-secret"]);
});

test("Postgres refuses a password query parameter in the URL (#4793)", async () => {
	for (const url of [
		"postgres://atomic@127.0.0.1:1/atomic?password=fixture-secret",
		"postgres://atomic@127.0.0.1:1/atomic?sslmode=disable&PASSWORD=fixture-secret",
		"postgres://atomic@127.0.0.1:1/atomic?pass%77ord=fixture-secret",
	])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "credential-in-url", ["fixture-secret"]);
});

test("Postgres refuses URLs that are not postgres:// or postgresql:// (#4793)", async () => {
	for (const url of ["libsql://db.turso.io", "file:/tmp/db.sqlite", "http://127.0.0.1:5432/db", "not a url", ""])
		await assertRefused(() => openPostgresDatabase({ url }), "url", "unsupported-url");
});

test("Postgres refuses cloud auth until a token provider is available (#4793)", async () => {
	await assertRefused(
		() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", auth: "azure-entra" }),
		"auth",
		"auth-unavailable",
	);
	await assertRefused(
		() =>
			openPostgresDatabase({
				url: "postgres://atomic@127.0.0.1:1/atomic",
				// @ts-expect-error an auth mode the adapter does not know
				auth: "kerberos",
			}),
		"auth",
		"unsupported-auth",
	);
});

test("Postgres refuses connection limits that are not positive integers (#4793)", async () => {
	for (const maxConnections of [0, -1, 1.5, Number.NaN])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", maxConnections }),
			"maxConnections",
			"positive-integer-required",
		);
	for (const statementTimeoutMs of [0, -5, 2.5])
		await assertRefused(
			() => openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic", statementTimeoutMs }),
			"statementTimeoutMs",
			"positive-integer-required",
		);
});

test("the Postgres adapter module declares its password as a live secret (#4793)", () => {
	assert.equal(adapter.atomicStorageAdapter, 1);
	assert.deepEqual(adapter.liveSecrets, ["password"]);
});

test("the Postgres adapter requires a URL option (#4793)", async () => {
	for (const url of [undefined, "", 5])
		await assertRefused(
			() => adapter.openDatabase(url === undefined ? {} : { url }, { agentDir: "/nonexistent", domain: "journal" }),
			"url",
			"unsupported-url",
		);
});

test("Atomic loads the installed Postgres package by name as a storage adapter (#4793)", async () => {
	const agentDir = makeTempDirectory("storage-postgres-agent-");
	try {
		const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-postgres");
		await writeFileEnsuringDir(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		const loaded = await loadStorageAdapter("@bastani/atomic-storage-postgres", { agentDir, domain: "journal" });
		assert.deepEqual(loaded.liveSecrets, ["password"]);
		assert.ok(loaded.openDatabase);
		await assertRefused(
			() =>
				loaded.openDatabase?.(
					{ url: "postgres://atomic:fixture-secret@127.0.0.1:1/atomic" },
					{ agentDir, domain: "journal" },
				) ?? Promise.resolve(),
			"url",
			"credential-in-url",
			["fixture-secret"],
		);
	} finally {
		removeTempDirectory(agentDir);
	}
});

/** An open that fails to connect gives up only after the facade's five runs and their backoff, about four seconds. */
const FAILED_OPEN_TIMEOUT_MS = 20_000;

test(
	"Postgres requires a verified TLS connection to a host that is not this machine, unless the URL says otherwise (#4793)",
	async () => {
		const location = async (url: string) => {
			const error = await openPostgresDatabase({ url }).catch((caught) => caught);
			assert.ok(error instanceof StorageUnavailableError, inspect(error));
			return error.location;
		};
		const [remote, lookalike, loopback, chosen] = await Promise.all([
			location("postgres://atomic@db.invalid:1/atomic"),
			location("postgres://atomic@127.db.invalid:1/atomic"),
			location("postgres://atomic@127.0.0.1:1/atomic"),
			location("postgres://atomic@db.invalid:1/atomic?sslmode=disable"),
		]);
		assert.equal(remote, "postgres://atomic@db.invalid:1/atomic?sslmode=verify-full");
		assert.equal(lookalike, "postgres://atomic@127.db.invalid:1/atomic?sslmode=verify-full");
		assert.equal(loopback, "postgres://atomic@127.0.0.1:1/atomic");
		assert.equal(chosen, "postgres://atomic@db.invalid:1/atomic?sslmode=disable");
	},
	FAILED_OPEN_TIMEOUT_MS,
);
