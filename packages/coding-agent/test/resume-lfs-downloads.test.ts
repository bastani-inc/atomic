import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { LFS_DOWNLOAD_CONCURRENCY, LfsDownloads } from "../src/core/resume/lfs-downloads.ts";
import { formatWorktreeRestoreWarning } from "../src/core/session-worktree-snapshots.ts";

/** A download a test ends: `finish` resolves it with the files that still hold pointers, `fail` rejects it. */
function controlledDownload() {
	const { promise, resolve, reject } = Promise.withResolvers<readonly string[]>();
	let started = false;
	return {
		pull: () => {
			started = true;
			return promise;
		},
		get started() {
			return started;
		},
		finish: (pointers: readonly string[] = []) => resolve(pointers),
		fail: (error: Error) => reject(error),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the LFS downloads of a resume (#5099)", () => {
	test("at most LFS_DOWNLOAD_CONCURRENCY run at once, and each that ends lets the next waiting one start (#5099)", async () => {
		const downloads = new LfsDownloads();
		const started = Array.from({ length: LFS_DOWNLOAD_CONCURRENCY + 2 }, controlledDownload);
		for (const [index, download] of started.entries()) downloads.start(`/w${index}`, download.pull);
		await settle();
		assert.deepEqual(
			started.map((download) => download.started),
			started.map((_, index) => index < LFS_DOWNLOAD_CONCURRENCY),
		);
		started[0]!.finish();
		await settle();
		// A download started meanwhile waits behind the ones already waiting.
		const late = controlledDownload();
		downloads.start("/late", late.pull);
		await settle();
		assert.equal(started[LFS_DOWNLOAD_CONCURRENCY]!.started, true);
		assert.equal(started[LFS_DOWNLOAD_CONCURRENCY + 1]!.started, false);
		assert.equal(late.started, false);
		for (const download of started) download.finish();
		late.finish();
		await downloads.ready("/late");
		assert.equal(late.started, true);
		// Every place is free again once all ended.
		const again = Array.from({ length: LFS_DOWNLOAD_CONCURRENCY }, controlledDownload);
		for (const [index, download] of again.entries()) downloads.start(`/again${index}`, download.pull);
		await settle();
		assert.deepEqual(
			again.map((download) => download.started),
			again.map(() => true),
		);
		for (const download of again) download.finish();
	});

	test("ready settles once a worktree's download ended, however it ended, and at once for one without (#5099)", async () => {
		const downloads = new LfsDownloads();
		const failing = controlledDownload();
		downloads.start("/repo", failing.pull);
		let readied = false;
		const waiting = downloads.ready("/repo/").then(() => {
			readied = true;
		});
		await settle();
		assert.equal(readied, false, "the worktree's blueprint waits for its download");
		failing.fail(new Error("disk full"));
		await waiting;
		await downloads.ready("/no-download");
	});

	test("the notices say which files hold pointers or why a download failed, in the order asked (#5099)", async () => {
		const downloads = new LfsDownloads();
		const [pointers, failed, clean] = [controlledDownload(), controlledDownload(), controlledDownload()];
		downloads.start("/b", failed.pull);
		downloads.start("/a", pointers.pull);
		await settle();
		failed.fail(new Error("disk full"));
		pointers.finish(["data.bin"]);
		downloads.start("/c", clean.pull);
		clean.finish([]);
		assert.deepEqual(await downloads.notices(["/a", "/b", "/c", "/none"]), [
			{
				type: "warning",
				message: formatWorktreeRestoreWarning({ code: "lfs-objects-unavailable", paths: ["data.bin"] }),
			},
			{
				type: "warning",
				message: "Git LFS objects could not be fetched into /b, so its LFS files may hold pointers: disk full",
			},
		]);
	});
});
