import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {
	appendFile,
	chmod,
	type FileHandle,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import {
	SessionConflictError,
	SessionExistsError,
	StorageUnavailableError,
	StoreClosedError,
} from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	JsonlSessionStore,
	JsonlStoragePoisonedError,
	SessionFormatVersionError,
} from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		readFile: vi.fn(fs.readFile),
		appendFile: vi.fn(fs.appendFile),
		truncate: vi.fn(fs.truncate),
		rename: vi.fn(fs.rename),
	};
});

afterEach(() => vi.clearAllMocks());

const header = {
	id: "session",
	version: SESSION_FORMAT_VERSION,
	createdAt: "2026-10-15T00:00:00Z",
	cwd: "/project",
} as const;
const entry = {
	type: "session_info",
	id: "entry",
	parentId: null,
	timestamp: header.createdAt,
	name: " Name ",
} as const;

async function withStore(body: (store: JsonlSessionStore, directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-session-"));
	const store = await JsonlSessionStore.open(directory);
	try {
		await body(store, directory);
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const value of values) results.push(value);
	return results;
}

async function location(store: JsonlSessionStore): Promise<string> {
	const [summary] = await collect(store.list({}));
	assert.ok(summary?.location);
	return summary.location;
}

registerSessionStoreConformance({ describe, it }, "JsonlSessionStore", async (body) => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-session-"));
	let store = await JsonlSessionStore.open(directory);
	try {
		await body({
			store,
			reopen: async () => {
				store = await JsonlSessionStore.open(directory);
				return store;
			},
		});
	} finally {
		await store.close().catch((error: Error) => assert.ok(error instanceof StoreClosedError));
		await rm(directory, { recursive: true, force: true });
	}
});

it("commits format 4 header and ordered entry lines before resolving", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-session-"));
	const store = await JsonlSessionStore.open(directory);
	try {
		const header = {
			id: "session",
			version: SESSION_FORMAT_VERSION,
			createdAt: "2026-10-15T00:00:00Z",
			cwd: "/project",
			parentSessionId: "parent",
		} as const;
		const entry = {
			type: "session_info",
			id: "name",
			parentId: null,
			timestamp: header.createdAt,
			name: " Name ",
		} as const;
		await store.create(header, [entry]);
		const [summary] = await collect(store.list({}));
		assert.ok(summary?.location);
		assert.equal(
			await readFile(summary.location, "utf8"),
			`${JSON.stringify({ type: "session", ...header })}\n${JSON.stringify(entry)}\n`,
		);
		const reopened = await JsonlSessionStore.open(directory);
		assert.deepEqual(await reopened.load(header.id), { header, entries: [entry], lastSeq: 1 });
		await reopened.close();
	} finally {
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const version of [undefined, null, false, 0, 1, 2, 3, 5, "4", {}, []]) {
	it(`rejects format ${JSON.stringify(version)} without changing bytes and omits it from listing`, async () => {
		await withStore(async (store, directory) => {
			const path = join(directory, "unsupported.jsonl");
			const content = `${JSON.stringify({ type: "session", ...header, version })}\n{"torn":`;
			await writeFile(path, content);
			const isVersion = (error: Error): boolean => {
				assert.ok(error instanceof SessionFormatVersionError);
				assert.equal(error.path, path);
				assert.deepEqual(error.found, version);
				assert.equal(error.supported, 4);
				return true;
			};
			await assert.rejects(store.load(header.id), isVersion);
			await assert.rejects(store.readHeader(header.id), isVersion);
			await assert.rejects(store.append(header.id, [], { expectSeq: 0 }), isVersion);
			await assert.rejects(store.create(header, []), isVersion);
			await assert.rejects(store.replace(header.id, header, [], { expectSeq: 0 }), isVersion);
			await assert.rejects(store.delete(header.id), isVersion);
			assert.deepEqual(await collect(store.list({})), []);
			assert.equal(await store.findMostRecent({ cwd: header.cwd }), undefined);
			assert.equal(await readFile(path, "utf8"), content);
		});
	});
}

it("never repairs a torn final line and wraps the parse failure", async () => {
	await withStore(async (store, directory) => {
		const path = join(directory, "torn.jsonl");
		const content = `${JSON.stringify({ type: "session", ...header })}\n${JSON.stringify(entry)}\n{"type":`;
		await writeFile(path, content);
		assert.deepEqual(await store.readHeader(header.id), header);
		const isUnavailable = (error: Error): boolean => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.adapter, "jsonl");
			assert.equal(error.location, directory);
			assert.ok(error.cause instanceof SyntaxError);
			return true;
		};
		await assert.rejects(store.load(header.id), isUnavailable);
		await assert.rejects(store.append(header.id, [entry], { expectSeq: 1 }), isUnavailable);
		assert.equal(await readFile(path, "utf8"), content);
	});
});

