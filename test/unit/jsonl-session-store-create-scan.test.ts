import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { SessionExistsError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fs, open: vi.fn(fs.open) };
});

const directories: string[] = [];
afterEach(async () => {
	vi.clearAllMocks();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function directory(): Promise<string> {
	const created = await mkdtemp(join(tmpdir(), "jsonl-create-scan-"));
	directories.push(created);
	return created;
}

function header(id: string, createdAt = "2026-11-15T00:00:00.000Z") {
	return { id, version: SESSION_FORMAT_VERSION, createdAt, cwd: "/project" } as const;
}

/** The files `create` opened, by name, other than the one it wrote. */
function openedNames(): string[] {
	return vi
		.mocked(open)
		.mock.calls.map(([path]) => basename(String(path)))
		.filter((name) => name.endsWith(".jsonl"));
}

/** A session file as a session manager names it: its creation time, then its id. */
async function managerNamedSession(root: string, id: string): Promise<void> {
	const line = JSON.stringify({ type: "session", ...header(id) });
	await writeFile(join(root, `2026-11-15T00-00-00-000Z_${id}.jsonl`), `${line}\n`);
}

describe("creating a session in a directory of many (#5186)", () => {
	it("reads none of the files named for other sessions (#5186)", async () => {
		const root = await directory();
		const store = await JsonlSessionStore.open(root, { exactDirectory: true, scanExisting: false });
		try {
			for (let index = 0; index < 40; index++) await store.create(header(`stored-${index}`), []);
			for (let index = 0; index < 40; index++) await managerNamedSession(root, `managed-${index}`);
			vi.mocked(open).mockClear();

			await store.create(header("fresh"), []);

			assert.deepEqual(openedNames(), [], "a new session reads no other session's file");
		} finally {
			await store.close();
		}
	});

	it("still refuses an id a file named for it holds, by either naming (#5186)", async () => {
		const root = await directory();
		const store = await JsonlSessionStore.open(root, { exactDirectory: true, scanExisting: false });
		try {
			await store.create(header("stored"), []);
			await managerNamedSession(root, "managed");
			const reopened = await JsonlSessionStore.open(root, { exactDirectory: true, scanExisting: false });
			try {
				await assert.rejects(reopened.create(header("stored", "2026-11-16T00:00:00.000Z"), []), SessionExistsError);
				await assert.rejects(reopened.create(header("managed"), []), SessionExistsError);
			} finally {
				await reopened.close();
			}
		} finally {
			await store.close();
		}
	});

	it("still reads a file whose name says nothing of its session, and refuses the id it holds (#5186)", async () => {
		const root = await directory();
		await writeFile(join(root, "imported.jsonl"), `${JSON.stringify({ type: "session", ...header("imported") })}\n`);
		const store = await JsonlSessionStore.open(root, { exactDirectory: true, scanExisting: false });
		try {
			vi.mocked(open).mockClear();
			await assert.rejects(store.create(header("imported"), []), SessionExistsError);
			assert.ok(openedNames().includes("imported.jsonl"), "the unnamed file was read");
		} finally {
			await store.close();
		}
	});
});
