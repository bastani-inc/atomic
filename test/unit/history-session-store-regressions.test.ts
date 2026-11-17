import assert from "node:assert/strict";
import { renameSync, utimesSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { EntryTypeReader } from "../../packages/coding-agent/src/core/storage/session/entry-type.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
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
				const baseline = process.memoryUsage().arrayBuffers;
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
});
