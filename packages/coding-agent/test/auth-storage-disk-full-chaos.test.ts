import assert from "node:assert/strict";
import type * as nodeFs from "node:fs";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage-backends.js";

const diskFull = vi.hoisted(() => ({ enabled: false, failures: 0, tempFile: /[\\/]\.auth\.[^\\/]+\.tmp$/u }));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFs>();
	const writeFileSync = ((
		file: nodeFs.PathOrFileDescriptor,
		data: string | NodeJS.ArrayBufferView,
		options?: nodeFs.WriteFileOptions,
	) => {
		if (diskFull.enabled && typeof file === "string" && diskFull.tempFile.test(file)) {
			diskFull.failures += 1;
			actual.writeFileSync(file, String(data).slice(0, 8), options);
			throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), {
				code: "ENOSPC",
				errno: -28,
				syscall: "write",
			});
		}
		actual.writeFileSync(file, data, options);
	}) as typeof actual.writeFileSync;
	return { ...actual, writeFileSync };
});

const STORED = { anthropic: { type: "api_key", key: "anthropic-key" } };

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("auth.json writes on a full disk (pi #11655)", () => {
	let directory: string;
	let authPath: string;
	let aliasPath: string;
	let layerPath: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "atomic-auth-disk-full-"));
		authPath = join(directory, "auth.json");
		aliasPath = join(directory, "alias.json");
		layerPath = join(directory, "layer.json");
		writeFileSync(authPath, JSON.stringify(STORED));
		writeFileSync(layerPath, JSON.stringify(STORED));
		symlinkSync(authPath, aliasPath);
		diskFull.failures = 0;
	});

	afterEach(() => {
		diskFull.enabled = false;
		rmSync(directory, { recursive: true, force: true });
	});

	function assertNothingChanged(error: unknown): void {
		assert.equal((error as NodeJS.ErrnoException | undefined)?.code, "ENOSPC");
		assert.equal(diskFull.failures, 1);
		assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), STORED);
		assert.deepEqual(JSON.parse(readFileSync(layerPath, "utf8")), STORED);
		assert.equal(lstatSync(aliasPath).isSymbolicLink(), true);
		assert.deepEqual(
			readdirSync(directory).filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock")),
			[],
		);
	}

	const failingWrite = (): { result: undefined; next: string } => ({ result: undefined, next: JSON.stringify({}) });

	posixOnly("keeps the real file, the symlink and the lock intact when a locked write fails", () => {
		const backend = new FileAuthStorageBackend(aliasPath, [aliasPath]);
		diskFull.enabled = true;
		let error: unknown;
		try {
			backend.withLock(failingWrite);
		} catch (thrown) {
			error = thrown;
		}
		assertNothingChanged(error);

		diskFull.enabled = false;
		backend.withLock(failingWrite);
		assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
		assert.equal(lstatSync(aliasPath).isSymbolicLink(), true);
	});

	posixOnly("keeps the real file, the symlink and the lock intact when an async locked write fails", async () => {
		const backend = new FileAuthStorageBackend(aliasPath, [aliasPath]);
		diskFull.enabled = true;
		const error = await backend
			.withLockAsync(async () => failingWrite())
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
		assertNothingChanged(error);

		diskFull.enabled = false;
		await backend.withLockAsync(async () => failingWrite());
		assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
	});

	posixOnly("keeps every layered file intact when logout cannot write", async () => {
		const backend = new FileAuthStorageBackend(aliasPath, [aliasPath, layerPath]);
		diskFull.enabled = true;
		let syncError: unknown;
		try {
			backend.deleteProvider("anthropic");
		} catch (thrown) {
			syncError = thrown;
		}
		assertNothingChanged(syncError);

		diskFull.failures = 0;
		const asyncError = await backend.deleteProviderAsync("anthropic").then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		assertNothingChanged(asyncError);

		diskFull.enabled = false;
		assert.deepEqual(JSON.parse(backend.deleteProvider("anthropic") ?? "{}"), {});
		assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {});
		assert.deepEqual(JSON.parse(readFileSync(layerPath, "utf8")), {});
		assert.equal(lstatSync(aliasPath).isSymbolicLink(), true);
	});
});
