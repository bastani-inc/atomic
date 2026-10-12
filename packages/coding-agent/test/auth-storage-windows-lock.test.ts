import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.js";

describe("Windows auth lock acquisition (#10801)", () => {
	const originalPlatform = process.platform;
	let directory: string;
	let backend: FileAuthStorageBackend;
	const eperm = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });
	const setPlatform = (platform: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value: platform, configurable: true });

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "auth-windows-lock-"));
		writeFileSync(join(directory, "auth.json"), "{}");
		backend = new FileAuthStorageBackend(join(directory, "auth.json"));
	});
	afterEach(() => {
		setPlatform(originalPlatform);
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	it("retries a transient Windows EPERM asynchronously", async () => {
		setPlatform("win32");
		const release = vi.fn(async () => {});
		vi.spyOn(lockfile, "lock").mockRejectedValueOnce(eperm()).mockResolvedValueOnce(release);
		assert.equal(await backend.withLockAsync(async () => ({ result: "updated" })), "updated");
		assert.equal(release.mock.calls.length, 1);
	});

	it("bounds persistent Windows EPERM retries", async () => {
		setPlatform("win32");
		const lock = vi.spyOn(lockfile, "lock").mockRejectedValue(eperm());
		const update = vi.fn(async () => ({ result: undefined }));
		await assert.rejects(backend.withLockAsync(update), { code: "EPERM" });
		assert.equal(lock.mock.calls.length, 6);
		assert.equal(update.mock.calls.length, 0);
	});

	it("does not retry EPERM on other platforms", async () => {
		setPlatform("linux");
		const lock = vi.spyOn(lockfile, "lock").mockRejectedValue(eperm());
		await assert.rejects(
			backend.withLockAsync(async () => ({ result: undefined })),
			{ code: "EPERM" },
		);
		assert.equal(lock.mock.calls.length, 1);
	});

	it("retries a transient Windows EPERM synchronously", () => {
		setPlatform("win32");
		const release = vi.fn();
		vi.spyOn(lockfile, "lockSync")
			.mockImplementationOnce(() => {
				throw eperm();
			})
			.mockReturnValueOnce(release);
		assert.equal(
			backend.withLock(() => ({ result: "updated" })),
			"updated",
		);
		assert.equal(release.mock.calls.length, 1);
	});
});
