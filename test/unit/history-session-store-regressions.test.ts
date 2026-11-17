import assert from "node:assert/strict";
import { appendFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { appendFile, type FileHandle, mkdtemp, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { EntryTypeReader, JsonTextChecker } from "../../packages/coding-agent/src/core/storage/session/entry-type.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import {
	MemorySessionStore,
	type SessionHistoryDirectory,
	type SessionHistoryFiles,
} from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionEntriesQuery,
	type SessionSummary,
} from "../../packages/coding-agent/src/core/storage/session/types.js";

const createdAt = "2026-10-15T00:00:00Z";
const header = { id: "s", version: SESSION_FORMAT_VERSION, createdAt, cwd: "/project" } as const;
const headerLine = JSON.stringify({ type: "session", ...header });

function info(id: string, name = "n"): SessionEntry {
	return { type: "session_info", id, parentId: null, timestamp: createdAt, name };
}

function custom(id: string, data: string): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: createdAt, customType: "snap", data };
}

function message(id: string, text: string, time: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: createdAt,
		message: { role: "user", content: text, timestamp: time },
	};
}

function liveArrayBuffers(): number {
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;
	setFlagsFromString("--no-expose-gc");
	gc();
	gc();
	return process.memoryUsage().arrayBuffers;
}

