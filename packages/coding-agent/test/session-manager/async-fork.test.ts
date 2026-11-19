import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as streams from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "fs";
import { test, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { StorageUnavailableError } from "../../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

test("streamed forks retain history and can append without replacing it (#3577)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-stream-fork-"));
	try {
		const source = join(dir, "source.jsonl");
		const header = { type: "session", version: 4, id: "source", createdAt: new Date().toISOString(), cwd: dir };
		const entry = {
			type: "message",
			id: "history",
			parentId: null,
			timestamp: header.createdAt,
			message: { role: "user", content: "日本語".repeat(100_000), timestamp: 1 },
		};
		const content = `${JSON.stringify(header)}\n${JSON.stringify(entry)}`;
		await writeFile(source, content);
		const workflow = { runId: "run", stageId: "stage", stageName: "build" };
		const syncCalls = [
			"existsSync",
			"statSync",
			"readSync",
			"readFileSync",
			"writeFileSync",
			"appendFileSync",
			"mkdirSync",
		] as const;
		const spies = syncCalls.map((name) =>
			vi.spyOn(fs, name).mockImplementation(() => {
				throw new Error(`Unexpected synchronous filesystem call: ${name}`);
			}),
		);
		const reads = vi.mocked(streams.createReadStream);
		const writes = vi.mocked(fsPromises.writeFile);
		reads.mockClear();
		writes.mockClear();
		let fork: SessionManager;
		try {
			fork = await SessionManager.forkFrom(source, dir, join(dir, "forks"), { internal: true, workflow });
			assert.equal(reads.mock.calls.length, 1);
			assert.equal(reads.mock.calls[0][0], source);
			assert.equal(writes.mock.calls.length, 1);
			assert.equal(String(writes.mock.calls[0][0]).startsWith(`${fork.getSessionFile()}.`), true);
			assert.equal(String(writes.mock.calls[0][0]).endsWith(".tmp"), true);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		assert.equal(fork.getLeafId(), "history");
		assert.deepEqual(fork.getEntries(), [entry]);
		assert.deepEqual(fork.getHeader()?.workflow, workflow);
		assert.equal(fork.getHeader()?.parentSessionId, "source");
		await fork.appendCustomEntry("after-fork", { saved: true });
		const reopened = await SessionManager.open(fork.getSessionFile()!);
		assert.deepEqual(reopened.getEntries(), fork.getEntries());
		assert.equal(await readFile(source, "utf8"), content);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("forking an exported file leaves retired messages in the source file (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-windowed-fork-"));
	try {
		const file = join(dir, "export.jsonl");
		const timestamp = new Date().toISOString();
		const branch = [
			{ type: "session", version: 4, id: "source", cwd: dir, createdAt: timestamp },
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp,
				message: { role: "user", content: "retired private data", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "boundary",
				parentId: "old",
				timestamp,
				firstKeptEntryId: null,
				summary: "cleared",
				tokensBefore: 100,
				details: { strategy: "verbatim-lines" },
			},
			{
				type: "message",
				id: "now",
				parentId: "boundary",
				timestamp,
				message: { role: "user", content: "current", timestamp: 2 },
			},
		];
		await writeFile(file, branch.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const child = await SessionManager.forkFrom(file, dir, join(dir, "dest"));
		assert.equal(await child.findEntrySeq("old"), undefined);
		assert.deepEqual(
			child.getBranch().map((entry) => entry.id),
			["boundary", "now"],
		);
		assert.equal(child.getHeader()?.parentInOtherStore, true);
		await child.getSessionStore().close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a fork reads a named historical blob only from the selected export and does not index neighbouring files (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-file-receipt-"));
	const dest = new MemorySessionStore();
	try {
		const time = "2025-01-01T00:00:00.000Z";
		const header = { type: "session", version: 4, id: "source", createdAt: time, cwd: dir };
		const payload = Buffer.from("selected file");
		const hash = createHash("sha256").update(payload).digest("hex");
		const receipt = {
			type: "custom",
			customType: "atomic.tool-output",
			id: "receipt",
			parentId: null,
			timestamp: time,
			data: { hash, bytes: payload.byteLength, toolCallId: "call", base64: payload.toString("base64") },
		};
		const boundary = {
			type: "compaction",
			id: "clear",
			parentId: "receipt",
			timestamp: time,
			firstKeptEntryId: null,
			summary: "clear",
			tokensBefore: 100,
			details: { strategy: "verbatim-lines" },
		};
		const tail = {
			type: "message",
			id: "now",
			parentId: "clear",
			timestamp: time,
			message: { role: "user", content: `Read tool-output://${hash}`, timestamp: 2 },
		};
		const selected = join(dir, "selected.jsonl");
		const other = `${time.replaceAll(":", "-")}_${createHash("sha256").update(header.id).digest("hex")}.jsonl`;
		await writeFile(selected, [header, receipt, boundary, tail].map((r) => JSON.stringify(r)).join("\n") + "\n");
		await writeFile(join(dir, other), JSON.stringify(header) + "\n");
		const child = await SessionManager.forkFrom(selected, dir, dest);
		assert.deepEqual(Buffer.from((await dest.getBlob(child.getSessionId(), hash)) ?? []), payload);
		assert.deepEqual((await fsPromises.readdir(dir)).sort(), [other, "selected.jsonl"].sort());
	} finally {
		await dest.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("streamed forks reject missing and invalid sources without creating a session (#3577)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-invalid-fork-"));
	try {
		const source = join(dir, "source.jsonl");
		const destination = join(dir, "forks");
		await assert.rejects(SessionManager.forkFrom(source, dir, destination), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
			return true;
		});
		await writeFile(source, "not a session\n");
		await assert.rejects(SessionManager.forkFrom(source, dir, destination), StorageUnavailableError);
		await assert.rejects(fsPromises.access(destination), { code: "ENOENT" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("opening a missing explicit session creates its directory and persists at that path (#3577)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-missing-open-"));
	try {
		const sessionDir = join(dir, "nested", "sessions");
		const path = join(sessionDir, "explicit.jsonl");
		const session = await SessionManager.open(path, sessionDir, dir);
		assert.equal(session.getSessionFile(), path);
		assert.equal((await fsPromises.stat(sessionDir)).isDirectory(), true);
		await session.appendMessage({ role: "user", content: "first message", timestamp: Date.now() });
		const reopened = await SessionManager.open(path);
		assert.equal(reopened.getSessionId(), session.getSessionId());
		assert.deepEqual(reopened.getEntries(), session.getEntries());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
