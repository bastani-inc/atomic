import assert from "node:assert/strict";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { JsonlSessionStore, type SessionLockFs } from "../src/core/storage/session/jsonl-session-store.ts";

const HEADER = { id: "lock-release", version: 4 as const, createdAt: "2026-10-29T00:00:00.000Z", cwd: "/project" };

/** A session lock whose directory removal Windows refuses while another handle holds it. */
function refusingRmdir(refusals: number): { fs: SessionLockFs; attempts: () => number } {
	let attempts = 0;
	const lockFs: SessionLockFs = {
		mkdir: fs.mkdir,
		stat: fs.stat,
		utimes: fs.utimes,
		realpath: fs.realpath,
		rmdir: ((path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
			attempts++;
			if (attempts <= refusals) {
				callback(
					Object.assign(new Error(`EPERM: operation not permitted, rmdir '${String(path)}'`), { code: "EPERM" }),
				);
				return;
			}
			fs.rmdir(path, callback);
		}) as unknown as SessionLockFs["rmdir"],
	};
	return { fs: lockFs, attempts: () => attempts };
}

function info(id: string): Parameters<JsonlSessionStore["append"]>[1][number] {
	return { type: "session_info", id, parentId: null, timestamp: HEADER.createdAt, name: id };
}

describe("the session lock when its directory cannot be removed at once (Windows)", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "session-lock-release-"));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});
	const lockPath = () => join(directory, ".session.lock");

	it("retries a refused release, so the write succeeds and the next one does not wait", async () => {
		const refusing = refusingRmdir(3);
		const store = await JsonlSessionStore.open(directory, {
			exactDirectory: true,
			scanExisting: false,
			lockFs: refusing.fs,
		});
		try {
			await store.create(HEADER, []);
			// The create's own release is refused three times, then removed.
			assert.equal(existsSync(lockPath()), false);
			const started = Date.now();
			await store.append(HEADER.id, [info("a")], { expectSeq: 0 });
			await store.append(HEADER.id, [info("b")], { expectSeq: 1 });
			assert.ok(Date.now() - started < 2_000, `appends waited ${Date.now() - started} ms on a lock`);
			assert.ok(refusing.attempts() >= 4);
		} finally {
			await store.close();
		}
	});

	it("reports a write that was made, and clears its own unreleased lock at the next write, not when it goes stale", async () => {
		// 1 refusal by the release itself and 7 by its retries: the lock stays on disk.
		const refusing = refusingRmdir(8);
		const store = await JsonlSessionStore.open(directory, {
			exactDirectory: true,
			scanExisting: false,
			lockFs: refusing.fs,
		});
		try {
			await store.create(HEADER, []);
			assert.equal(existsSync(lockPath()), true, "the refused release left its lock directory");
			const started = Date.now();
			const appended = await store.append(HEADER.id, [info("a")], { expectSeq: 0 });
			assert.equal(appended.lastSeq, 1);
			assert.ok(Date.now() - started < 3_000, `the next write waited ${Date.now() - started} ms for a stale lock`);
			assert.equal(existsSync(lockPath()), false);
		} finally {
			await store.close();
		}
	}, 30_000);

	it("never takes a lock someone else now holds", async () => {
		const refusing = refusingRmdir(8);
		const store = await JsonlSessionStore.open(directory, {
			exactDirectory: true,
			scanExisting: false,
			lockFs: refusing.fs,
		});
		try {
			await store.create(HEADER, []);
			assert.equal(existsSync(lockPath()), true);
			// Another process went through the stale window and holds the directory now: its time is different.
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(lockPath(), later, later);
			let done = false;
			const appended = store.append(HEADER.id, [info("a")], { expectSeq: 0 }).then(() => {
				done = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.equal(done, false, "the write took a lock it did not hold");
			assert.equal(existsSync(lockPath()), true);
			// Its holder releases it, and the write goes through.
			rmdirSync(lockPath());
			await appended;
			assert.equal(done, true);
		} finally {
			await store.close();
		}
	}, 30_000);
});
