import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import * as fs from "node:fs/promises";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { usesNativePlainSync } from "../../packages/coding-agent/src/core/storage/file-sync.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

/**
 * File-system requests the JSONL session store makes for its common operations (#6560, #6718). Each request is one
 * trip to libuv's thread pool and one system call. Under #6718's advisory group lock, an uncontended operation that
 * opens and closes the mixed-version `.session.lock` group makes 12 libuv lock requests (checking `.dead` and
 * `.session.lock`, creating/backdating/statting `.staging`, opening/writing/closing `.group`, and on release statting
 * `.session.lock`, removing it, and opening/closing `.group` with `O_TRUNC`; the kernel advisory locks and atomic
 * rename run natively outside libuv). Since #6686 each group of appends also syncs its lines once before it is
 * acknowledged; on macOS the native plain fsync runs outside libuv.
 */
const LOCK_REQUESTS = 12;
/** An unlocked read checks that `.session.lock` is absent and re-stats the file path after reading (#6719). */
const UNLOCKED_CHECK_REQUESTS = 2;
/** Windows closes a session file's handle once its appends are written, so each append opens and closes it again. */
const KEEPS_HANDLES = process.platform !== "win32";
/** Native plain fsync on macOS runs on the addon's worker thread rather than libuv's FSREQPROMISE pool. */
const SYNC_REQUESTS = usesNativePlainSync() ? 0 : 1;

const CREATED_AT = "2026-11-25T00:00:00.000Z";
const header = (id: string) => ({ id, version: 4 as const, createdAt: CREATED_AT, cwd: "/project" });
function message(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: CREATED_AT,
		message: { role: "user", content: `text of ${id}`, timestamp: 1 },
	} as SessionEntry;
}

/** The fs requests `work` makes, counted as libuv receives them, and the writes among them. */
async function countFsRequests<T>(work: () => Promise<T>): Promise<{ requests: number; result: T }> {
	let requests = 0;
	const hook = createHook({
		init(_id, type) {
			if (type === "FSREQPROMISE" || type === "FSREQCALLBACK") requests++;
		},
	});
	hook.enable();
	try {
		const result = await work();
		return { requests, result };
	} finally {
		hook.disable();
	}
}