it("reads an unterminated complete record unchanged and appends a separate line", async () => {
	await withStore(async (store, directory) => {
		const path = join(directory, "complete.jsonl");
		const content = `${JSON.stringify({ type: "session", ...header })}\n${JSON.stringify(entry)}`;
		await writeFile(path, content);
		assert.deepEqual(await store.load(header.id), { header, entries: [entry], lastSeq: 1 });
		assert.equal(await readFile(path, "utf8"), content);
		await store.append(header.id, [entry], { expectSeq: 1 });
		assert.deepEqual((await store.load(header.id)).entries, [entry, entry]);
	});
});

it("reads a complete Unicode header at EOF without requiring a newline", async () => {
	await withStore(async (store, directory) => {
		const path = join(directory, "header.jsonl");
		const unicodeHeader = { ...header, cwd: "/文😀" };
		const content = JSON.stringify({ type: "session", ...unicodeHeader });
		await writeFile(path, content);
		assert.deepEqual(await store.readHeader(header.id), unicodeHeader);
		assert.deepEqual(await store.load(header.id), { header: unicodeHeader, entries: [], lastSeq: 0 });
		assert.equal(await readFile(path, "utf8"), content);
		await store.append(header.id, [entry], { expectSeq: 0 });
		assert.deepEqual((await store.load(header.id)).entries, [entry]);
	});
});

it("rolls back partial append failure and accepts the next write at the unchanged sequence", async () => {
	await withStore(async (store) => {
		await store.create(header, [entry]);
		const path = await location(store);
		const before = await readFile(path, "utf8");
		const failure = new Error("append fault");
		vi.mocked(appendFile).mockImplementationOnce(async () => {
			await writeFile(path, `${before}{"partial":`);
			throw failure;
		});
		await assert.rejects(store.append(header.id, [entry], { expectSeq: 1 }), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.cause, failure);
			return true;
		});
		assert.equal(await readFile(path, "utf8"), before);
		assert.deepEqual(await store.append(header.id, [entry], { expectSeq: 1 }), { lastSeq: 2 });
	});
});

it("poisons all subsequent operations after append rollback fails", async () => {
	await withStore(async (store) => {
		await store.create(header, []);
		const path = await location(store);
		const failure = new Error("append fault");
		const rollbackFailure = new Error("rollback fault");
		vi.mocked(appendFile).mockRejectedValueOnce(failure);
		vi.mocked(truncate).mockRejectedValueOnce(rollbackFailure);
		const isPoisoned = (error: Error): boolean => {
			assert.ok(error instanceof JsonlStoragePoisonedError);
			assert.equal(error.location, path);
			assert.equal(error.cause, failure);
			assert.equal(error.rollbackCause, rollbackFailure);
			return true;
		};
		await assert.rejects(store.append(header.id, [entry], { expectSeq: 0 }), isPoisoned);
		await assert.rejects(store.load(header.id), isPoisoned);
		await assert.rejects(store.create({ ...header, id: "other" }, []), isPoisoned);
		await assert.rejects(store.replace(header.id, header, [], { expectSeq: 0 }), isPoisoned);
		await assert.rejects(store.readHeader(header.id), isPoisoned);
		await assert.rejects(store.delete(header.id), isPoisoned);
		await assert.rejects(collect(store.list({})), isPoisoned);
		await assert.rejects(store.findMostRecent({ cwd: header.cwd }), isPoisoned);
	});
});

