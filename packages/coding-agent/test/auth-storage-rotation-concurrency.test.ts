import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, readStreamText, spawnProcess } from "../../../test/helpers/runtime.ts";
import { refreshStoredOAuthCredential } from "../../ai/src/auth/resolve.ts";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

test("file-backed rotation does not block unrelated logout or overwrite other provider updates (#3429)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "auth-3429-"));
	const path = join(directory, "auth.json");
	const storage = AuthStorage.create(path);
	const other = AuthStorage.create(path);
	const entered = gate();
	const finish = gate();
	await storage.modify("rotating", async () => ({ type: "oauth", access: "old", refresh: "old", expires: 0 }));
	await storage.modify("logout", async () => ({ type: "api_key", key: "remove" }));
	const rotated = { type: "oauth" as const, access: "new", refresh: "rotated", expires: 1000 };
	const pending = storage.modify("rotating", async () => {
		entered.release();
		await finish.promise;
		return rotated;
	});
	try {
		await entered.promise;
		await other.delete("logout");
		await other.modify("updated", async () => ({ type: "api_key", key: "  raw  ", env: { EMPTY: "" } }));
		finish.release();
		assert.equal(await pending, rotated);
		assert.equal(await storage.read("rotating"), rotated);
		storage.reload();
		assert.equal(await storage.read("logout"), undefined);
		assert.deepEqual(await storage.read("updated"), { type: "api_key", key: "  raw  ", env: { EMPTY: "" } });
		assert.equal((await storage.read("rotating"))?.type, "oauth");
		assert.equal(((await storage.read("rotating")) as { refresh: string }).refresh, "rotated");
	} finally {
		finish.release();
		await pending;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("same-provider logout cannot be resurrected by rotation and a queued login wins (#3429)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "auth-3429-delete-"));
	const path = join(directory, "auth.json");
	const storage = AuthStorage.create(path);
	const other = AuthStorage.create(path);
	const entered = gate();
	const finish = gate();
	await storage.modify("provider", async () => ({ type: "oauth", access: "old", refresh: "old", expires: 0 }));
	const pending = storage.modify("provider", async () => {
		entered.release();
		await finish.promise;
		return { type: "oauth", access: "stale", refresh: "stale", expires: 1000 };
	});
	try {
		await entered.promise;
		await other.delete("provider");
		const login = other.modify("provider", async () => ({ type: "api_key", key: "new login" }));
		finish.release();
		assert.equal(await pending, undefined);
		await login;
		storage.reload();
		assert.deepEqual(await storage.read("provider"), { type: "api_key", key: "new login" });
	} finally {
		finish.release();
		await pending;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rotation cannot overwrite a replacement written through the existing backend transaction (#3429)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "auth-3429-replace-"));
	const backend = new FileAuthStorageBackend(join(directory, "auth.json"));
	const storage = AuthStorage.fromStorage(backend);
	const entered = gate();
	const finish = gate();
	await storage.modify("provider", async () => ({ type: "oauth", access: "old", refresh: "old", expires: 0 }));
	const pending = storage.modify("provider", async () => {
		entered.release();
		await finish.promise;
		return { type: "oauth", access: "stale", refresh: "stale", expires: 1000 };
	});
	const replacement = { type: "api_key", key: " replacement ", env: { EMPTY: "" } };
	try {
		await entered.promise;
		backend.withLock((content) => ({
			result: undefined,
			next: JSON.stringify({ ...JSON.parse(content ?? "{}"), provider: replacement }),
		}));
		finish.release();
		assert.deepEqual(await pending, replacement);
		storage.reload();
		assert.deepEqual(await storage.read("provider"), replacement);
	} finally {
		finish.release();
		await pending;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("provider rotation serializes across processes and cancelled waiters never execute (#3429)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "auth-3429-process-"));
	const path = join(directory, "auth.json");
	const finishPath = join(directory, "finish");
	const storage = AuthStorage.create(path);
	const provider = " raw / provider ";
	await storage.modify(provider, async () => ({ type: "oauth", access: "old", refresh: "old", expires: 0 }));
	const child = spawnProcess(
		[
			bunExecutable(),
			"--eval",
			`
		import { AuthStorage } from ${JSON.stringify(fileURLToPath(new URL("../src/core/auth-storage.ts", import.meta.url)))};
		import { existsSync } from "node:fs";
		const storage = AuthStorage.create(${JSON.stringify(path)});
		await storage.modify(${JSON.stringify(provider)}, async (current) => {
			console.log("entered");
			while (!existsSync(${JSON.stringify(finishPath)})) await Bun.sleep(10);
			return { ...current, access: " raw access ", refresh: " raw refresh ", expires: 1000, metadata: ["duplicate", "duplicate", ""] };
		});
		`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const errors = readStreamText(child.stderr);
	const output = child.stdout!.getReader();
	let queued: Promise<unknown> | undefined;
	try {
		const entered = await output.read();
		assert.match(new TextDecoder().decode(entered.value), /entered/);
		let rotations = 0;
		queued = storage.modify(provider, async (current) => {
			if (current?.type === "oauth" && current.expires === 0) rotations++;
			return undefined;
		});
		const controller = new AbortController();
		const reason = new Error("queued cancellation");
		let cancelledCallback = false;
		const cancelled = storage.modify(
			provider,
			async () => {
				cancelledCallback = true;
				return undefined;
			},
			{ signal: controller.signal },
		);
		controller.abort(reason);
		await assert.rejects(cancelled, (error) => error === reason);
		writeFileSync(finishPath, "finish");
		assert.equal(await child.exited, 0, await errors);
		await queued;
		await storage.modify(provider, async () => undefined);
		assert.equal(cancelledCallback, false);
		assert.equal(rotations, 0);
		assert.deepEqual(await storage.read(provider), {
			type: "oauth",
			access: " raw access ",
			refresh: " raw refresh ",
			expires: 1000,
			metadata: ["duplicate", "duplicate", ""],
		});
	} finally {
		writeFileSync(finishPath, "finish");
		await child.exited;
		await queued;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("cancellation while awaiting the short file commit cannot persist a late credential (#3429)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "auth-3429-commit-"));
	const path = join(directory, "auth.json");
	const backend = new FileAuthStorageBackend(path);
	const storage = AuthStorage.fromStorage(backend);
	await storage.modify("provider", async () => ({ type: "api_key", key: "old" }));
	const locked = gate();
	const release = gate();
	const entered = gate();
	const owner = backend.withLockAsync(async () => {
		locked.release();
		await release.promise;
		return { result: undefined };
	});
	const controller = new AbortController();
	try {
		await locked.promise;
		const pending = storage.modify(
			"provider",
			async () => {
				entered.release();
				return { type: "api_key", key: "late" };
			},
			{ signal: controller.signal },
		);
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		release.release();
		await owner;
		await storage.modify("provider", async () => undefined);
		assert.deepEqual(await storage.read("provider"), { type: "api_key", key: "old" });
	} finally {
		release.release();
		await owner;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("file-backed started OAuth rotation persists after caller cancellation without holding the shared file lock (#3429)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "auth-3429-cancel-"));
	const path = join(directory, "auth.json");
	const storage = AuthStorage.create(path);
	const other = AuthStorage.create(path);
	const old = { type: "oauth" as const, access: "old", refresh: "old", expires: 0 };
	await storage.modify("provider", async () => old);
	await storage.modify("other", async () => ({ type: "api_key", key: "remove" }));
	const entered = gate();
	const finish = gate();
	const controller = new AbortController();
	let rotationSignal: AbortSignal | undefined;
	const rotated = { ...old, access: " new ", refresh: " rotated ", expires: 1000, metadata: ["", "same", "same"] };
	const pending = refreshStoredOAuthCredential(
		storage,
		"provider",
		{
			name: "Synthetic",
			login: async () => old,
			refresh: async (_credential, signal) => {
				rotationSignal = signal;
				entered.release();
				await finish.promise;
				return rotated;
			},
			toAuth: async () => ({ apiKey: "unused" }),
		},
		() => true,
		controller.signal,
	);
	try {
		await entered.promise;
		controller.abort(new Error("caller cancelled"));
		assert.equal(rotationSignal?.aborted, false);
		await other.delete("other");
		finish.release();
		assert.equal(await pending, rotated);
		const persisted = AuthStorage.create(path);
		assert.deepEqual(await persisted.read("provider"), rotated);
		assert.equal(await persisted.read("other"), undefined);
	} finally {
		finish.release();
		await pending;
		rmSync(directory, { recursive: true, force: true });
	}
});
