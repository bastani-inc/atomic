import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.ts";

/**
 * The fs requests one append may make: locate (open, one header read, close, stat), the lock, the write and its
 * bookkeeping. 11 on Linux; before #4319 an append read its header one byte per request, about 160 for a short header.
 */
const APPEND_FS_OPERATION_BOUND = 16;
/** One read takes the header line of any ordinary session (#4319). */
const HEADER_READ_CHUNK_BYTES = 64 * 1024;

const CREATED_AT = "2026-11-05T00:00:00.000Z";

function header(id: string, cwd: string) {
	return { id, version: 4 as const, createdAt: CREATED_AT, cwd };
}

function info(id: string): Parameters<JsonlSessionStore["append"]>[1][number] {
	return { type: "session_info", id, parentId: null, timestamp: CREATED_AT, name: id };
}

/** Every fs request a callback counts: each one is a trip through the event loop, one turn of its wait. */
async function countFsOperations<T>(
	work: () => Promise<T>,
): Promise<{ readonly operations: number; readonly result: T }> {
	let operations = 0;
	const hook = createHook({
		init(_id, type) {
			if (type === "FSREQPROMISE" || type === "FSREQCALLBACK") operations++;
		},
	});
	hook.enable();
	try {
		const result = await work();
		return { operations, result };
	} finally {
		hook.disable();
	}
}

/** Counts the reads every `FileHandle` makes while `work` runs. */
async function countFileReads<T>(directory: string, work: () => Promise<T>) {
	const probe = await open(join(directory, "probe"), "w");
	const prototype = Object.getPrototypeOf(probe) as { read: (...args: never[]) => Promise<{ bytesRead: number }> };
	await probe.close();
	const read = prototype.read;
	const lengths: number[] = [];
	prototype.read = async function (this: unknown, ...args: never[]) {
		const result = await read.apply(this, args);
		lengths.push(result.bytesRead);
		return result;
	};
	try {
		return { result: await work(), lengths };
	} finally {
		prototype.read = read;
	}
}

describe("JsonlSessionStore header reads (#4319)", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "session-header-reads-"));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	async function storeWith(id: string, cwd: string) {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		await store.create(header(id, cwd), []);
		await store.append(id, [info(`${id}-first`)], { expectSeq: 0 });
		return store;
	}

	it("appends with a fixed number of fs operations, however long the header is", async () => {
		const short = await storeWith("short", "/p");
		const long = await storeWith("long", `/${"deep/".repeat(800)}`);
		try {
			const shortAppend = await countFsOperations(() => short.append("short", [info("s2")], { expectSeq: 1 }));
			const longAppend = await countFsOperations(() => long.append("long", [info("l2")], { expectSeq: 1 }));
			assert.ok(shortAppend.operations <= APPEND_FS_OPERATION_BOUND, `${shortAppend.operations} fs requests`);
			assert.equal(longAppend.operations, shortAppend.operations, "a longer header costs no more requests");
			assert.equal(longAppend.result.lastSeq, 2);
		} finally {
			await short.close();
			await long.close();
		}
	});

	function headerLine(id: string, cwd: string): number {
		return Buffer.byteLength(`${JSON.stringify({ type: "session", ...header(id, cwd) })}\n`);
	}

	it("reads the header of a session it knows in one read of exactly that line, however long", async () => {
		for (const [id, cwd] of [
			["known-short", `/${"deep/".repeat(800)}`],
			["known-long", `/${"é".repeat(HEADER_READ_CHUNK_BYTES)}`],
		] as const) {
			const store = await storeWith(id, cwd);
			try {
				const { result, lengths } = await countFileReads(directory, () => store.readHeader(id));
				assert.equal(result?.cwd, cwd);
				assert.deepEqual(lengths, [headerLine(id, cwd)]);
			} finally {
				await store.close();
			}
		}
	});

	it("finds an unknown session's header in reads of 64 KiB, decoding characters split between them", async () => {
		const cwd = `/${"é".repeat(HEADER_READ_CHUNK_BYTES)}`;
		const writer = await storeWith("long-header", cwd);
		await writer.close();
		const reopened = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			const { result: snapshot, lengths } = await countFileReads(directory, () => reopened.load("long-header"));
			assert.equal(snapshot.header.cwd, cwd);
			assert.equal(snapshot.lastSeq, 1);
			assert.equal(lengths.length, 3);
			assert.deepEqual(lengths.slice(0, 2), [HEADER_READ_CHUNK_BYTES, HEADER_READ_CHUNK_BYTES]);
			const scanned: string[] = [];
			for await (const file of reopened.scanFiles()) scanned.push(file.header.cwd);
			assert.deepEqual(scanned, [cwd]);
		} finally {
			await reopened.close();
		}
	});

	it("finds an ordinary unknown header in one read", async () => {
		const writer = await storeWith("short-header", "/p");
		await writer.close();
		const reopened = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			const { lengths } = await countFileReads(directory, () => reopened.readHeader("short-header"));
			assert.equal(lengths.length, 1);
		} finally {
			await reopened.close();
		}
	});
});
