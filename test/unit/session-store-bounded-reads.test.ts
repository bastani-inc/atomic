import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { SessionSpillError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	readSessionHistory,
	readSessionHistoryChunks,
} from "../../packages/coding-agent/src/core/storage/session/history-pages.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { LegacySessionStore } from "../../packages/coding-agent/src/core/storage/session/legacy-session-store.js";
import {
	MemorySessionStore,
	type SessionHistoryDirectory,
	type SessionHistoryFiles,
} from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	readSessionRange,
	sessionCompactionOf,
	sessionResumeOf,
	sessionTailOf,
} from "../../packages/coding-agent/src/core/storage/session/session-resume.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";

const HISTORY = "history-5249-marker";
const createdAt = "2026-11-16T00:00:00.000Z";
const header = { id: "session", version: 4 as const, createdAt, cwd: "/project" };

function at(index: number): string {
	return new Date(Date.parse(createdAt) + index * 1000).toISOString();
}

function user(id: string, parentId: string | null, text: string, index: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at(index),
		message: { role: "user", content: text, timestamp: index },
	} as SessionEntry;
}

function assistant(id: string, parentId: string | null, text: string, index: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at(index),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "test",
			model: "model",
			usage: {
				input: 4,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
			},
			stopReason: "stop",
			timestamp: index,
		},
	} as SessionEntry;
}

function compacted(history: number): SessionEntry[] {
	const entries: SessionEntry[] = [
		{ type: "model_change", id: "m0", parentId: null, timestamp: at(0), provider: "test", modelId: "model" },
		{ type: "thinking_level_change", id: "t0", parentId: "m0", timestamp: at(1), thinkingLevel: "high" },
	] as SessionEntry[];
	for (let turn = 0; turn < history; turn++) {
		const parent = entries.at(-1)!.id;
		const padding = "x".repeat(400);
		entries.push(user(`u${turn}`, parent, `${HISTORY} question ${turn} ${padding}`, entries.length));
		entries.push(assistant(`a${turn}`, `u${turn}`, `${HISTORY} answer ${turn} ${padding}`, entries.length));
	}
	entries.push(user("kept", entries.at(-1)!.id, "kept question", entries.length));
	entries.push(assistant("kept-answer", "kept", "kept answer", entries.length));
	entries.push({
		type: "compaction",
		id: "boundary",
		parentId: "kept-answer",
		timestamp: at(entries.length),
		summary: "compacted",
		firstKeptEntryId: "kept",
		tokensBefore: 10,
		details: { strategy: "verbatim-lines" },
	} as SessionEntry);
	entries.push(user("after", "boundary", "after question", entries.length));
	entries.push(assistant("after-answer", "after", "after answer", entries.length));
	return entries;
}

function tailStart(entries: readonly SessionEntry[]): number {
	return entries.findIndex((entry) => entry.id === "kept") + 1;
}

function withoutEpoch<T extends { readonly epoch?: string }>(value: T): Omit<T, "epoch"> {
	const { epoch: _epoch, ...rest } = value;
	return rest;
}

function countHistoryParses(): { readonly count: () => number; readonly restore: () => void } {
	const parse = vi.spyOn(JSON, "parse");
	return {
		count: () => parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes(HISTORY)).length,
		restore: () => parse.mockRestore(),
	};
}

async function expectBoundedReads(store: SessionStore, entries: readonly SessionEntry[]): Promise<void> {
	const from = tailStart(entries);
	const parses = countHistoryParses();
	try {
		const tail = await store.readTail!("session", from);
		const range = await store.readRange!("session", from, from + 2);
		const point = await store.findLatestCompaction!("session");
		const resume = await store.readResume!("session");
		const seq = await store.findEntrySeq!("session", "kept");
		assert.equal(parses.count(), 0);
		assert.deepEqual(withoutEpoch(tail), withoutEpoch(sessionTailOf(header, entries, from)));
		assert.deepEqual(
			range.entries.map((entry) => entry.id),
			entries.slice(from - 1, from + 2).map((entry) => entry.id),
		);
		assert.deepEqual(range.seqs, [from, from + 1, from + 2]);
		assert.deepEqual(point, sessionCompactionOf(entries));
		assert.deepEqual(withoutEpoch(resume), withoutEpoch(sessionResumeOf(header, entries)));
		assert.equal(seq, from);
		assert.equal(tail.epoch, resume.epoch);
	} finally {
		parses.restore();
	}
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-bounded-reads-"));
	directories.push(directory);
	return directory;
}

