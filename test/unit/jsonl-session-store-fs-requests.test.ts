import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

/**
 * File-system requests the JSONL session store makes for its common operations (#6560). Each request is one trip to
 * libuv's thread pool and one system call: the session lock's own (take the lock directory, read its time, remove it)
 * and the store's. Before #6560 one append took 18 of them on macOS and 11 on Linux, ten appends made together 180 on
 * macOS, a tail read of an indexed session 22 and reopening a directory of two sessions 31.
 */
const LOCK_REQUESTS = 3;
/** Windows closes a session file's handle once its appends are written, so each append opens and closes it again. */
const KEEPS_HANDLES = process.platform !== "win32";

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

	it("appends through the handle it keeps: the lock, a stat, a header read, one write and its stat", async () => {
		const { store, base } = await seeded();
		try {
			await store.append("seed", [message("first", base.at(-1)!.id)], { expectSeq: 40 });
			const { requests, result } = await countFsRequests(() =>
				store.append("seed", [message("second", "first")], { expectSeq: 41 }),
			);
			assert.deepEqual(result, { lastSeq: 42 });
			if (KEEPS_HANDLES) assert.equal(requests, LOCK_REQUESTS + 4);
			else assert.ok(requests <= LOCK_REQUESTS + 8, `${requests} requests`);
		} finally {
			await store.close();
		}
	});

	it("commits appends made together in one lock and one write, each resolving with its own sequence", async () => {
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
			if (KEEPS_HANDLES) assert.equal(requests, LOCK_REQUESTS + 4);
			else assert.ok(requests <= LOCK_REQUESTS + 8, `${requests} requests`);
			assert.deepEqual((await store.load("seed")).entries.slice(41), entries);
		} finally {
			await store.close();
		}
	});

	it("reads an indexed session's tail with the lock, a stat, and its header, end and tail through the kept handle", async () => {
		const { store, base } = await seeded();
		try {
			await store.append("seed", [message("first", base.at(-1)!.id)], { expectSeq: 40 });
			await store.readTail("seed", 36);
			const { requests, result } = await countFsRequests(() => store.readTail("seed", 36));
			assert.deepEqual(
				result.entries.map((entry) => entry.id),
				["e35", "e36", "e37", "e38", "e39", "first"],
			);
			if (KEEPS_HANDLES) assert.equal(requests, LOCK_REQUESTS + 4);
			else assert.ok(requests <= LOCK_REQUESTS + 8, `${requests} requests`);
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
});