type FileHandleRead = (
	this: FileHandle,
	buffer: Buffer,
	offset: number,
	length: number,
	position: number | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

interface FileHandlePrototype {
	read: FileHandleRead;
}

async function arrayBufferGrowth<T>(path: string, body: () => Promise<T>): Promise<{ result: T; growth: number }> {
	const handle = await open(path, "r");
	const prototype = Object.getPrototypeOf(handle) as FileHandlePrototype;
	await handle.close();
	const read = prototype.read;
	const baseline = liveArrayBuffers();
	let peak = baseline;
	prototype.read = function (
		this: FileHandle,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number | null,
	) {
		peak = Math.max(peak, process.memoryUsage().arrayBuffers);
		return read.call(this, buffer, offset, length, position);
	};
	try {
		const result = await body();
		peak = Math.max(peak, process.memoryUsage().arrayBuffers);
		return { result, growth: peak - baseline };
	} finally {
		prototype.read = read;
	}
}

async function fileReads<T>(
	path: string,
	body: () => Promise<T>,
): Promise<{ result: T; calls: number; bytes: number }> {
	const handle = await open(path, "r");
	const prototype = Object.getPrototypeOf(handle) as FileHandlePrototype;
	await handle.close();
	const read = prototype.read;
	let calls = 0;
	let bytes = 0;
	prototype.read = async function (
		this: FileHandle,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number | null,
	) {
		calls++;
		const done = await read.call(this, buffer, offset, length, position);
		bytes += done.bytesRead;
		return done;
	};
	try {
		return { result: await body(), calls, bytes };
	} finally {
		prototype.read = read;
	}
}

function countedHistoryFiles(): { readonly files: SessionHistoryFiles; readonly bytesRead: () => number } {
	const contents = new Map<number, Uint8Array>();
	let bytesRead = 0;
	const directory: SessionHistoryDirectory = {
		path: "released-history",
		async write(file, data, previous) {
			const before = previous === undefined ? [] : [contents.get(previous.file)!.subarray(0, previous.bytes)];
			contents.set(file, Buffer.concat([...before, data]));
		},
		async read(file) {
			const bytes = contents.get(file)!;
			bytesRead += bytes.byteLength;
			return bytes;
		},
		async readRange(file, position, length) {
			const whole = contents.get(file)!;
			const bytes = whole.subarray(position, position + length);
			bytesRead += bytes.byteLength;
			return { bytes, size: whole.byteLength };
		},
		async removeFile(file) {
			contents.delete(file);
		},
		async remove() {
			contents.clear();
		},
	};
	return { files: { createDirectory: async () => directory, report: () => {} }, bytesRead: () => bytesRead };
}

async function trackedReads<T>(
	path: string,
	observe: (length: number, position: number | null) => void,
	body: () => Promise<T>,
): Promise<{ result: T; maxInFlight: number }> {
	const handle = await open(path, "r");
	const prototype = Object.getPrototypeOf(handle) as FileHandlePrototype;
	await handle.close();
	const read = prototype.read;
	let inFlight = 0;
	let maxInFlight = 0;
	prototype.read = async function (
		this: FileHandle,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number | null,
	) {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		observe(length, position);
		try {
			return await read.call(this, buffer, offset, length, position);
		} finally {
			inFlight--;
		}
	};
	try {
		return { result: await body(), maxInFlight };
	} finally {
		prototype.read = read;
	}
}

async function writeWithLargeLine(
	path: string,
	line: { before: string; after: string },
	dataBytes: number,
	rest: string,
) {
	await writeFile(path, `${headerLine}\n${JSON.stringify(info("a"))}\n${line.before}`);
	const block = "x".repeat(1024 * 1024);
	for (let written = 0; written < dataBytes; written += block.length) await appendFile(path, block);
	await appendFile(path, `${line.after}${rest}`);
}

function fileText(entries: readonly SessionEntry[]): string {
	return `${[headerLine, ...entries.map((entry) => JSON.stringify(entry))].join("\n")}\n`;
}

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "session-bounded-reads-"));
	try {
		await body(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function withJsonl(directory: string, body: (store: JsonlSessionStore) => Promise<void>): Promise<void> {
	const store = await JsonlSessionStore.open(directory, { scanExisting: false });
	try {
		await body(store);
	} finally {
		await store.close();
	}
}

async function rows(store: JsonlSessionStore, withoutSearchText: boolean): Promise<SessionSummary[]> {
	const listed: SessionSummary[] = [];
	for await (const summary of store.list({ withoutSearchText })) listed.push(summary);
	return listed;
}

function numbered(prefix: string, count: number): SessionEntry[] {
	return Array.from({ length: count }, (_, index) => info(`${prefix}${String(index + 1).padStart(6, "0")}`, "same"));
}

function mergedFirstTwo(entries: readonly SessionEntry[], rename: (id: string) => string): SessionEntry[] {
	const lineBytes = (entry: SessionEntry) => Buffer.byteLength(JSON.stringify(entry));
	const width = lineBytes(entries[0]!) + lineBytes(entries[1]!) + 1;
	const merged = info("merged", "m".repeat(width - lineBytes(info("merged", ""))));
	assert.equal(lineBytes(merged), width);
	return [merged, ...entries.slice(2).map((entry) => ({ ...entry, id: rename(entry.id) }))];
}

const trickyLines = [
	'{"type":"custom","id":"canonical"}',
	'{"data":{"type":"message"},"type":"custom","id":"nested-first"}',
	'{"data":"{\\"type\\":\\"message\\"}","type":"custom","id":"string-first"}',
	'{"\\u0074\\u0079\\u0070\\u0065":"custom","id":"escaped-key"}',
	'{"type":"cust\\u006fm","id":"escaped-value"}',
	'{"ty\\"pe":"message","type":"custom","id":"quoted-key"}',
	'{"data":"back\\\\","type":"custom","id":"backslash"}',
	'{ "type" : "custom" , "id" : "spaced" }',
	'{"data":[{"type":"message"},"]}",{"a":"}"}],"type":"custom","id":"brackets"}',
	'{"data":{"type":"custom"},"type":"message","id":"nested-skip-type"}',
	'{"type":"message","id":"plain"}',
	'{"type":5,"id":"number"}',
	'{"id":"untyped","data":{"type":"custom"}}',
];

const repeatedTypeLines = [
	'{"type":"custom","id":"then-message","type":"message"}',
	'{"type":"message","id":"then-custom","type":"custom"}',
	'{"type":"custom","id":"then-number","type":5}',
	'{"type":"custom","data":{"type":"custom"},"\\u0074ype":"message","id":"then-escaped"}',
	'{"type":5,"id":"then-string","type":"custom"}',
	'{"type":"custom","type":{"type":"custom"},"id":"then-object"}',
];

describe("bounded session reads (#5250)", () => {
	it("marks a JSONL listing row built from the session's two ends as estimated until the session is read whole (#5250)", async () => {
		await withDirectory(async (directory) => {
			const entries = [message("m0", "first question", 1_700_000_000_000), info("n", "Named Early")];
			for (let index = 1; index <= 400; index++)
				entries.push(message(`m${index}`, `${"filler ".repeat(100)}${index}`, 1_700_000_000_000 + index * 1000));
			await writeFile(join(directory, "s.jsonl"), fileText(entries));
			await writeFile(
				join(directory, "small.jsonl"),
				fileText([message("only", "small", 1)]).replace('"id":"s"', '"id":"small"'),
			);
			await withJsonl(directory, async (store) => {
				const light = (await rows(store, true)).sort((a, b) => a.id.localeCompare(b.id));
				assert.deepEqual(
					light.map((row) => [row.id, row.estimated]),
					[
						["s", true],
						["small", undefined],
					],
				);
				assert.ok(light[0]!.messageCount <= 401);
				assert.equal(light[1]!.messageCount, 1);
				await store.load("s");
				const exact = (await rows(store, true)).find((row) => row.id === "s");
				assert.equal(exact?.estimated, undefined);
				assert.equal(exact?.messageCount, 401);
				assert.equal(exact?.name, "Named Early");
			});
		});
	});

	it("keeps a JSONL light listing exact after an append that absorbs another writer's entries (#5250)", async () => {
		await withDirectory(async (directory) => {
			await writeFile(join(directory, "s.jsonl"), fileText([message("m1", "one", 1), message("m2", "two", 2)]));
			const first = await JsonlSessionStore.open(directory);
			const second = await JsonlSessionStore.open(directory, { scanExisting: false });
			try {
				await second.append("s", [message("m3", "three", 3)], { expectSeq: 2 });
				await first.append("s", [info("n", "Renamed"), message("m4", "four", 4)], { expectSeq: 3 });
				const [light] = await rows(first, true);
				const [full] = await rows(first, false);
				assert.equal(full?.messageCount, 4);
				assert.equal(light?.messageCount, 4);
				assert.equal(light?.name, "Renamed");
				assert.equal(light?.estimated, undefined);
			} finally {
				await first.close();
				await second.close();
			}
		});
	});

	it("does not serve a JSONL range from a stale index after a same-size rewrite in place (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				const before = await stat(path);
				await writeFile(path, fileText(mergedFirstTwo(entries, (id) => id)));
				assert.equal((await stat(path)).size, before.size);
				await utimes(path, before.atime, new Date(before.mtimeMs + 5000));
				const page = await store.readEntryRange("s", { fromSeq: 551, toSeq: 551 });
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("does not serve a JSONL range from a stale index after an in-place rewrite that also grows the file (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				await writeFile(path, fileText([...mergedFirstTwo(entries, (id) => id), info("grown")]));
				const page = await store.readEntryRange("s", { fromSeq: 551, toSeq: 551 });
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("does not serve a JSONL range from a stale index after an in-place rewrite of a later marked line that also grows the file (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				const rewritten = [...entries.slice(0, 255), ...mergedFirstTwo(entries.slice(255), (id) => id)];
				await writeFile(path, fileText([...rewritten, info("grown")]));
				const page = await store.readEntryRange("s", { fromSeq: 551, toSeq: 551 });
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("does not serve a JSONL range from a stale index after an in-place edit of an unmarked line plus an append (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				const rewritten = [...entries.slice(0, 548), ...mergedFirstTwo(entries.slice(548), (id) => id)];
				await writeFile(path, fileText([...rewritten, info("grown")]));
				const page = await store.readEntryRange("s", { fromSeq: 551, toSeq: 551 });
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("does not serve a JSONL range from a stale index after this store appends and the file is then rewritten in place at the same size (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				await store.append("s", [info("own")], { expectSeq: 600 });
				const before = await stat(path);
				const rewritten = [...entries.slice(0, 2), ...mergedFirstTwo(entries.slice(2), (id) => id), info("own")];
				await writeFile(path, fileText(rewritten));
				assert.equal((await stat(path)).size, before.size);
				await utimes(path, before.atime, new Date(before.mtimeMs + 5000));
				const page = await store.readEntryRange("s", { fromSeq: 551, toSeq: 551 });
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("does not return JSONL rows numbered by an earlier state of a file rewritten during the read (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				const before = await stat(path);
				let rewritten = false;
				const query: SessionEntriesQuery = {
					toSeq: 551,
					get fromSeq(): number {
						if (!rewritten) {
							rewritten = true;
							writeFileSync(path, fileText(mergedFirstTwo(entries, (id) => id)));
							utimesSync(path, before.atime, new Date(before.mtimeMs + 5000));
						}
						return 551;
					},
				};
				const page = await store.readEntryRange("s", query);
				assert.ok(rewritten);
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("does not return JSONL rows numbered by an earlier state of a file rewritten and grown during the read (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				let rewritten = false;
				const query: SessionEntriesQuery = {
					toSeq: 551,
					get fromSeq(): number {
						if (!rewritten) {
							rewritten = true;
							writeFileSync(path, fileText([...mergedFirstTwo(entries, (id) => id), info("grown")]));
						}
						return 551;
					},
				};
				const page = await store.readEntryRange("s", query);
				assert.ok(rewritten);
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("does not return JSONL rows numbered from a boundary that a rewrite during the read moved by whole lines (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600).map((entry) => info(entry.id, `name ${entry.id}`));
			await writeFile(path, fileText(entries));
			const lineBytes = Buffer.byteLength(JSON.stringify(entries[549]!)) + 1;
			const longer = entries.map((entry, index) =>
				index === 539 ? info(entry.id, `name ${entry.id}${"s".repeat(lineBytes)}`) : entry,
			);
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				let rewritten = false;
				const query: SessionEntriesQuery = {
					toSeq: 551,
					get fromSeq(): number {
						if (!rewritten) {
							rewritten = true;
							writeFileSync(path, fileText(longer));
						}
						return 551;
					},
				};
				const page = await store.readEntryRange("s", query);
				assert.ok(rewritten);
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000551"]],
				);
			});
		});
	});

	it("numbers a JSONL range by the file it reads when the file is replaced during the read (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 600);
			const replacement = mergedFirstTwo(entries, (id) => id.replace("e", "f"));
			await writeFile(path, fileText(entries));
			writeFileSync(`${path}.next`, fileText(replacement));
			await withJsonl(directory, async (store) => {
				assert.equal(
					(await store.readEntryRange("s", { fromSeq: 550, toSeq: 550 })).entries[0]?.entry.id,
					"e000550",
				);
				let replaced = false;
				const query: SessionEntriesQuery = {
					toSeq: 552,
					get fromSeq(): number {
						if (!replaced) {
							replaced = true;
							renameSync(path, `${path}.old`);
							renameSync(`${path}.next`, path);
						}
						return 551;
					},
				};
				const page = await store.readEntryRange("s", query);
				const read = page.entries.map((item) => [item.seq, item.entry.id]);
				const inFile = (file: readonly SessionEntry[]) => read.map(([seq]) => [seq, file[Number(seq) - 1]?.id]);
				assert.ok(replaced);
				assert.equal(read.length, 2);
				assert.ok(
					JSON.stringify(read) === JSON.stringify(inFile(entries)) ||
						JSON.stringify(read) === JSON.stringify(inFile(replacement)),
					`read ${JSON.stringify(read)}`,
				);
			});
		});
	});

	for (const before of [5, 17, 40, 20_000]) {
		it(`skips a large entry by its type wherever its line starts, here ${before} bytes before a 64 KiB boundary (#5250)`, async () => {
			await withDirectory(async (directory) => {
				const target = 64 * 1024 - before;
				const fillers: SessionEntry[] = [];
				let text = `${headerLine}\n`;
				while (Buffer.byteLength(text) + 400 < target) {
					const filler = info(`f${fillers.length}`, "y".repeat(200));
					fillers.push(filler);
					text += `${JSON.stringify(filler)}\n`;
				}
				const gap = target - Buffer.byteLength(text) - 1;
				const pad = info(`f${fillers.length}`, "");
				fillers.push(info(pad.id, "z".repeat(gap - Buffer.byteLength(JSON.stringify(pad)))));
				const big = custom("big", "x".repeat(1_000_000));
				const entries = [...fillers, big, info("after")];
				await writeFile(join(directory, "s.jsonl"), fileText(entries));
				assert.equal(fileText(entries).indexOf('{"type":"custom"'), target);
				await withJsonl(directory, async (store) => {
					const page = await store.readEntryRange("s", {
						fromSeq: fillers.length,
						toSeq: entries.length,
						largeEntryBytes: 64 * 1024,
						skipTypes: ["custom"],
					});
					assert.deepEqual(
						page.entries.map((item) => item.entry.id),
						[fillers.at(-1)!.id, "after"],
					);
				});
			});
		});
	}

	it("reads past a skipped JSONL line far larger than the page without holding it in memory (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const lineBytes = 64 * 1024 * 1024;
			await writeFile(
				path,
				`${headerLine}\n${JSON.stringify(info("a"))}\n${JSON.stringify(custom("big", "")).slice(0, -2)}`,
			);
			const block = "x".repeat(1024 * 1024);
			for (let written = 0; written < lineBytes; written += block.length) await appendFile(path, block);
			await appendFile(path, `"}\n${JSON.stringify(info("b"))}\n`);
			await withJsonl(directory, async (store) => {
				const signal = new AbortController().signal;
				const baseline = liveArrayBuffers();
				let peak = baseline;
				signal.throwIfAborted = () => {
					peak = Math.max(peak, process.memoryUsage().arrayBuffers);
				};
				const page = await store.readEntryRange("s", {
					fromSeq: 1,
					toSeq: 3,
					skipTypes: ["custom"],
					largeEntryBytes: 256 * 1024,
					signal,
				});
				assert.deepEqual(
					page.entries.map((item) => item.entry.id),
					["a", "b"],
				);
				assert.ok(peak - baseline < lineBytes / 4, `grew by ${peak - baseline} bytes`);
			});
		});
	}, 60_000);

	it("answers every JSONL query whose range is empty with the known total of a cold file (#5250)", async () => {
		await withDirectory(async (directory) => {
			await writeFile(join(directory, "s.jsonl"), fileText([info("a"), info("b"), info("c")]));
			for (const [fromSeq, toSeq] of [
				[1, 0],
				[2, 1],
				[5, 0],
				[0, -1],
				[3, 2],
			] as const) {
				await withJsonl(directory, async (store) => {
					const page = await store.readEntryRange("s", { fromSeq, toSeq });
					assert.deepEqual(page.entries, []);
					assert.equal(page.lastSeq, 3, `${fromSeq}-${toSeq}`);
					assert.equal(page.throughSeq, Math.max(1, fromSeq) - 1);
				});
			}
		});
	});

	it("skips an oversized memory-store entry whose type the caller skips (#5250)", async () => {
		const store = new MemorySessionStore();
		try {
			await store.create(header, [info("a"), custom("big", "x".repeat(300_000)), info("c")]);
			const page = await store.readEntryRange("s", {
				fromSeq: 1,
				toSeq: 3,
				largeEntryBytes: 64 * 1024,
				skipTypes: ["custom"],
			});
			assert.deepEqual(
				page.entries.map((item) => item.seq),
				[1, 3],
			);
			assert.equal(page.throughSeq, 3);
		} finally {
			await store.close();
		}
	});

	it("skips an oversized entry by its top-level type wherever the key appears, in JSONL and memory stores (#5250)", async () => {
		const reordered = {
			data: { type: "message", note: "x".repeat(300_000) },
			id: "late",
			parentId: null,
			timestamp: createdAt,
			customType: "snap",
			type: "custom",
		} as const;
		const entries: SessionEntry[] = [info("a"), reordered, info("c")];
		const read = async (store: JsonlSessionStore | MemorySessionStore, skipTypes: string[]) =>
			(await store.readEntryRange("s", { fromSeq: 1, toSeq: 3, largeEntryBytes: 64 * 1024, skipTypes })).entries.map(
				(item) => [item.seq, item.rawChunks === undefined ? item.entry.id : "raw"],
			);
		const expected = {
			custom: [
				[1, "a"],
				[3, "c"],
			],
			message: [
				[1, "a"],
				[2, "raw"],
				[3, "c"],
			],
		};
		const memory = new MemorySessionStore();
		try {
			await memory.create(header, entries);
			assert.deepEqual(await read(memory, ["custom"]), expected.custom);
			assert.deepEqual(await read(memory, ["message"]), expected.message);
		} finally {
			await memory.close();
		}
		await withDirectory(async (directory) => {
			await writeFile(join(directory, "s.jsonl"), fileText(entries));
			await withJsonl(directory, async (store) => {
				assert.deepEqual(await read(store, ["custom"]), expected.custom);
				assert.deepEqual(await read(store, ["message"]), expected.message);
			});
		});
	});

	it("reads an entry's top-level type as JSON.parse does, however its bytes are split (#5250)", () => {
		for (const line of trickyLines) {
			const parsed: { type?: string | number } = JSON.parse(line);
			const expected = typeof parsed.type === "string" ? parsed.type : undefined;
			const bytes = Buffer.from(line);
			for (let split = 0; split <= bytes.length; split++) {
				const reader = new EntryTypeReader(["custom", "message"]);
				if (!reader.feed(bytes.subarray(0, split))) reader.feed(bytes.subarray(split));
				assert.equal(reader.finish(), expected, `${line} split at ${split}`);
			}
		}
	});

	it("skips oversized JSONL lines exactly when JSON.parse gives a skipped top-level type (#5250)", async () => {
		await withDirectory(async (directory) => {
			await writeFile(join(directory, "s.jsonl"), `${[headerLine, ...trickyLines].join("\n")}\n`);
			await withJsonl(directory, async (store) => {
				const page = await store.readEntryRange("s", {
					fromSeq: 1,
					toSeq: trickyLines.length,
					largeEntryBytes: 0,
					skipTypes: ["custom"],
				});
				const kept = trickyLines.flatMap((line, index) => {
					const parsed: { type?: string | number } = JSON.parse(line);
					return parsed.type === "custom" ? [] : [index + 1];
				});
				assert.deepEqual(
					page.entries.map((item) => item.seq),
					kept,
				);
				assert.deepEqual(kept, [10, 11, 12, 13]);
			});
		});
	});

	it("reads the last top-level type of a line that repeats the key, as JSON.parse and load do (#5250)", async () => {
		for (const line of repeatedTypeLines) {
			const parsed: { type?: string | number } = JSON.parse(line);
			const expected = typeof parsed.type === "string" ? parsed.type : undefined;
			const bytes = Buffer.from(line);
			for (let split = 0; split <= bytes.length; split++) {
				const reader = new EntryTypeReader(["custom", "message"]);
				if (!reader.feed(bytes.subarray(0, split))) reader.feed(bytes.subarray(split));
				assert.equal(reader.finish(), expected, `${line} split at ${split}`);
			}
		}
		const retyped = (entry: SessionEntry, first: string) => `{"type":"${first}",${JSON.stringify(entry).slice(1)}`;
		const lines = [
			retyped(message("m1", "hi", 1), "custom"),
			retyped(custom("c1", "d"), "message"),
			JSON.stringify(info("i")),
		];
		await withDirectory(async (directory) => {
			await writeFile(join(directory, "s.jsonl"), `${[headerLine, ...lines].join("\n")}\n`);
			await withJsonl(directory, async (store) => {
				const loaded = (await store.load("s")).entries.flatMap((entry, index) =>
					entry.type === "custom" ? [] : [index + 1],
				);
				const page = await store.readEntryRange("s", {
					fromSeq: 1,
					toSeq: lines.length,
					largeEntryBytes: 0,
					skipTypes: ["custom"],
				});
				assert.deepEqual(
					page.entries.map((item) => item.seq),
					loaded,
				);
				assert.deepEqual(loaded, [1, 3]);
			});
		});
	});

	it("checks a skipped unterminated last JSONL line is complete without holding it in memory (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const dataBytes = 64 * 1024 * 1024;
			const before = JSON.stringify(custom("big", "")).slice(0, -2);
			for (const [after, lastSeq] of [
				['"}', 2],
				['"', 1],
			] as const) {
				await writeWithLargeLine(path, { before, after }, dataBytes, "");
				await withJsonl(directory, async (store) => {
					const { result: page, growth } = await arrayBufferGrowth(path, () =>
						store.readEntryRange("s", {
							fromSeq: 1,
							toSeq: 3,
							skipTypes: ["custom"],
							largeEntryBytes: 256 * 1024,
						}),
					);
					assert.deepEqual(
						page.entries.map((item) => item.entry.id),
						["a"],
					);
					assert.equal(page.lastSeq, lastSeq, `ending ${after}`);
					assert.ok(growth < dataBytes / 4, `grew by ${growth} bytes`);
				});
			}
		});
	}, 60_000);

	it("skips a large JSONL line whose last top-level type is skipped without holding it in memory (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const dataBytes = 64 * 1024 * 1024;
			const fields = `"id":"big","parentId":null,"timestamp":"${createdAt}","customType":"snap","data":"`;
			for (const before of [`{${fields}`, `{"type":"message",${fields}`]) {
				await writeWithLargeLine(
					path,
					{ before, after: '","type":"custom"}' },
					dataBytes,
					`\n${JSON.stringify(info("b"))}\n`,
				);
				await withJsonl(directory, async (store) => {
					const { result: page, growth } = await arrayBufferGrowth(path, () =>
						store.readEntryRange("s", {
							fromSeq: 1,
							toSeq: 3,
							skipTypes: ["custom"],
							largeEntryBytes: 256 * 1024,
						}),
					);
					assert.deepEqual(
						page.entries.map((item) => item.entry.id),
						["a", "b"],
					);
					assert.ok(growth < dataBytes / 4, `${before.slice(0, 20)}: grew by ${growth} bytes`);
				});
			}
		});
	}, 60_000);

	it("returns a large JSONL entry whole when its kept type is known only at the end of its line (#5250)", async () => {
		const data = "y".repeat(3 * 1024 * 1024);
		const typeLast = `{"id":"type-last","parentId":null,"timestamp":"${createdAt}","customType":"snap","data":"${data}","type":"custom"}`;
		const retyped = `{"type":"custom","id":"retyped","parentId":null,"timestamp":"${createdAt}","customType":"snap","data":"${data}","type":"message"}`;
		await withDirectory(async (directory) => {
			for (const terminated of [true, false]) {
				await writeFile(
					join(directory, "s.jsonl"),
					`${[headerLine, typeLast, JSON.stringify(info("c")), retyped].join("\n")}${terminated ? "\n" : ""}`,
				);
				await withJsonl(directory, async (store) => {
					for (const skipTypes of [["session_info"], ["custom"]]) {
						const page = await store.readEntryRange("s", {
							fromSeq: 1,
							toSeq: 3,
							skipTypes,
							largeEntryBytes: 1024,
						});
						const raw = page.entries.map((item) => [
							item.seq,
							item.rawChunks === undefined ? item.entry.id : Buffer.concat(item.rawChunks).toString("utf8"),
						]);
						assert.deepEqual(
							raw,
							skipTypes[0] === "custom"
								? [
										[2, "c"],
										[3, retyped],
									]
								: [
										[1, typeLast],
										[3, retyped],
									],
							`skip ${skipTypes[0]}, terminated ${terminated}`,
						);
					}
				});
			}
		});
	});

	it("accepts an unterminated line exactly when JSON.parse does, however its bytes are split (#5250)", () => {
		const texts = [
			...trickyLines,
			...repeatedTypeLines,
			'{"a":[1,-0,0.5,1e5,1E+5,-2.5e-3,true,false,null,"\\u00e9\\n\\/"],"b":{}}',
			' {"a":[]} ',
			'"top"',
			"12",
			"-0",
			"[]",
			"\ufeff{}",
			'{"a":01}',
			'{"a":1.}',
			'{"a":.5}',
			'{"a":-}',
			'{"a":1e}',
			'{"a":tru}',
			'{"a":"\\x"}',
			'{"a":"\\u12g4"}',
			'{"a":"tab\there"}',
			'{"a":1,}',
			"[1,]",
			'{"a" 1}',
			'{"a":1}}',
			'{"a":1} x',
			'{"a":[}',
			"é",
			'{"é":"€😀"}',
		];
		for (const text of texts) {
			const bytes = Buffer.from(text);
			for (let end = 0; end <= bytes.length; end++) {
				const prefix = bytes.subarray(0, end);
				let parses = true;
				try {
					JSON.parse(prefix.toString("utf8"));
				} catch {
					parses = false;
				}
				for (const split of new Set([0, Math.floor(end / 2), end])) {
					const checker = new JsonTextChecker();
					checker.feed(prefix.subarray(0, split));
					checker.feed(prefix.subarray(split));
					assert.equal(checker.finish(), parses, `${JSON.stringify(prefix.toString("utf8"))} split at ${split}`);
				}
			}
		}
		const invalidUtf8 = Buffer.concat([
			Buffer.from('{"a":"'),
			Buffer.from([0xff, 0xed, 0xa0, 0x80]),
			Buffer.from('"}'),
		]);
		const checker = new JsonTextChecker();
		checker.feed(invalidUtf8);
		assert.equal(checker.finish(), true);
	});

	it("keeps a JSONL range read bounded after another writer appends to the session (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const entries = numbered("e", 40_000);
			await writeFile(path, fileText(entries));
			await withJsonl(directory, async (store) => {
				const first = await store.readEntryRange("s", { fromSeq: 39_990, toSeq: 39_990 });
				assert.equal(first.entries[0]?.entry.id, "e039990");
				appendFileSync(path, `${JSON.stringify(info("appended"))}\n`);
				const { result: page, bytes } = await fileReads(path, () =>
					store.readEntryRange("s", { fromSeq: 39_995, toSeq: 40_001 }),
				);
				assert.deepEqual(
					page.entries.map((item) => item.entry.id),
					["e039995", "e039996", "e039997", "e039998", "e039999", "e040000", "appended"],
				);
				assert.ok(bytes < 512 * 1024, `read ${bytes} bytes`);
			});
		});
	});

	it("returns a JSONL range read while another writer appends during every attempt (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			await writeFile(path, fileText(numbered("e", 600)));
			await withJsonl(directory, async (store) => {
				let appended = 0;
				const query: SessionEntriesQuery = {
					toSeq: 552,
					get fromSeq(): number {
						appended++;
						appendFileSync(path, `${JSON.stringify(info(`late${appended}`))}\n`);
						return 551;
					},
				};
				const page = await store.readEntryRange("s", query);
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[
						[551, "e000551"],
						[552, "e000552"],
					],
				);
				assert.equal(appended, 1);
			});
		});
	});

	it("gives up a JSONL range read after a bounded number of attempts when the file is rewritten during each one (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const text = fileText(numbered("e", 600));
			await writeFile(path, text);
			const before = await stat(path);
			await withJsonl(directory, async (store) => {
				let rewrites = 0;
				const query: SessionEntriesQuery = {
					toSeq: 552,
					get fromSeq(): number {
						rewrites++;
						writeFileSync(path, text);
						utimesSync(path, before.atime, new Date(before.mtimeMs + rewrites * 5000));
						return 551;
					},
				};
				await assert.rejects(
					store.readEntryRange("s", query),
					(error: Error) =>
						error instanceof StorageUnavailableError &&
						/changed while it was being read/.test(String((error.cause as Error).message)),
				);
				assert.equal(rewrites, 3);
			});
		});
	});

	it("reads a JSONL session right after this store appends to it with no more file reads than a repeated read (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			await writeFile(path, fileText(numbered("e", 20_000)));
			await withJsonl(directory, async (store) => {
				await store.readEntryRange("s", { fromSeq: 19_990, toSeq: 19_990 });
				await store.append("s", [info("own")], { expectSeq: 20_000 });
				const query = { fromSeq: 19_999, toSeq: 20_001 };
				const afterAppend = await fileReads(path, () => store.readEntryRange("s", query));
				const repeated = await fileReads(path, () => store.readEntryRange("s", query));
				for (const { result } of [afterAppend, repeated])
					assert.deepEqual(
						result.entries.map((item) => item.entry.id),
						["e019999", "e020000", "own"],
					);
				assert.ok(afterAppend.calls <= repeated.calls, `${afterAppend.calls} reads, then ${repeated.calls}`);
			});
		});
	});

	it("adopts cached session end state and post-read growth stamps so reading newest entries right after an append stays bounded (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			const base = numbered("e", 20_000);
			await writeFile(path, fileText(base));
			await withJsonl(directory, async (store) => {
				await store.append("s", [info("own")], { expectSeq: 20_000 });
				const seeded = await fileReads(path, () => store.readEntryRange("s", { fromSeq: 1, toSeq: 1 }));
				assert.equal(seeded.result.lastSeq, 20_001);
				assert.equal(seeded.calls, 3);
				appendFileSync(path, `${JSON.stringify(info("after-own"))}\n`);
				let appendedDuringRead = false;
				const newest = await fileReads(path, () =>
					store.readEntryRange("s", {
						toSeq: 20_002,
						get fromSeq(): number {
							if (!appendedDuringRead) {
								appendedDuringRead = true;
								appendFileSync(path, `${JSON.stringify(info("during-read"))}\n`);
							}
							return 20_002;
						},
					}),
				);
				assert.deepEqual(
					newest.result.entries.map((item) => [item.seq, item.entry.id]),
					[[20_002, "after-own"]],
				);
				assert.ok(newest.bytes < 128 * 1024, `read ${newest.bytes} bytes`);
				const afterConcurrentAppend = await fileReads(path, () =>
					store.readEntryRange("s", { fromSeq: 20_003, toSeq: 20_003 }),
				);
				assert.deepEqual(
					afterConcurrentAppend.result.entries.map((item) => [item.seq, item.entry.id]),
					[[20_003, "during-read"]],
				);
				assert.equal(afterConcurrentAppend.calls, 5);
				assert.ok(afterConcurrentAppend.bytes < 128 * 1024, `read ${afterConcurrentAppend.bytes} bytes`);
			});
			await writeFile(path, fileText(base));
			await withJsonl(directory, async (store) => {
				let appended = false;
				await store.readEntryRange("s", {
					toSeq: 552,
					get fromSeq(): number {
						if (!appended) {
							appended = true;
							appendFileSync(path, `${JSON.stringify(info("during"))}\n`);
						}
						return 551;
					},
				});
				const before = await stat(path);
				const rewritten = [...base.slice(0, 2), ...mergedFirstTwo(base.slice(2), (id) => id), info("during")];
				await writeFile(path, fileText(rewritten));
				assert.equal((await stat(path)).size, before.size);
				await utimes(path, before.atime, new Date(before.mtimeMs + 5000));
				const page = await store.readEntryRange("s", { fromSeq: 551, toSeq: 551 });
				assert.deepEqual(
					page.entries.map((item) => [item.seq, item.entry.id]),
					[[551, "e000552"]],
				);
			});
		});
	});

	it("skips an oversized released memory-store entry by its type without reading it whole (#5250)", async () => {
		const { files, bytesRead } = countedHistoryFiles();
		const store = new MemorySessionStore(undefined, files);
		try {
			const dataBytes = 8 * 1024 * 1024;
			await store.create(header, [info("a"), custom("big", "x".repeat(dataBytes)), info("c")]);
			await store.releaseSession("s");
			const before = bytesRead();
			const page = await store.readEntryRange("s", {
				fromSeq: 1,
				toSeq: 3,
				largeEntryBytes: 64 * 1024,
				skipTypes: ["custom"],
			});
			assert.deepEqual(
				page.entries.map((item) => item.seq),
				[1, 3],
			);
			assert.ok(bytesRead() - before < dataBytes / 4, `read ${bytesRead() - before} bytes`);
		} finally {
			await store.close();
		}
	});

	it("skips an oversized memory-store entry whose type value crosses a read window (#5250)", async () => {
		const prefix = `{"id":"big","parentId":null,"timestamp":"${createdAt}","customType":"snap","data":"`;
		const valueStart = 64 * 1024 - 3;
		const data = "x".repeat(valueStart - Buffer.byteLength(prefix) - Buffer.byteLength('","type":'));
		const big = {
			id: "big",
			parentId: null,
			timestamp: createdAt,
			customType: "snap",
			data,
			type: "custom",
		} as const;
		assert.equal(JSON.stringify(big).indexOf('"custom"}'), valueStart);
		const store = new MemorySessionStore();
		try {
			await store.create(header, [info("a"), big, info("c")]);
			const page = await store.readEntryRange("s", {
				fromSeq: 1,
				toSeq: 3,
				largeEntryBytes: 1024,
				skipTypes: ["custom"],
			});
			assert.deepEqual(
				page.entries.map((item) => item.seq),
				[1, 3],
			);
		} finally {
			await store.close();
		}
	});

	it("checks a grown JSONL session's index with a bounded number of reads in flight (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			await writeFile(path, fileText(numbered("e", 40_000)));
			await withJsonl(directory, async (store) => {
				await store.readEntryRange("s", { fromSeq: 39_990, toSeq: 39_990 });
				appendFileSync(path, `${JSON.stringify(info("appended"))}\n`);
				const { result: page, maxInFlight } = await trackedReads(
					path,
					() => {},
					() => store.readEntryRange("s", { fromSeq: 40_001, toSeq: 40_001 }),
				);
				assert.deepEqual(
					page.entries.map((item) => item.entry.id),
					["appended"],
				);
				assert.ok(maxInFlight <= 32, `${maxInFlight} reads in flight`);
			});
		});
	});

	it("stops checking a grown JSONL session's index once the read is aborted (#5250)", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			await writeFile(path, fileText(numbered("e", 40_000)));
			await withJsonl(directory, async (store) => {
				await store.readEntryRange("s", { fromSeq: 39_990, toSeq: 39_990 });
				appendFileSync(path, `${JSON.stringify(info("appended"))}\n`);
				const controller = new AbortController();
				let smallReads = 0;
				let afterAbort = 0;
				await assert.rejects(
					trackedReads(
						path,
						(length) => {
							if (controller.signal.aborted) afterAbort++;
							if (length <= 64 && ++smallReads === 2) controller.abort(new Error("stop"));
						},
						() => store.readEntryRange("s", { fromSeq: 40_001, toSeq: 40_001, signal: controller.signal }),
					),
					/stop/,
				);
				assert.ok(controller.signal.aborted);
				assert.ok(afterAbort < 32, `${afterAbort} reads after the abort`);
				const { result: page, bytes } = await fileReads(path, () =>
					store.readEntryRange("s", { fromSeq: 40_001, toSeq: 40_001 }),
				);
				assert.deepEqual(
					page.entries.map((item) => item.entry.id),
					["appended"],
				);
				assert.ok(bytes < 512 * 1024, `read ${bytes} bytes after the aborted read`);
			});
		});
	});

	it("retries a JSONL range read when the file is truncated while re-reading or validating a >1 MiB line (#5250)", async () => {
		const data = "y".repeat(2 * 1024 * 1024);
		const typeLast = `{"id":"type-last","parentId":null,"timestamp":"${createdAt}","customType":"snap","data":"${data}","type":"custom"}`;
		const longer = `{"id":"replaced","parentId":null,"timestamp":"${createdAt}","customType":"snap","data":"${"z".repeat(2 * 1024 * 1024 + 1024)}","type":"custom"}`;
		const prefix = [...numbered("e", 300), info("keep")];
		const truncatedText = fileText(prefix);
		const regrownText = `${truncatedText}${longer}\n`;
		await withDirectory(async (directory) => {
			const path = join(directory, "s.jsonl");
			for (const mode of ["terminated-reread", "unterminated-validator", "unterminated-reread"] as const) {
				const initial = `${truncatedText}${typeLast}${mode === "terminated-reread" ? "\n" : ""}`;
				await writeFile(path, initial);
				const lineOffset = Buffer.byteLength(truncatedText);
				await withJsonl(directory, async (store) => {
					await store.readEntryRange("s", { fromSeq: 1, toSeq: 301 });
					let truncated = false;
					let readsAtLine = 0;
					const handle = await open(path, "r");
					const prototype = Object.getPrototypeOf(handle) as FileHandlePrototype;
					await handle.close();
					const read = prototype.read;
					prototype.read = async function (
						this: FileHandle,
						buffer: Buffer,
						offset: number,
						length: number,
						position: number | null,
					) {
						const trigger =
							!truncated &&
							(mode !== "unterminated-validator"
								? length > 64 * 1024
								: position === lineOffset && ++readsAtLine === 2);
						if (trigger) {
							truncated = true;
							writeFileSync(path, truncatedText);
						}
						try {
							return await read.call(this, buffer, offset, length, position);
						} finally {
							if (trigger) writeFileSync(path, regrownText);
						}
					};
					try {
						const page = await store.readEntryRange("s", {
							fromSeq: 302,
							toSeq: 302,
							skipTypes: ["session_info"],
							largeEntryBytes: 1024,
						});
						assert.ok(truncated, mode);
						assert.equal(page.lastSeq, 302, mode);
						assert.deepEqual(
							page.entries.map((item) => [
								item.seq,
								item.rawChunks === undefined ? item.entry.id : Buffer.concat(item.rawChunks).toString("utf8"),
							]),
							[[302, longer]],
							mode,
						);
					} finally {
						prototype.read = read;
					}
				});
			}
		});
	});
});
