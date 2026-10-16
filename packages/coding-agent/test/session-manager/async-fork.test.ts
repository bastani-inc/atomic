import assert from "node:assert/strict";
import * as streams from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "fs";
import { test, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { StorageUnavailableError } from "../../src/core/storage/session/errors.js";

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
			type: "custom",
			id: "history",
			parentId: null,
			timestamp: header.createdAt,
			customType: "saved",
			data: "日本語".repeat(100_000),
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
