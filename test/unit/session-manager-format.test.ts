import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { type FileEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { SessionFormatVersionError } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

for (const version of [undefined, 1, 2, 3]) {
	it(`rejects format ${version} before loading, forking, resuming or listing saved context`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "session-format-"));
		try {
			const path = join(directory, "source.jsonl");
			const entries = [
				{ type: "session", version, id: "source", createdAt: "2026-10-15T00:00:00Z", cwd: directory },
				{
					type: "message",
					...(version === 1 ? {} : { id: "message", parentId: null }),
					timestamp: "2026-10-15T00:00:00Z",
					message: { role: "user", content: "saved context", timestamp: 1 },
				},
			];
			const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
			await writeFile(path, content);
			const rejected = (error: Error): boolean => {
				assert.ok(error instanceof SessionFormatVersionError);
				assert.equal(error.found, version);
				assert.equal(error.supported, 4);
				return true;
			};
			await assert.rejects(async () => await SessionManager.open(path), rejected);
			assert.throws(
				() => SessionManager.inMemory(directory, undefined, JSON.parse(JSON.stringify(entries)) as FileEntry[]),
				rejected,
			);
			await assert.rejects(async () => await SessionManager.forkFrom(path, directory, directory), rejected);
			await assert.rejects(SessionManager.forkFrom(path, directory, directory), rejected);
			const active = SessionManager.inMemory(directory);
			await active.appendMessage({ role: "user", content: "active context", timestamp: 1 });
			const before = active.buildSessionContext();
			await assert.rejects(async () => await active.setSessionFile(path), rejected);
			assert.deepEqual(active.buildSessionContext(), before);
			assert.deepEqual(await SessionManager.list(directory, directory), []);
			assert.deepEqual(await SessionManager.listAll(directory), []);
			const recent = await SessionManager.continueRecent(directory, directory);
			assert.notEqual(recent.getSessionId(), "source");
			assert.equal(recent.getHeader()?.version, 4);
			assert.equal(await SessionManager.findById(directory, "source", directory), undefined);
			assert.deepEqual(
				(await readdir(directory)).sort(),
				["source.jsonl", recent.getSessionFile()!.split(/[\\/]/).at(-1)!].sort(),
			);
			assert.deepEqual((await SessionManager.open(recent.getSessionFile()!)).getHeader(), recent.getHeader());
			assert.equal(await readFile(path, "utf8"), content);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

for (const entry of [
	{
		type: "message",
		parentId: null,
		timestamp: "2026-10-15T00:00:00Z",
		message: { role: "user", content: "saved", timestamp: 1 },
	},
	{
		type: "message",
		id: "entry",
		timestamp: "2026-10-15T00:00:00Z",
		message: { role: "user", content: "saved", timestamp: 1 },
	},
	{
		type: "message",
		id: "entry",
		parentId: 7,
		timestamp: "2026-10-15T00:00:00Z",
		message: { role: "user", content: "saved", timestamp: 1 },
	},
	{ type: "message", id: "entry", parentId: null, timestamp: "2026-10-15T00:00:00Z", message: null },
	{ type: "invalid", id: "entry", parentId: null, timestamp: "2026-10-15T00:00:00Z" },
	null,
]) {
	it(`rejects a structurally invalid format-4 entry ${JSON.stringify(entry)}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "session-structure-"));
		try {
			const path = join(directory, "invalid.jsonl");
			const header = {
				type: "session",
				version: 4,
				id: "invalid",
				createdAt: "2026-10-15T00:00:00Z",
				cwd: directory,
			};
			const content = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
			const entries = JSON.parse(JSON.stringify([header, entry])) as FileEntry[];
			await writeFile(path, content);
			await assert.rejects(async () => await SessionManager.open(path), SessionFormatVersionError);
			assert.throws(() => SessionManager.inMemory(directory, undefined, entries), SessionFormatVersionError);
			await assert.rejects(
				async () => await SessionManager.forkFrom(path, directory, directory),
				SessionFormatVersionError,
			);
			await assert.rejects(SessionManager.forkFrom(path, directory, directory), SessionFormatVersionError);
			assert.deepEqual(await SessionManager.list(directory, directory), []);
			assert.deepEqual(await SessionManager.listAll(directory), []);
			assert.notEqual((await SessionManager.continueRecent(directory, directory)).getSessionId(), "invalid");
			const selected = await SessionManager.findById(directory, "invalid", directory);
			assert.equal(selected, path);
			assert.ok(selected);
			await assert.rejects(async () => await SessionManager.open(selected), SessionFormatVersionError);
			assert.equal(await readFile(path, "utf8"), content);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

it("writes format 4 and retains context on file, memory, fork and resume loads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "session-current-"));
	try {
		const session = await SessionManager.create(directory, directory);
		const message = { role: "user" as const, content: "saved context", timestamp: 1 };
		await session.appendMessage(message);
		const path = session.getSessionFile();
		assert.ok(path);
		assert.equal(session.getHeader()?.version, 4);
		const entries = JSON.parse(`[${(await readFile(path, "utf8")).trim().split("\n").join(",")}]`) as FileEntry[];
		const loaded = [
			await SessionManager.open(path),
			SessionManager.inMemory(directory, undefined, entries),
			await SessionManager.forkFrom(path, directory, directory),
			await SessionManager.forkFrom(path, directory, directory),
			await SessionManager.continueRecent(directory, directory),
		];
		for (const manager of loaded) assert.deepEqual(manager.buildSessionContext().messages, [message]);
		assert.equal((await SessionManager.list(directory, directory)).length, 3);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("rejects a torn final record on file and fork loads and omits it from discovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "session-torn-"));
	try {
		const path = join(directory, "torn.jsonl");
		const content = `${JSON.stringify({ type: "session", version: 4, id: "torn", createdAt: "2026-10-15T00:00:00Z", cwd: directory })}\n{"type":`;
		await writeFile(path, content);
		await assert.rejects(async () => await SessionManager.open(path), StorageUnavailableError);
		await assert.rejects(
			async () => await SessionManager.forkFrom(path, directory, directory),
			StorageUnavailableError,
		);
		await assert.rejects(SessionManager.forkFrom(path, directory, directory), StorageUnavailableError);
		assert.deepEqual(await SessionManager.list(directory, directory), []);
		assert.equal(await readFile(path, "utf8"), content);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
