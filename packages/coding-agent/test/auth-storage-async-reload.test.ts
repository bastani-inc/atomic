import assert from "node:assert/strict";
import { test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { AuthStorageBackend, LockResult } from "../src/core/auth-storage-backends.ts";

class HeldReadBackend implements AuthStorageBackend {
	content = JSON.stringify({ anthropic: { type: "api_key", key: "loaded" } });
	private revision = 1;
	hold: Promise<void> | undefined;

	writtenElsewhere(content: string): void {
		this.content = content;
		this.revision += 1;
	}

	async readAsync(): Promise<string | undefined> {
		const content = this.content;
		await this.hold;
		return content;
	}

	async versionAsync(): Promise<string> {
		return String(this.revision);
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.content);
		if (next !== undefined) this.writtenElsewhere(next);
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.content);
		if (next !== undefined) this.writtenElsewhere(next);
		return result;
	}
}

test("an asynchronous reload never replaces credentials saved while it read", async () => {
	const backend = new HeldReadBackend();
	const storage = AuthStorage.fromStorage(backend);
	backend.writtenElsewhere(JSON.stringify({ anthropic: { type: "api_key", key: "elsewhere" } }));
	let release!: () => void;
	backend.hold = new Promise((resolve) => {
		release = resolve;
	});

	const listing = storage.list();
	await storage.modify("anthropic", async () => ({ type: "api_key", key: "saved" }));
	release();
	await listing;

	const credential = storage.peek("anthropic");
	assert.equal(credential?.type === "api_key" ? credential.key : undefined, "saved");
});

test("an asynchronous reload picks up credentials written elsewhere", async () => {
	const backend = new HeldReadBackend();
	const storage = AuthStorage.fromStorage(backend);
	backend.writtenElsewhere(JSON.stringify({ openai: { type: "api_key", key: "elsewhere" } }));

	assert.deepEqual(await storage.list(), [{ providerId: "openai", type: "api_key" }]);
});