it("keeps the old file on failed replace without creating a compaction backup", async () => {
	await withStore(async (store, directory) => {
		await store.create(header, [entry]);
		const path = await location(store);
		const before = await readFile(path, "utf8");
		const failure = new Error("rename fault");
		vi.mocked(rename).mockRejectedValueOnce(failure);
		await assert.rejects(
			store.replace(header.id, { ...header, internal: true }, [], { expectSeq: 1 }),
			(error: Error) => {
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.cause, failure);
				return true;
			},
		);
		assert.equal(await readFile(path, "utf8"), before);
		await store.replace(header.id, { ...header, internal: true }, [], { expectSeq: 1 });
		const [project] = await readdir(directory);
		assert.ok(project);
		const backups = (await readdir(join(directory, project))).filter((name) => name.endsWith(".bak"));
		assert.deepEqual(backups, []);
	});
});

it("detects a stale sequence from a separately opened handle and drains writes before close", async () => {
	await withStore(async (store, directory) => {
		await store.create(header, []);
		const second = await JsonlSessionStore.open(directory);
		await store.append(header.id, [entry], { expectSeq: 0 });
		await assert.rejects(second.append(header.id, [entry], { expectSeq: 0 }), (error: Error) => {
			assert.ok(error instanceof SessionConflictError);
			assert.equal(error.sessionId, header.id);
			assert.equal(error.expectedSeq, 0);
			assert.equal(error.actualSeq, 1);
			return true;
		});
		const appended = second.append(header.id, [entry], { expectSeq: 1 });
		const closed = second.close();
		await assert.rejects(second.load(header.id), StoreClosedError);
		await appended;
		await closed;
		assert.equal((await store.load(header.id)).lastSeq, 2);
	});
});

