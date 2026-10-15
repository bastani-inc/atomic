import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@bastani/pi-ai";
import { afterEach, beforeEach, test } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.js";
import type { LockResult } from "../src/core/auth-storage-backends.js";

let directory: string;
let authPath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "auth-sync-3620-"));
	authPath = join(directory, "auth.json");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function oauth(access: string): Credential {
	return { type: "oauth", access, refresh: `${access}-refresh`, expires: 4_102_444_800_000 };
}

function writeAuth(path: string, data: Record<string, Credential>): void {
	writeFileSync(path, JSON.stringify(data));
}

class MutableBackend implements AuthStorageBackend {
	content: string | undefined;
	revision = "0";
	reads = 0;
	readonly version?: () => string;

	constructor(content: string, reportsVersion: boolean) {
		this.content = content;
		if (reportsVersion) this.version = () => this.revision;
	}

	read(): string | undefined {
		this.reads += 1;
		return this.content;
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		return fn(this.content).result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		return (await fn(this.content)).result;
	}
}

test("reloads auth.json changed by another process (#3620)", async () => {
	writeAuth(authPath, { anthropic: oauth("access-old") });
	const session = AuthStorage.create(authPath);
	const otherProcess = AuthStorage.create(authPath);
	assert.deepEqual(await session.read("anthropic"), oauth("access-old"));

	await otherProcess.modify("anthropic", async () => oauth("access-new"));
	await otherProcess.modify("openai-codex", async () => oauth("codex"));

	assert.deepEqual(await session.read("anthropic"), oauth("access-new"));
	assert.deepEqual(await session.read("openai-codex"), oauth("codex"));
});

test("lists providers logged in or out by another process (#3620)", async () => {
	writeAuth(authPath, { anthropic: oauth("anthropic") });
	const session = AuthStorage.create(authPath);
	const otherProcess = AuthStorage.create(authPath);

	await otherProcess.delete("anthropic");
	await otherProcess.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));

	assert.deepEqual(await session.list(), [{ providerId: "openai", type: "api_key" }]);
});

test("keeps the last valid credentials while auth.json is malformed, then recovers (#3620)", async () => {
	writeAuth(authPath, { anthropic: oauth("access-old") });
	const session = AuthStorage.create(authPath);
	assert.deepEqual(await session.read("anthropic"), oauth("access-old"));

	writeFileSync(authPath, '{"anthropic": {"type": "oauth"');
	assert.deepEqual(await session.read("anthropic"), oauth("access-old"));
	assert.deepEqual(await session.list(), [{ providerId: "anthropic", type: "oauth" }]);

	writeAuth(authPath, { anthropic: oauth("access-new") });
	assert.deepEqual(await session.read("anthropic"), oauth("access-new"));
});

test("reloads when a lower-precedence layered auth file changes (#3620)", async () => {
	const fallbackPath = join(directory, "fallback-auth.json");
	writeAuth(authPath, { anthropic: oauth("primary") });
	const session = AuthStorage.create([authPath, fallbackPath]);
	assert.equal(await session.read("openai-codex"), undefined);

	writeAuth(fallbackPath, { "openai-codex": oauth("fallback") });

	assert.deepEqual(await session.read("openai-codex"), oauth("fallback"));
	assert.deepEqual(await session.read("anthropic"), oauth("primary"));
});

test("rereads a custom backend only when its reported version changes (#3620)", async () => {
	const backend = new MutableBackend(JSON.stringify({ anthropic: oauth("old") }), true);
	backend.revision = "1";
	const session = AuthStorage.fromStorage(backend);
	const readsAfterLoad = backend.reads;

	await session.read("anthropic");
	await session.list();
	assert.equal(backend.reads, readsAfterLoad);

	backend.content = JSON.stringify({ anthropic: oauth("new") });
	backend.revision = "2";
	assert.deepEqual(await session.read("anthropic"), oauth("new"));
	assert.equal(backend.reads, readsAfterLoad + 1);
});

test("rereads a custom backend without a version on every read (#3620)", async () => {
	const backend = new MutableBackend(JSON.stringify({ anthropic: oauth("old") }), false);
	const session = AuthStorage.fromStorage(backend);

	backend.content = JSON.stringify({ anthropic: oauth("new") });

	assert.deepEqual(await session.read("anthropic"), oauth("new"));
});
