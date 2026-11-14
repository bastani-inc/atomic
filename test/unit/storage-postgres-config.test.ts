import assert from "node:assert/strict";
import { inspect } from "node:util";
import { StorageConfigError } from "@bastani/atomic/storage";
import { test } from "vitest";
import adapter, { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";

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