it("wraps an unavailable configured directory without a fallback", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jsonl-unavailable-"));
	try {
		const path = join(directory, "file");
		await writeFile(path, "not a directory");
		await assert.rejects(JsonlSessionStore.open(path), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.adapter, "jsonl");
			assert.equal(error.location, path);
			assert.ok(error.cause instanceof Error);
			return true;
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("keeps the session key when replacing verbatim header identity and project fields", async () => {
	await withStore(async (store, directory) => {
		await store.create(header, []);
		const replacement = { ...header, id: "other", cwd: "/other/../project" };
		await store.replace(header.id, replacement, [], { expectSeq: 0 });
		const reopened = await JsonlSessionStore.open(directory);
		try {
			assert.deepEqual(await reopened.readHeader(header.id), replacement);
			assert.equal(await reopened.readHeader("other"), undefined);
			await reopened.append(header.id, [entry], { expectSeq: 0 });
			assert.deepEqual((await reopened.load(header.id)).entries, [entry]);
		} finally {
			await reopened.close();
		}
	});
});

it("backs up the committed transcript before appending a compaction boundary", async () => {
	await withStore(async (store, directory) => {
		await store.create(header, [entry]);
		const before = await readFile(await location(store), "utf8");
		await store.append(
			header.id,
			[
				{
					type: "compaction",
					id: "compact",
					parentId: null,
					timestamp: header.createdAt,
					summary: "summary",
					firstKeptEntryId: null,
					tokensBefore: 1,
				},
			],
			{ expectSeq: 1 },
		);
		const [project] = await readdir(directory);
		assert.ok(project);
		const backups = (await readdir(join(directory, project))).filter((name) => name.endsWith(".compact.bak"));
		assert.equal(backups.length, 1);
		assert.equal(await readFile(join(directory, project, backups[0]!), "utf8"), before);
	});
});

it("rejects duplicate identity from overlapping handles across different projects", async () => {
	await withStore(async (store, directory) => {
		const other = await JsonlSessionStore.open(directory);
		try {
			const results = await Promise.allSettled([
				store.create({ ...header, cwd: "/a" }, []),
				other.create({ ...header, cwd: "/b", createdAt: "2026-10-16T00:00:00Z" }, []),
			]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			const rejected = results.find((result) => result.status === "rejected");
			assert.ok(rejected?.status === "rejected");
			assert.ok(rejected.reason instanceof SessionExistsError);
			assert.equal(rejected.reason.sessionId, header.id);
			assert.equal((await collect(store.list({}))).length, 1);
		} finally {
			await other.close();
		}
	});
});

it("admits exactly one overlapping append across opened handles", async () => {
	await withStore(async (store, directory) => {
		await store.create(header, []);
		const other = await JsonlSessionStore.open(directory);
		try {
			const results = await Promise.allSettled([
				store.append(header.id, [entry], { expectSeq: 0 }),
				other.append(header.id, [{ ...entry, id: "other" }], { expectSeq: 0 }),
			]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			const rejected = results.find((result) => result.status === "rejected");
			assert.ok(rejected?.status === "rejected");
			assert.ok(rejected.reason instanceof SessionConflictError);
			assert.equal(rejected.reason.expectedSeq, 0);
			assert.equal(rejected.reason.actualSeq, 1);
			assert.equal((await store.load(header.id)).lastSeq, 1);
		} finally {
			await other.close();
		}
	});
});

for (const id of ["文".repeat(32), "x".repeat(200)]) {
	it(`round-trips a permitted ${id.length}-character identity without filename limits`, async () => {
		await withStore(async (store, directory) => {
			const input = { ...header, id };
			assert.deepEqual(await store.create(input, [entry]), { lastSeq: 1 });
			const reopened = await JsonlSessionStore.open(directory);
			try {
				assert.deepEqual(await reopened.load(id), { header: input, entries: [entry], lastSeq: 1 });
				await reopened.replace(id, { ...input, id: `${id}-changed` }, [], { expectSeq: 1 });
				assert.equal((await store.readHeader(id))?.id, `${id}-changed`);
				await store.delete(id);
			} finally {
				await reopened.close();
			}
		});
	});
}

it("appends small batches without rereading or parsing the committed 4 MiB transcript", async () => {
	await withStore(async (store) => {
		await store.create(header, [{ ...entry, name: "x".repeat(4 * 1024 * 1024) }]);
		vi.mocked(readFile).mockClear();
		const parse = vi.spyOn(JSON, "parse");
		const handles: FileHandle[] = [];
		const originalOpen = fs.open;
		const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await originalOpen(...args);
			vi.spyOn(handle, "read");
			handles.push(handle);
			return handle;
		});
		try {
			for (let index = 1; index <= 3; index++) {
				assert.deepEqual(await store.append(header.id, [entry], { expectSeq: index }), { lastSeq: index + 1 });
			}
			const transcriptReads = vi.mocked(readFile).mock.calls.filter(([path]) => String(path).endsWith(".jsonl"));
			assert.equal(transcriptReads.length, 0);
			assert.equal(parse.mock.calls.filter(([text]) => text.length >= 4 * 1024 * 1024).length, 0);
			const headerBytes = Buffer.byteLength(`${JSON.stringify({ type: "session", ...header })}\n`);
			assert.equal(handles.length, 3);
			for (const handle of handles) {
				let position = 0;
				const reads = vi.mocked(handle.read);
				for (const [index, result] of reads.mock.results.entries()) {
					assert.equal(reads.mock.calls[index]?.at(-1), null);
					assert.equal(result.type, "return");
					if (result.type === "return") position += (await result.value).bytesRead;
					assert.ok(position <= headerBytes);
				}
				assert.equal(position, headerBytes);
			}
		} finally {
			parse.mockRestore();
			opened.mockRestore();
			for (const handle of handles) vi.mocked(handle.read).mockRestore();
		}
		assert.equal((await store.load(header.id)).lastSeq, 4);
	});
});

for (const terminated of [true, false]) {
	it(`retains loaded sequence state for header-only appends after reopening (${terminated ? "newline" : "EOF"})`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "jsonl-reopen-"));
		let store = await JsonlSessionStore.open(directory);
		try {
			const entries = Array.from({ length: 4096 }, (_, index) => ({
				...entry,
				id: `entry-${index}`,
				name: "x".repeat(1024),
			}));
			await store.create(header, entries);
			const path = await location(store);
			if (!terminated) await truncate(path, (await fs.stat(path)).size - 1);
			await store.close();
			store = await JsonlSessionStore.open(directory);
			assert.deepEqual((await store.load(header.id)).entries, entries);
			vi.mocked(readFile).mockClear();
			const parse = vi.spyOn(JSON, "parse");
			const handles: FileHandle[] = [];
			const originalOpen = fs.open;
			const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await originalOpen(...args);
				vi.spyOn(handle, "read");
				handles.push(handle);
				return handle;
			});
			try {
				for (let index = 0; index < 2; index++) {
					assert.deepEqual(await store.append(header.id, [entry], { expectSeq: entries.length + index }), {
						lastSeq: entries.length + index + 1,
					});
				}
				assert.equal(vi.mocked(readFile).mock.calls.filter(([file]) => String(file).endsWith(".jsonl")).length, 0);
				assert.equal(parse.mock.calls.filter(([text]) => text.length > 1024).length, 0);
				const headerBytes = Buffer.byteLength(`${JSON.stringify({ type: "session", ...header })}\n`);
				assert.equal(handles.length, 2);
				for (const handle of handles) {
					let position = 0;
					const reads = vi.mocked(handle.read);
					for (const [index, result] of reads.mock.results.entries()) {
						assert.equal(reads.mock.calls[index]?.at(-1), null);
						assert.equal(result.type, "return");
						if (result.type === "return") position += (await result.value).bytesRead;
						assert.ok(position <= headerBytes);
					}
					assert.equal(position, headerBytes);
				}
			} finally {
				parse.mockRestore();
				opened.mockRestore();
				for (const handle of handles) vi.mocked(handle.read).mockRestore();
			}
			assert.deepEqual((await store.load(header.id)).entries, [...entries, entry, entry]);
		} finally {
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const terminated of [true, false]) {
	it(`opens ready for direct header-only appends (${terminated ? "newline" : "EOF"})`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "jsonl-direct-reopen-"));
		let store = await JsonlSessionStore.open(directory);
		try {
			const entries = Array.from({ length: 4096 }, (_, index) => ({
				...entry,
				id: `entry-${index}`,
				name: "x".repeat(1024),
			}));
			await store.create(header, entries);
			const path = await location(store);
			if (!terminated) await truncate(path, (await fs.stat(path)).size - 1);
			await store.close();
			store = await JsonlSessionStore.open(directory);
			vi.mocked(readFile).mockClear();
			const parse = vi.spyOn(JSON, "parse");
			const handles: FileHandle[] = [];
			const originalOpen = fs.open;
			const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await originalOpen(...args);
				vi.spyOn(handle, "read");
				handles.push(handle);
				return handle;
			});
			try {
				assert.deepEqual(await store.append(header.id, [], { expectSeq: entries.length }), {
					lastSeq: entries.length,
				});
				await assert.rejects(store.append(header.id, [entry], { expectSeq: 0 }), (error: Error) => {
					assert.ok(error instanceof SessionConflictError);
					assert.equal(error.expectedSeq, 0);
					assert.equal(error.actualSeq, entries.length);
					return true;
				});
				for (let index = 0; index < 2; index++) {
					assert.deepEqual(await store.append(header.id, [entry], { expectSeq: entries.length + index }), {
						lastSeq: entries.length + index + 1,
					});
				}
				assert.equal(vi.mocked(readFile).mock.calls.filter(([file]) => String(file).endsWith(".jsonl")).length, 0);
				assert.equal(parse.mock.calls.filter(([text]) => text.length > 1024).length, 0);
				const headerBytes = Buffer.byteLength(`${JSON.stringify({ type: "session", ...header })}\n`);
				assert.equal(handles.length, 4);
				for (const handle of handles) {
					let position = 0;
					const reads = vi.mocked(handle.read);
					for (const [index, result] of reads.mock.results.entries()) {
						assert.equal(reads.mock.calls[index]?.at(-1), null);
						assert.equal(result.type, "return");
						if (result.type === "return") position += (await result.value).bytesRead;
						assert.ok(position <= headerBytes);
					}
					assert.equal(position, headerBytes);
				}
			} finally {
				parse.mockRestore();
				opened.mockRestore();
				for (const handle of handles) vi.mocked(handle.read).mockRestore();
			}
			assert.deepEqual((await store.load(header.id)).entries, [...entries, entry, entry]);
		} finally {
			await store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const invalid of ["version", "header", "entry"] as const) {
	it(`preserves deferred ${invalid} failure while initializing valid sessions on reopen`, async () => {
		await withStore(async (store, directory) => {
			await store.create(header, [entry]);
			await store.create({ ...header, id: "valid" }, []);
			const path = (await collect(store.list({}))).find((summary) => summary.id === header.id)?.location;
			assert.ok(path);
			const content =
				invalid === "header"
					? "{torn"
					: `${JSON.stringify({ type: "session", ...header, version: invalid === "version" ? 3 : 4 })}\n{torn`;
			await writeFile(path, content);
			const reopened = await JsonlSessionStore.open(directory);
			try {
				assert.deepEqual(await reopened.append("valid", [entry], { expectSeq: 0 }), { lastSeq: 1 });
				const rejected = (error: Error): boolean => {
					if (invalid === "version") {
						assert.ok(error instanceof SessionFormatVersionError);
						assert.equal(error.path, path);
						assert.equal(error.found, 3);
						assert.equal(error.supported, 4);
					} else {
						assert.ok(error instanceof StorageUnavailableError);
						assert.ok(error.cause instanceof SyntaxError);
					}
					return true;
				};
				await assert.rejects(reopened.load(header.id), rejected);
				await assert.rejects(reopened.append(header.id, [], { expectSeq: 1 }), rejected);
				if (invalid === "version") {
					assert.deepEqual(
						(await collect(reopened.list({}))).map((summary) => summary.id),
						["valid"],
					);
				}
				assert.equal(await readFile(path, "utf8"), content);
			} finally {
				await reopened.close();
			}
		});
	});
}