it("a legacy-store wrapper projects the requested window for a snapshot-only custom store (#5554)", async () => {
	const directory = temporaryDirectory();
	const backing = new MemorySessionStore();
	await backing.create(header, compacted(4));
	const inner: SessionStore = Object.assign(Object.create(backing) as SessionStore, {
		readResume: undefined,
		readTail: undefined,
		readRange: undefined,
		findLatestCompaction: undefined,
		findEntrySeq: undefined,
		load: backing.load.bind(backing),
	});
	const store = new LegacySessionStore(inner, {
		legacyDirectory: directory,
		databasePath: join(directory, "deletions.sqlite"),
	});
	try {
		const resume = await store.readResume(header.id);
		assert.deepEqual(
			resume.branch.map(({ entry }) => entry.id),
			["kept", "kept-answer", "boundary", "after", "after-answer"],
		);
		assert.deepEqual(
			(await store.readTail(header.id, resume.lastSeq)).entries.map((entry) => entry.id),
			["after-answer"],
		);
		assert.deepEqual(
			(await readSessionRange(inner, header.id, 1, 1)).entries.map((entry) => entry.id),
			["m0"],
		);
		assert.equal((await store.findLatestCompaction(header.id))?.entry.id, "boundary");
		assert.equal(await store.findEntrySeq(header.id, "kept"), 11);
	} finally {
		await store.close();
	}
});

it("a read-only transcript can follow bounded pages and exact entry chunks without opening a session (#5554)", async () => {
	const store = new MemorySessionStore();
	const first = user("old", null, "保存".repeat(250_000), 1),
		last = user("last", "old", "current", 2);
	await store.create(header, [first, last]);
	const resume = vi.spyOn(store, "readResume").mockRejectedValue(new Error("opened live recovery"));
	const full = vi.spyOn(store, "load").mockRejectedValue(new Error("loaded whole transcript"));
	try {
		const end = await readSessionHistory(store, header.id, { direction: "backward" }).next();
		assert.ok(!end.done && end.value.nextCursor);
		assert.deepEqual(end.value.items, [{ seq: 2, entry: last }]);
		const head = await readSessionHistory(store, header.id, { cursor: end.value.nextCursor }).next();
		const item = head.value?.items[0];
		assert.ok(item && "kind" in item);
		const chunks = [];
		for await (const chunk of readSessionHistoryChunks(store, item)) chunks.push(chunk);
		assert.ok(Buffer.concat(chunks).equals(Buffer.from(JSON.stringify(first))));
		assert.equal(resume.mock.calls.length, 0);
		assert.equal(full.mock.calls.length, 0);
	} finally {
		resume.mockRestore();
		full.mockRestore();
		await store.close();
	}
});

