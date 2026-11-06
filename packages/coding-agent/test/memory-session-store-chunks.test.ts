import assert from "node:assert/strict";
import { queryObjects } from "node:v8";
import { afterEach, describe, test, vi } from "vitest";
import type { CustomEntry } from "../src/core/session-manager-types.js";
import { StorageUnavailableError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";

/**
 * How the in-memory store holds a session's appends (#4403): each append's UTF-8 bytes are merged with the buffers
 * before them while those are less than twice their size, so an idle agent's history sits in a few buffers rather
 * than one per append, and appends copy each byte a logarithmic number of times.
 */
const header = (id: string) => ({ id, version: 4 as const, createdAt: "2026-11-06T00:00:00.000Z", cwd: "/repo" });

function entry(id: string, text: string): CustomEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-11-06T00:00:00.000Z",
		customType: "note",
		data: { text },
	};
}

/** An entry whose JSON is exactly `bytes` bytes long, as one append encodes it. */
function entryOfBytes(id: string, bytes: number): CustomEntry {
	const base = Buffer.byteLength(JSON.stringify(entry(id, "")));
	assert.ok(bytes >= base, `an entry is at least ${base} bytes`);
	const sized = entry(id, "x".repeat(bytes - base));
	assert.equal(Buffer.byteLength(JSON.stringify(sized)), bytes);
	return sized;
}

/** Bytes the store copies into merged buffers while `operation` runs. */
async function bytesCopiedBy<T>(operation: () => Promise<T>): Promise<number> {
	const set = vi.spyOn(Uint8Array.prototype, "set");
	try {
		await operation();
		return set.mock.calls.reduce((sum, [source]) => sum + (source as Uint8Array).byteLength, 0);
	} finally {
		set.mockRestore();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("in-memory history is held in a logarithmic number of buffers (#4403)", () => {
	test("an append smaller than half the newest buffer is kept apart, copying nothing until a load joins them once", async () => {
		const store = new MemorySessionStore();
		await store.create(header("s"), []);
		await store.append("s", [entryOfBytes("p", 400)], { expectSeq: 0 });

		assert.equal(await bytesCopiedBy(() => store.append("s", [entryOfBytes("q", 200)], { expectSeq: 1 })), 0);
		let loaded: Awaited<ReturnType<MemorySessionStore["load"]>> | undefined;
		assert.equal(
			await bytesCopiedBy(async () => {
				loaded = await store.load("s");
			}),
			400 + 200,
			"a load joins the two buffers",
		);
		assert.deepEqual(
			loaded?.entries.map((saved) => saved.id),
			["p", "q"],
		);
		assert.equal(await bytesCopiedBy(() => store.load("s")), 0, "a session held in one buffer loads without a copy");
	});

	test("an append at least half the newest buffer's size merges with it and the buffers before it, counting each comma", async () => {
		const store = new MemorySessionStore();
		await store.create(header("s"), []);
		await store.append("s", [entryOfBytes("p", 801)], { expectSeq: 0 });
		assert.equal(await bytesCopiedBy(() => store.append("s", [entryOfBytes("q", 200)], { expectSeq: 1 })), 0);

		// q and r merge into 401 bytes with their comma; 801 is less than twice that, so p joins them too.
		assert.equal(
			await bytesCopiedBy(() => store.append("s", [entryOfBytes("r", 200)], { expectSeq: 2 })),
			801 + 200 + 200,
		);
		const loaded = await store.load("s");
		assert.deepEqual(
			loaded.entries.map((saved) => saved.id),
			["p", "q", "r"],
		);
		assert.equal(loaded.lastSeq, 3);
	});

	test("many appends keep at most log2(bytes) + 1 buffers per session and copy each byte at most log2(appends) times", async () => {
		const store = new MemorySessionStore();
		const sessions = 20;
		const appends = 256;
		const entryBytes = 300;
		for (let session = 0; session < sessions; session++) await store.create(header(`s-${session}`), []);
		const buffersBefore = queryObjects(ArrayBuffer, { format: "count" }) as number;

		const copied = await bytesCopiedBy(async () => {
			for (let index = 0; index < appends; index++)
				for (let session = 0; session < sessions; session++)
					await store.append(`s-${session}`, [entryOfBytes(`e-${index}`, entryBytes)], { expectSeq: index });
		});
		const buffersAfter = queryObjects(ArrayBuffer, { format: "count" }) as number;

		const sessionBytes = appends * entryBytes + appends - 1;
		const bound = Math.floor(Math.log2(sessionBytes)) + 1;
		assert.ok(
			buffersAfter - buffersBefore <= sessions * bound,
			`${sessions} sessions of ${appends} appends hold ${buffersAfter - buffersBefore} buffers, at most ${sessions * bound} allowed`,
		);
		assert.ok(
			copied <= sessions * sessionBytes * Math.log2(appends),
			`appends copied ${copied} bytes, at most ${sessions * sessionBytes * Math.log2(appends)} allowed`,
		);
		const loaded = await store.load("s-7");
		assert.equal(loaded.entries.length, appends);
		assert.deepEqual(loaded.entries.at(-1), entryOfBytes(`e-${appends - 1}`, entryBytes));
		assert.deepEqual(loaded.entries[0], entryOfBytes("e-0", entryBytes));
	});

	test("a merge that fails rejects as storage unavailable and leaves the session as it was, so the append can be retried", async () => {
		const store = new MemorySessionStore();
		await store.create(header("s"), []);
		await store.append("s", [entryOfBytes("p", 300)], { expectSeq: 0 });
		const outOfMemory = new RangeError("Array buffer allocation failed");
		const set = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(() => {
			throw outOfMemory;
		});
		try {
			await assert.rejects(
				store.append("s", [entryOfBytes("q", 300)], { expectSeq: 1 }),
				(error: Error) => error instanceof StorageUnavailableError && error.cause === outOfMemory,
			);
		} finally {
			set.mockRestore();
		}

		await store.append("s", [entryOfBytes("q", 300)], { expectSeq: 1 });
		const loaded = await store.load("s");
		assert.deepEqual(
			loaded.entries.map((saved) => saved.id),
			["p", "q"],
		);
		assert.equal(loaded.lastSeq, 2);
	});
});
