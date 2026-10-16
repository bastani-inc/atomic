import assert from "node:assert/strict";
import { inspect } from "node:util";
import type { Config } from "@libsql/client";
import { afterEach, test, vi } from "vitest";
import { StorageError, StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openLibsqlDatabase } from "../fixtures/storage-libsql-wrapper.js";

afterEach(() => {
	vi.doUnmock("@libsql/client");
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

test("libSQL passes caller credentials verbatim and redacts nested driver failures", async () => {
	const options = {
		url: "https://fixture-user:fixture-password@example.invalid/database?authToken=fixture-query-token&%61uthToken=fixture%2Dencoded-token&%61uthToken=fixture%2Fduplicate+token",
		authToken: "fixture-option-token",
	};
	const nested = new StorageError(
		`authorization ${options.authToken} fixture-query-token fixture-encoded-token fixture/duplicate token fixture%2Dencoded-token fixture%2Fduplicate+token`,
	);
	const failure = new StorageError("request failed", { cause: nested });
	const createClient = vi.fn((config: Config) => {
		assert.deepEqual(config, { ...options, intMode: "bigint" });
		throw failure;
	});
	vi.doMock("@libsql/client", () => ({ createClient }));
	const log = vi.spyOn(console, "log");
	const warn = vi.spyOn(console, "warn");
	const errorLog = vi.spyOn(console, "error");
	await assert.rejects(openLibsqlDatabase(options), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.adapter, "libsql");
		assert.equal(
			error.location,
			"https://[redacted]:[redacted]@example.invalid/database?authToken=[redacted]&%61uthToken=[redacted]&%61uthToken=[redacted]",
		);
		const rendered = inspect(error, { depth: null });
		for (const secret of [
			"fixture-user",
			"fixture-password",
			"fixture-query-token",
			"fixture-encoded-token",
			"fixture/duplicate token",
			"fixture%2Dencoded-token",
			"fixture%2Fduplicate+token",
			options.authToken,
		]) {
			assert.equal(rendered.includes(secret), false);
		}
		assert.ok(error.cause instanceof StorageError);
		assert.notEqual(error.cause, failure);
		return true;
	});
	assert.equal(createClient.mock.calls.length, 1);
	assert.equal(log.mock.calls.length + warn.mock.calls.length + errorLog.mock.calls.length, 0);
});

test("libSQL does not take an auth token from the environment or replace an open failure with memory", async () => {
	vi.stubEnv("TURSO_AUTH_TOKEN", "environment-token-must-not-be-used");
	vi.stubEnv("LIBSQL_AUTH_TOKEN", "environment-token-must-not-be-used");
	const failure = new StorageError("fixture opening failure");
	const createClient = vi.fn((config: Config) => {
		assert.deepEqual(config, { url: "file:fixture.sqlite", authToken: undefined, intMode: "bigint" });
		throw failure;
	});
	vi.doMock("@libsql/client", () => ({ createClient }));
	await assert.rejects(openLibsqlDatabase({ url: "file:fixture.sqlite" }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, "file:fixture.sqlite");
		assert.equal(error.cause, failure);
		return true;
	});
	assert.equal(createClient.mock.calls.length, 1);
});

test("libSQL redacts auth tokens in malformed URLs without changing caller input", async () => {
	const url = "not a url?authToken=fixture-malformed-token";
	const failure = new StorageError("fixture-malformed-token");
	vi.doMock("@libsql/client", () => ({
		createClient: (config: Config) => {
			assert.equal(config.url, url);
			throw failure;
		},
	}));
	await assert.rejects(openLibsqlDatabase({ url }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, "not a url?authToken=[redacted]");
		assert.equal(inspect(error, { depth: null }).includes("fixture-malformed-token"), false);
		return true;
	});
});

test("libSQL redacts userinfo even when the URL is malformed", async () => {
	const url = "https://fixture-user:fixture-password@bad host/database";
	vi.doMock("@libsql/client", () => ({
		createClient: (config: Config) => {
			assert.equal(config.url, url);
			throw new StorageError(url);
		},
	}));
	await assert.rejects(openLibsqlDatabase({ url }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, "https://[redacted]:[redacted]@bad host/database");
		assert.equal(inspect(error, { depth: null }).includes("fixture-password"), false);
		assert.equal(inspect(error, { depth: null }).includes("fixture-user"), false);
		return true;
	});
});

test("libSQL forwards a lone-surrogate token without an untyped encoding failure", async () => {
	const authToken = "\ud800";
	const failure = new StorageError("fixture driver failure");
	const createClient = vi.fn((config: Config) => {
		assert.equal(config.authToken, authToken);
		throw failure;
	});
	vi.doMock("@libsql/client", () => ({ createClient }));
	await assert.rejects(openLibsqlDatabase({ url: "file:fixture.sqlite", authToken }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.cause, failure);
		return true;
	});
	assert.equal(createClient.mock.calls.length, 1);
});

test("libSQL redacts complete credentials when one is a prefix of another", async () => {
	const options = {
		url: "https://fixture-user:fixture-user-password@example.invalid/database",
		authToken: "fixture-user",
	};
	vi.doMock("@libsql/client", () => ({
		createClient: (config: Config) => {
			assert.equal(config.url, options.url);
			assert.equal(config.authToken, options.authToken);
			throw new StorageError(options.url);
		},
	}));
	await assert.rejects(openLibsqlDatabase(options), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, "https://[redacted]:[redacted]@example.invalid/database");
		assert.equal(inspect(error, { depth: null }).includes("-password"), false);
		return true;
	});
});

test("libSQL captures caller options before awaiting the driver load", async () => {
	const options = { url: "https://original.example.invalid/database", authToken: "original-token" };
	const original = { ...options };
	let supplied: Config | undefined;
	vi.doMock("@libsql/client", () => ({
		createClient: (config: Config) => {
			supplied = config;
			throw new StorageError(`request ${config.url} token ${config.authToken}`);
		},
	}));
	const pending = openLibsqlDatabase(options);
	options.url = "https://changed.example.invalid/database";
	options.authToken = "changed-token";
	await assert.rejects(pending, (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, original.url);
		assert.equal(inspect(error, { depth: null }).includes(options.authToken), false);
		assert.equal(inspect(error, { depth: null }).includes(original.authToken), false);
		return true;
	});
	assert.deepEqual(supplied, { ...original, intMode: "bigint" });
});
