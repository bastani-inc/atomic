import assert from "node:assert/strict";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { StorageUnavailableError } from "../src/core/storage/session/errors.js";
import { JsonlSessionStore, type SessionLockFs } from "../src/core/storage/session/jsonl-session-store.js";

const hooks = vi.hoisted(() => ({
	readdirError: undefined as Error | undefined,
	beforeRead: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readdir: ((...args: Parameters<typeof actual.readdir>) => {
			hooks.beforeRead?.();
			return hooks.readdirError ? Promise.reject(hooks.readdirError) : actual.readdir(...args);
		}) as typeof actual.readdir,
	};
});

const HEADER = { id: "lock-acquire", version: 4 as const, createdAt: "2026-11-05T00:00:00.000Z", cwd: "/project" };
const LOCK_ATTEMPTS_ON_REFUSAL = 8;

function refusingMkdir(
	code: string,
	refusals: number,
	onRefuse?: () => void,
): { fs: SessionLockFs; attempts: () => number } {
	let attempts = 0;
	const lockFs: SessionLockFs = {
		mkdir: ((path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
			attempts++;
			if (attempts <= refusals) {
				onRefuse?.();
				callback(Object.assign(new Error(`${code}: operation not permitted, mkdir '${String(path)}'`), { code }));
				return;
			}
			fs.mkdir(path, callback);
		}) as unknown as SessionLockFs["mkdir"],
		rmdir: fs.rmdir,
		stat: fs.stat,
		utimes: fs.utimes,
		realpath: fs.realpath,
	};
	return { fs: lockFs, attempts: () => attempts };
}

describe("taking the session lock when Windows refuses its directory for a moment", () => {
	const originalPlatform = process.platform;
	const setPlatform = (platform: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "session-lock-acquire-"));
	});
	afterEach(() => {
		setPlatform(originalPlatform);
		hooks.readdirError = undefined;
		hooks.beforeRead = undefined;
		rmSync(directory, { recursive: true, force: true });
	});
	const open = (lockFs: SessionLockFs) =>
		JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false, lockFs });

	it("retries EPERM and completes the operation once the directory can be created (#4319)", async () => {
		setPlatform("win32");
		const refusing = refusingMkdir("EPERM", 3);
		const store = await open(refusing.fs);
		try {
			await store.create(HEADER, []);
			assert.equal(refusing.attempts(), 4);
			assert.equal((await store.load(HEADER.id)).header.id, HEADER.id);
			assert.equal(existsSync(join(directory, ".session.lock")), false);
		} finally {
			await store.close();
		}
	});

	it("reports persistent EPERM with its original cause after bounded attempts (#4319)", async () => {
		setPlatform("win32");
		const refusing = refusingMkdir("EPERM", Number.POSITIVE_INFINITY);
		const store = await open(refusing.fs);
		try {
			await assert.rejects(store.create(HEADER, []), (error: unknown) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal((error.cause as NodeJS.ErrnoException).code, "EPERM");
				return true;
			});
			assert.equal(refusing.attempts(), LOCK_ATTEMPTS_ON_REFUSAL);
		} finally {
			await store.close();
		}
	});

	it("does not retry EPERM on other platforms (#4319)", async () => {
		setPlatform("linux");
		const refusing = refusingMkdir("EPERM", 1);
		const store = await open(refusing.fs);
		try {
			await assert.rejects(store.create(HEADER, []), (error: unknown) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal((error.cause as NodeJS.ErrnoException).code, "EPERM");
				return true;
			});
			assert.equal(refusing.attempts(), 1);
		} finally {
			await store.close();
		}
	});

	it("does not retry other errors on Windows (#4319)", async () => {
		setPlatform("win32");
		const refusing = refusingMkdir("EACCES", 1);
		const store = await open(refusing.fs);
		try {
			await assert.rejects(store.create(HEADER, []), (error: unknown) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
				return true;
			});
			assert.equal(refusing.attempts(), 1);
		} finally {
			await store.close();
		}
	});

	it("propagates the caller's cancellation reason before the operation starts (#4319)", async () => {
		setPlatform("win32");
		const controller = new AbortController();
		const reason = new Error("listing cancelled by its caller");
		const refusing = refusingMkdir("EPERM", Number.POSITIVE_INFINITY, () => controller.abort(reason));
		const store = await open(refusing.fs);
		try {
			await assert.rejects(
				(async () => {
					for await (const _summary of store.list({ signal: controller.signal })) {
						assert.fail("the listing ran without the lock");
					}
				})(),
				(error: object) => error === reason,
			);
			assert.equal(refusing.attempts(), 1);
		} finally {
			await store.close();
		}
	});

	it("never repeats an operation that failed after it had the lock (#4319)", async () => {
		setPlatform("win32");
		const refusing = refusingMkdir("EPERM", 0);
		const store = await open(refusing.fs);
		try {
			hooks.readdirError = Object.assign(new Error("EPERM: operation not permitted, scandir"), { code: "EPERM" });
			await assert.rejects(
				(async () => {
					for await (const _summary of store.list({})) {
						assert.fail("the listing had nothing to read");
					}
				})(),
				(error: unknown) => {
					assert.ok(error instanceof StorageUnavailableError);
					assert.equal((error.cause as NodeJS.ErrnoException).code, "EPERM");
					return true;
				},
			);
			assert.equal(refusing.attempts(), 1);
		} finally {
			await store.close();
		}
	});
	it("keeps an unrelated storage failure typed when cancellation races it (#4319)", async () => {
		setPlatform("win32");
		const controller = new AbortController();
		const reason = new Error("listing cancelled by its caller");
		const failure = Object.assign(new Error("scandir refused"), { code: "EACCES" });
		const refusing = refusingMkdir("EPERM", 0);
		const store = await open(refusing.fs);
		try {
			hooks.beforeRead = () => controller.abort(reason);
			hooks.readdirError = failure;
			await assert.rejects(
				(async () => {
					for await (const _summary of store.list({ signal: controller.signal })) {
						assert.fail("the listing failed before returning a session");
					}
				})(),
				(error: object) => {
					assert.ok(error instanceof StorageUnavailableError);
					assert.equal(error.cause, failure);
					return true;
				},
			);
			assert.equal(refusing.attempts(), 1);
		} finally {
			await store.close();
		}
	});
});
