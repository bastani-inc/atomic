import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { registerSessionStoreConformance } from "./conformance.js";
import { SessionConflictError, StorageUnavailableError, StoreClosedError } from "./errors.js";
import { JsonlSessionStore, JsonlStoragePoisonedError, SessionFormatVersionError } from "./jsonl-session-store.js";
import { SESSION_FORMAT_VERSION } from "./types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fs, appendFile: vi.fn(fs.appendFile), truncate: vi.fn(fs.truncate), rename: vi.fn(fs.rename) };
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