function spillFiles(): {
	readonly historyFiles: SessionHistoryFiles;
	readonly files: Map<number, Uint8Array>;
	readonly wholeReads: () => number;
	readonly rangeBytes: () => number;
	readonly dropRangeReads: () => void;
} {
	const files = new Map<number, Uint8Array>();
	let wholeReads = 0;
	let rangeBytes = 0;
	const directory: SessionHistoryDirectory = {
		path: "/spill",
		async write(file, data, previous) {
			const before =
				previous === undefined ? new Uint8Array(0) : files.get(previous.file)!.subarray(0, previous.bytes);
			const joined = new Uint8Array(before.byteLength + data.byteLength);
			joined.set(before);
			joined.set(data, before.byteLength);
			files.set(file, joined);
		},
		async read(file) {
			wholeReads += 1;
			const data = files.get(file);
			if (data === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return Uint8Array.from(data);
		},
		async readRange(file, position, length) {
			const data = files.get(file);
			if (data === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			rangeBytes += length;
			return { bytes: data.slice(position, position + length), size: data.byteLength };
		},
		async removeFile(file) {
			files.delete(file);
		},
		async remove() {
			files.clear();
		},
	};
	return {
		historyFiles: { createDirectory: async () => directory, report: () => {} },
		files,
		wholeReads: () => wholeReads,
		rangeBytes: () => rangeBytes,
		dropRangeReads: () => {
			delete (directory as { readRange?: unknown }).readRange;
		},
	};
}

for (const backend of ["memory", "jsonl"] as const) {
	it(`an older ${backend} fork point can be resumed without decoding a giant message outside its window (#5554)`, async () => {
		const spill = spillFiles();
		const store =
			backend === "memory"
				? new MemorySessionStore(undefined, spill.historyFiles)
				: await JsonlSessionStore.open(temporaryDirectory(), { exactDirectory: true });
		const entries = compacted(22);
		const cold = entries[2]!;
		assert.ok(cold.type === "message" && cold.message.role === "user");
		cold.message.content = "giant-retired-body".repeat(130_000);
		const point = entries.at(-1)!.id;
		entries.push(user("other", "m0", "other branch", 200));
		await store.create(header, entries);
		await store.readResume(header.id);
		if (store instanceof MemorySessionStore) await store.releaseSession(header.id);
		const expected = withoutEpoch(sessionResumeOf(header, entries, point));
		const parse = JSON.parse;
		const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
			assert.ok(
				text.length < 1_048_576 || !text.includes("giant-retired-body"),
				"decoded a giant retired conversation message",
			);
			return parse(text, reviver);
		});
		try {
			const selected = await store.readResume(header.id, point);
			assert.deepEqual(withoutEpoch(selected), expected);
			assert.equal(spill.wholeReads(), 0);
			assert.equal((await store.readResume(header.id)).leafId, "other");
		} finally {
			spy.mockRestore();
			await store.close();
		}
	});
}

describe("bounded memory session reads (#5249)", () => {
	it("reads a compacted session's tail, ranges and resume without decoding its history (#5249)", async () => {
		for (const history of [20, 200]) {
			const entries = compacted(history);
			const store = new MemorySessionStore();
			await store.create(header, entries.slice(0, 10));
			for (let start = 10; start < entries.length; start += 7) {
				await store.append("session", entries.slice(start, start + 7), { expectSeq: start });
			}
			await expectBoundedReads(store, entries);
		}
	});

	it("reads a released session's tail with positional reads of its history file (#5249)", async () => {
		const entries = compacted(2000);
		const spill = spillFiles();
		const store = new MemorySessionStore(undefined, spill.historyFiles);
		const split = entries.length - 4;
		await store.create(header, entries.slice(0, split));
		await store.releaseSession("session");
		await store.append("session", entries.slice(split), { expectSeq: split });
		await store.releaseSession("session");
		const before = spill.rangeBytes();
		const from = tailStart(entries);
		assert.deepEqual(
			withoutEpoch(await store.readTail("session", from)),
			withoutEpoch(sessionTailOf(header, entries, from)),
		);
		const fileBytes = [...spill.files.values()][0]!.byteLength;
		const read = spill.rangeBytes() - before;
		assert.ok(read < fileBytes / 8, `${read} of ${fileBytes} bytes read`);
		await expectBoundedReads(store, entries);
		assert.equal(spill.wholeReads(), 0);
		assert.deepEqual((await store.load("session")).entries, entries);
	});

	it("refuses a released session whose history file changed under the bytes it reads (#5249)", async () => {
		const entries = compacted(200);
		const spill = spillFiles();
		const store = new MemorySessionStore(undefined, spill.historyFiles);
		await store.create(header, entries);
		await store.releaseSession("session");
		const file = [...spill.files.values()][0]!;
		const position = file.byteLength - 20;
		file[position] = file[position] === 0x61 ? 0x62 : 0x61;
		await assert.rejects(store.readTail("session", tailStart(entries)), (error: Error) => {
			assert.ok(error instanceof SessionSpillError);
			assert.equal(error.code, "spill-corrupt");
			return true;
		});
	});

	it("reads a released session whole when its history directory reads no ranges (#5249)", async () => {
		const entries = compacted(20);
		const spill = spillFiles();
		spill.dropRangeReads();
		const store = new MemorySessionStore(undefined, spill.historyFiles);
		await store.create(header, entries);
		await store.releaseSession("session");
		const from = tailStart(entries);
		assert.deepEqual(
			withoutEpoch(await store.readTail("session", from)),
			withoutEpoch(sessionTailOf(header, entries, from)),
		);
	});

	it("rebuilds its resume state when an append continues an earlier entry (#5249)", async () => {
		const entries = compacted(20);
		const store = new MemorySessionStore();
		await store.create(header, entries);
		const branched = user("branched", "u3", "branched question", entries.length);
		await store.append("session", [branched], { expectSeq: entries.length });
		const all = [...entries, branched];
		assert.deepEqual(withoutEpoch(await store.readResume("session")), withoutEpoch(sessionResumeOf(header, all)));
		assert.equal(await store.findLatestCompaction("session"), undefined);
	});

	it("keeps its epoch across appends and changes it on replace (#5249)", async () => {
		const entries = compacted(5);
		const store = new MemorySessionStore();
		await store.create(header, entries);
		const before = (await store.readTail("session", 1)).epoch;
		const more = user("more", entries.at(-1)!.id, "more", entries.length);
		await store.append("session", [more], { expectSeq: entries.length });
		assert.equal((await store.readTail("session", 1)).epoch, before);
		await store.replace("session", header, entries, { expectSeq: entries.length + 1 });
		assert.notEqual((await store.readTail("session", 1)).epoch, before);
	});
});