describe("JSONL session store file-system requests (#6560)", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "jsonl-fs-requests-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	async function seeded(entries = 40) {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const base: SessionEntry[] = [];
		for (let index = 0; index < entries; index++) base.push(message(`e${index}`, base.at(-1)?.id ?? null));
		await store.create(header("seed"), base);
		return { store, base };
	}

	it("appends through the handle it keeps: the lock, a stat, a header read, one write, its sync and its stat", async () => {
		const { store, base } = await seeded();
		try {
			await store.append("seed", [message("first", base.at(-1)!.id)], { expectSeq: 40 });
			const { requests, result } = await countFsRequests(() =>
				store.append("seed", [message("second", "first")], { expectSeq: 41 }),
			);
			assert.deepEqual(result, { lastSeq: 42 });
			if (KEEPS_HANDLES) assert.equal(requests, LOCK_REQUESTS + 4 + SYNC_REQUESTS);
			else assert.ok(requests <= LOCK_REQUESTS + 8, `${requests} requests`);
		} finally {
			await store.close();
		}
	});

	it("commits appends made together in one lock, one write and one sync, each resolving with its own sequence", async () => {
		const { store, base } = await seeded();
		try {
			await store.append("seed", [message("first", base.at(-1)!.id)], { expectSeq: 40 });
			const entries = Array.from({ length: 10 }, (_, index) => message(`together-${index}`, null));
			const { requests, result } = await countFsRequests(() =>
				Promise.all(entries.map((entry, index) => store.append("seed", [entry], { expectSeq: 41 + index }))),
			);
			assert.deepEqual(
				result.map(({ lastSeq }) => lastSeq),
				Array.from({ length: 10 }, (_, index) => 42 + index),
			);
			// The same as one append alone: ten appends made 180 requests before #6560.
			if (KEEPS_HANDLES) assert.equal(requests, LOCK_REQUESTS + 4 + SYNC_REQUESTS);
			else assert.ok(requests <= LOCK_REQUESTS + 8, `${requests} requests`);
			assert.deepEqual((await store.load("seed")).entries.slice(41), entries);
		} finally {
			await store.close();
		}
	});

	it("reads an indexed session's tail unlocked with fstat, header, end, tail and the two post-read checks (#6719)", async () => {
		const { store, base } = await seeded();
		try {
			await store.append("seed", [message("first", base.at(-1)!.id)], { expectSeq: 40 });
			await store.readTail("seed", 36);
			const { requests, result } = await countFsRequests(() => store.readTail("seed", 36));
			assert.deepEqual(
				result.entries.map((entry) => entry.id),
				["e35", "e36", "e37", "e38", "e39", "first"],
			);
			if (KEEPS_HANDLES) assert.equal(requests, UNLOCKED_CHECK_REQUESTS + 4);
			else assert.ok(requests <= UNLOCKED_CHECK_REQUESTS + 6, `${requests} requests`);
		} finally {
			await store.close();
		}
	});

	it("reads load, readRange and readResume unlocked with one fewer request than taking the lock (#6719)", async () => {
		const { store, base } = await seeded();
		try {
			await store.append("seed", [message("first", base.at(-1)!.id)], { expectSeq: 40 });
			await store.readResume("seed");
			const loaded = await countFsRequests(() => store.load("seed"));
			assert.equal(loaded.result.lastSeq, 41);
			if (KEEPS_HANDLES) assert.equal(loaded.requests, UNLOCKED_CHECK_REQUESTS + 3);
			else assert.ok(loaded.requests <= UNLOCKED_CHECK_REQUESTS + 5, `${loaded.requests} requests`);

			const ranged = await countFsRequests(() => store.readRange("seed", 36, 41));
			assert.equal(ranged.result.entries.length, 6);
			if (KEEPS_HANDLES) assert.equal(ranged.requests, UNLOCKED_CHECK_REQUESTS + 4);
			else assert.ok(ranged.requests <= UNLOCKED_CHECK_REQUESTS + 6, `${ranged.requests} requests`);

			const resumed = await countFsRequests(() => store.readResume("seed"));
			assert.equal(resumed.result.lastSeq, 41);
			if (KEEPS_HANDLES) assert.equal(resumed.requests, UNLOCKED_CHECK_REQUESTS + 4);
			else assert.ok(resumed.requests <= UNLOCKED_CHECK_REQUESTS + 6, `${resumed.requests} requests`);
		} finally {
			await store.close();
		}
	});

	it("reopens a directory whose files have not changed with one listing and one stat per file", async () => {
		const { store } = await seeded();
		await store.create(header("other"), []);
		await store.close();
		const { requests, result: reopened } = await countFsRequests(() =>
			JsonlSessionStore.open(directory, { exactDirectory: true }),
		);
		try {
			assert.equal(requests, 1 + 2);
			assert.equal((await reopened.load("seed")).lastSeq, 40);
			assert.equal((await reopened.load("other")).lastSeq, 0);
		} finally {
			await reopened.close();
		}
	});

	it("reads foreign appends during forWrite catch-up through the kept handle without reopening (#6717)", async () => {
		const { store, base } = await seeded(4);
		try {
			await store.append("seed", [message("first", base.at(-1)!.id)], { expectSeq: 4 });
			const path = (await store.findFile("seed"))!;
			await appendFile(path, `${JSON.stringify(message("foreign", "first"))}\n`);
			const opened: string[] = [];
			const originalOpen = fs.open;
			const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				opened.push(String(args[0]));
				return originalOpen(...args);
			});
			try {
				const { requests, result } = await countFsRequests(() =>
					store.append("seed", [message("second", "foreign")], { expectSeq: 6 }),
				);
				assert.deepEqual(result, { lastSeq: 7 });
				if (KEEPS_HANDLES) {
					assert.deepEqual(opened, [], "forWrite catch-up must reuse the kept handle without opening the file");
					// stat, header read, boundary+tail read through kept handle, write, [sync], stat.
					assert.equal(requests, LOCK_REQUESTS + 5 + SYNC_REQUESTS);
				}
			} finally {
				spy.mockRestore();
			}
			assert.deepEqual(
				(await store.load("seed")).entries.slice(-3).map((entry) => entry.id),
				["first", "foreign", "second"],
			);
		} finally {
			await store.close();
		}
	});

	it("batches chat record index and slot opens for promptBefore and concurrent appends (#6717)", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			const created = await store.create(header("chat-batch"), [message("a1", null), message("a2", "a1")]);
			const path = (await store.findFile("chat-batch"))!;
			const owner = { id: "chat-batch", file: path, epoch: created.epoch! };

			const opened: string[] = [];
			const originalOpen = fs.open;
			const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				opened.push(basename(String(args[0])));
				return originalOpen(...args);
			});
			try {
				await store.chatRecords.append(owner, "a1", { kind: "promptBefore", promptId: "p1" });
				const indexOpensForPromptBefore = opened.filter((name) => /^\.atomic-chat-[0-9a-f]{64}$/.test(name));
				// First promptBefore creates index (1 owned check + 1 create) once for BOTH anchor & order slots (not twice).
				assert.equal(indexOpensForPromptBefore.length, 2, indexOpensForPromptBefore.join(", "));

				opened.length = 0;
				await Promise.all([
					store.chatRecords.append(owner, "a1", { kind: "line", level: "warning", text: "first" }),
					store.chatRecords.append(owner, "a1", { kind: "line", level: "warning", text: "second" }),
					store.chatRecords.append(owner, "a2", { kind: "promptBefore", promptId: "p2" }),
				]);
				const batchIndexOpens = opened.filter((name) => /^\.atomic-chat-[0-9a-f]{64}$/.test(name));
				const batchSlotOpens = opened.filter((name) => /^\.atomic-chat-[0-9a-f]{64}\.[0-9a-f]{64}$/.test(name));
				// Three concurrent chat appends share one index open and one open per unique slot (a1, a2, orders; a2 is new so owned+create = 2 -> 4 total).
				assert.equal(batchIndexOpens.length, 1, batchIndexOpens.join(", "));
				assert.equal(batchSlotOpens.length, 4, batchSlotOpens.join(", "));
			} finally {
				spy.mockRestore();
			}

			const records = await store.chatRecords.read(owner, ["a1", "a2"]);
			assert.deepEqual(
				records.map(({ anchor, record }) => [anchor, record.kind === "line" ? record.text : record.promptId]),
				[
					["a1", "p1"],
					["a1", "first"],
					["a1", "second"],
					["a2", "p2"],
				],
			);
			assert.deepEqual(await store.chatRecords.readOrders?.(owner, ["p1", "p2"]), [
				{ anchor: "a1", promptId: "p1" },
				{ anchor: "a2", promptId: "p2" },
			]);
		} finally {
			await store.close();
		}
	});
});