it("refreshes cached sequence after competing replace, deletion and recreation", async () => {
	await withStore(async (store, directory) => {
		await store.create(header, [entry]);
		const other = await JsonlSessionStore.open(directory);
		try {
			const results = await Promise.allSettled([
				store.append(header.id, [entry], { expectSeq: 1 }),
				other.replace(header.id, header, [entry, entry], { expectSeq: 1 }),
			]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			const rejected = results.find((result) => result.status === "rejected");
			assert.ok(rejected?.status === "rejected");
			assert.ok(rejected.reason instanceof SessionConflictError);
			assert.equal(rejected.reason.actualSeq, 2);
			await other.delete(header.id);
			await other.create(header, []);
			assert.deepEqual(await store.append(header.id, [entry], { expectSeq: 0 }), { lastSeq: 1 });
			assert.equal((await other.load(header.id)).lastSeq, 1);
			const path = await location(other);
			const content = await readFile(path, "utf8");
			await writeFile(path, content.replace('"version":4', '"version":3'));
			await assert.rejects(store.append(header.id, [entry], { expectSeq: 1 }), SessionFormatVersionError);
		} finally {
			await other.close();
		}
	});
});

for (const operation of ["empty append", "append", "stale append", "replace", "stale replace"] as const) {
	it(`rejects ${operation} after a non-4 rewrite with identical cached metadata`, async () => {
		await withStore(async (store) => {
			await store.create(header, [entry]);
			const path = await location(store);
			const cachedStats = await fs.stat(path, { bigint: true });
			const content = (await readFile(path, "utf8")).replace('"version":4', '"version":3');
			await writeFile(path, content);
			const metadata = vi.spyOn(fs, "stat").mockResolvedValue(cachedStats);
			try {
				const options = { expectSeq: operation.startsWith("stale") ? 0 : 1 };
				const write = operation.endsWith("replace")
					? store.replace(header.id, header, [], options)
					: store.append(header.id, operation === "empty append" ? [] : [entry], options);
				await assert.rejects(write, (error: Error) => {
					assert.ok(error instanceof SessionFormatVersionError);
					assert.equal(error.path, path);
					assert.equal(error.found, 3);
					assert.equal(error.supported, 4);
					return true;
				});
				assert.equal(await readFile(path, "utf8"), content);
			} finally {
				metadata.mockRestore();
			}
		});
	});
}

it("needs write access only inside the configured session root", async () => {
	const parent = await mkdtemp(join(tmpdir(), "jsonl-parent-"));
	const directory = join(parent, "sessions");
	let store: JsonlSessionStore | undefined;
	try {
		await mkdir(directory);
		await chmod(parent, 0o500);
		store = await JsonlSessionStore.open(directory);
		await store.create(header, []);
		assert.deepEqual(await store.readHeader(header.id), header);
	} finally {
		await store?.close();
		await chmod(parent, 0o700);
		await rm(parent, { recursive: true, force: true });
	}
});