describe("bounded JSONL session reads (#5249)", () => {
	async function jsonlStore(directory: string): Promise<JsonlSessionStore> {
		return JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
	}

	it("reads a compacted session's tail from its index without decoding its history again (#5249)", async () => {
		const directory = temporaryDirectory();
		const entries = compacted(200);
		const writer = await jsonlStore(directory);
		const path = writer.locationFor(header);
		await writer.create(header, entries);
		await writer.readTail("session", tailStart(entries));
		await writer.close();
		assert.equal(existsSync(`${path}.idx`), true);

		const reader = await jsonlStore(directory);
		await expectBoundedReads(reader, entries);
		const more = user("more", entries.at(-1)!.id, "more", entries.length);
		const parses = countHistoryParses();
		try {
			await reader.append("session", [more], { expectSeq: entries.length });
			assert.equal(parses.count(), 0);
		} finally {
			parses.restore();
		}
		await reader.close();

		const later = await jsonlStore(directory);
		await expectBoundedReads(later, [...entries, more]);
		await later.close();
	});

	it("catches up with entries another process appended (#5249)", async () => {
		const directory = temporaryDirectory();
		const entries = compacted(50);
		const first = await jsonlStore(directory);
		await first.create(header, entries.slice(0, -2));
		await first.readTail("session", 1);
		const second = await jsonlStore(directory);
		await second.load("session");
		await second.append("session", entries.slice(-2), { expectSeq: entries.length - 2 });
		await second.close();
		await expectBoundedReads(first, entries);
		await first.close();
	});

	it("rebuilds an index whose file does not check out, and drops it with its session (#5249)", async () => {
		const directory = temporaryDirectory();
		const entries = compacted(20);
		const writer = await jsonlStore(directory);
		const path = writer.locationFor(header);
		await writer.create(header, entries);
		await writer.readTail("session", 1);
		await writer.close();
		const sidecar = `${path}.idx`;
		writeFileSync(sidecar, readFileSync(sidecar, "utf8").replace("verbatim", "verbatum"));
		const reader = await jsonlStore(directory);
		const from = tailStart(entries);
		assert.deepEqual(
			withoutEpoch(await reader.readTail("session", from)),
			withoutEpoch(sessionTailOf(header, entries, from)),
		);
		await reader.delete("session");
		assert.equal(existsSync(sidecar), false);
		await reader.close();
	});

	it("ignores a torn last line and appends after it as a whole read does (#5249)", async () => {
		const directory = temporaryDirectory();
		const entries = compacted(20);
		const writer = await jsonlStore(directory);
		const path = writer.locationFor(header);
		await writer.create(header, entries);
		await writer.close();
		appendFileSync(path, '{"type":"message","id":"torn"');
		const reader = await jsonlStore(directory);
		const from = tailStart(entries);
		const tail = await reader.readTail("session", from);
		assert.deepEqual(withoutEpoch(tail), withoutEpoch(sessionTailOf(header, entries, from)));
		const more = user("more", entries.at(-1)!.id, "more", entries.length);
		await reader.append("session", [more], { expectSeq: entries.length });
		assert.deepEqual((await reader.load("session")).entries, [...entries, more]);
		await reader.close();
	});

	it("keeps its epoch across appends and processes and changes it on replace (#5249)", async () => {
		const directory = temporaryDirectory();
		const entries = compacted(5);
		const writer = await jsonlStore(directory);
		await writer.create(header, entries);
		const before = (await writer.readTail("session", 1)).epoch;
		const more = user("more", entries.at(-1)!.id, "more", entries.length);
		await writer.append("session", [more], { expectSeq: entries.length });
		assert.equal((await writer.readTail("session", 1)).epoch, before);
		const other = await jsonlStore(directory);
		assert.equal((await other.readTail("session", 1)).epoch, before);
		await other.close();
		await writer.replace("session", header, entries, { expectSeq: entries.length + 1 });
		assert.notEqual((await writer.readTail("session", 1)).epoch, before);
		await writer.close();
	});

	it("finds entries whatever whitespace, key order or escapes their id uses (#5249)", async () => {
		const directory = temporaryDirectory();
		const entries = [
			user("early", null, "early", 0),
			user("spaced", "early", "spaced", 1),
			user("reordered", "spaced", "reordered", 2),
			user("escaped", "reordered", "escaped", 3),
			user("last", "escaped", "last", 4),
		];
		const writer = await jsonlStore(directory);
		const path = writer.locationFor(header);
		await writer.create(header, entries);
		await writer.close();
		const { id: _id, ...rest } = entries[2]!;
		writeFileSync(
			path,
			readFileSync(path, "utf8")
				.replace('"id":"spaced"', '"id" : "spaced"')
				.replace(JSON.stringify(entries[2]), JSON.stringify({ ...rest, id: "reordered" }))
				.replace('"id":"escaped"', '"id":"\\u0065scaped"'),
		);
		const reader = await jsonlStore(directory);
		assert.deepEqual((await reader.load("session")).entries, entries);
		for (const [i, entry] of entries.entries()) assert.equal(await reader.findEntrySeq("session", entry.id), i + 1);
		assert.equal(await reader.findEntrySeq("session", "missing"), undefined);
		assert.equal((await reader.readResume("session", "spaced")).leafId, "spaced");
		assert.deepEqual(
			withoutEpoch(await reader.readResume("session", "escaped")),
			withoutEpoch(sessionResumeOf(header, entries, "escaped")),
		);

		const boundary: SessionEntry = {
			type: "compaction",
			id: "boundary",
			parentId: "last",
			timestamp: at(5),
			summary: "summary",
			tokensBefore: 10,
			firstKeptEntryId: "spaced",
			details: { strategy: "verbatim-lines", backend: "summary" },
		};
		const other = await jsonlStore(directory);
		await other.load("session");
		await other.append("session", [boundary], { expectSeq: entries.length });
		await other.close();
		const all = [...entries, boundary];
		const resumed = await reader.readResume("session");
		assert.equal(resumed.compaction?.firstKeptSeq, 2);
		assert.deepEqual(withoutEpoch(resumed), withoutEpoch(sessionResumeOf(header, all)));
		assert.equal((await reader.findLatestCompaction("session", "boundary"))?.retainedStartSeq, 2);
		await reader.close();
	});

	it("rebuilds its resume state when an append continues an earlier entry (#5249)", async () => {
		const directory = temporaryDirectory();
		const entries = compacted(20);
		const store = await jsonlStore(directory);
		await store.create(header, entries);
		await store.readTail("session", 1);
		const branched = user("branched", "u3", "branched question", entries.length);
		await store.append("session", [branched], { expectSeq: entries.length });
		const all = [...entries, branched];
		assert.deepEqual(withoutEpoch(await store.readResume("session")), withoutEpoch(sessionResumeOf(header, all)));
		await store.close();
		const other = await jsonlStore(directory);
		assert.deepEqual(withoutEpoch(await other.readResume("session")), withoutEpoch(sessionResumeOf(header, all)));
		await other.close();
	});
});
