import assert from "node:assert/strict";
import * as streams from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "fs";
import { test, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

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
		const header = { type: "session", version: 3, id: "source", timestamp: new Date().toISOString(), cwd: dir };
		const entry = {
			type: "custom",
			id: "history",
			parentId: null,
			timestamp: header.timestamp,
			customType: "saved",
			data: "日本語".repeat(100_000),
		};
		const content = `${JSON.stringify(header)}\nmalformed\n${JSON.stringify(entry)}`;
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
			fork = await SessionManager.forkFromAsync(source, dir, join(dir, "forks"), { internal: true, workflow });
			assert.equal(reads.mock.calls.length, 1);
			assert.equal(reads.mock.calls[0][0], source);
			assert.equal(writes.mock.calls.length, 1);
			assert.equal(writes.mock.calls[0][0], fork.getSessionFile());
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		assert.equal(fork.getLeafId(), "history");
		assert.deepEqual(fork.getEntries(), [entry]);
		assert.deepEqual(fork.getHeader()?.workflow, workflow);
		assert.equal(fork.getHeader()?.parentSession, source);
		fork.appendCustomEntry("after-fork", { saved: true });
		const reopened = SessionManager.open(fork.getSessionFile()!);
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
		await assert.rejects(SessionManager.forkFromAsync(source, dir, destination), { code: "ENOENT" });
		await writeFile(source, "not a session\n");
		await assert.rejects(SessionManager.forkFromAsync(source, dir, destination), /empty or invalid/);
		await assert.rejects(fsPromises.access(destination), { code: "ENOENT" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
