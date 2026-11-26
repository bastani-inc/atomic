import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const CREATED_AT = "2026-11-25T00:00:00.000Z";
const header = { id: "kept", version: 4 as const, createdAt: CREATED_AT, cwd: "/project" };
function message(id: string, text = `text of ${id}`): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: CREATED_AT,
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

/** The handles the store opens while `work` runs, by the flags they were opened with. */
async function openedHandles<T>(work: () => Promise<T>) {
	const opened: { flags: unknown; handle: fs.FileHandle }[] = [];
	const originalOpen = fs.open;
	const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await originalOpen(...args);
		opened.push({ flags: args[1], handle });
		return handle;
	});
	try {
		return { result: await work(), opened };
	} finally {
		spy.mockRestore();
	}
}

/** The bytes every `FileHandle` reads while `work` runs. */
async function bytesRead<T>(work: () => Promise<T>): Promise<{ result: T; bytes: number }> {
	const probe = await fs.open(fileURLToPath(import.meta.url), "r");
	const prototype = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
	await probe.close();
	const read = prototype.read;
	let bytes = 0;
	prototype.read = async function (this: unknown, ...args: unknown[]) {
		const result = await read.apply(this, args);
		bytes += result.bytesRead;
		return result;
	};
	try {
		return { result: await work(), bytes };
	} finally {
		prototype.read = read;
	}
}

const isAppendHandle = (flags: unknown) => typeof flags === "number" && (flags & fs.constants.O_APPEND) !== 0;

describe("JSONL session store kept append handles (#6560)", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "jsonl-kept-handle-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"opens a session file to append once while it is written, and again after its session is released",
		async () => {
			const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				await store.create(header, []);
				const { opened } = await openedHandles(async () => {
					for (let seq = 0; seq < 5; seq++)
						await store.append(header.id, [message(`e${seq}`)], { expectSeq: seq });
				});
				assert.equal(opened.filter(({ flags }) => isAppendHandle(flags)).length, 1);
				const kept = opened.find(({ flags }) => isAppendHandle(flags))!.handle;
				await store.releaseSession(header.id);
				assert.equal(kept.fd, -1, "releasing the session closes its handle");
				const again = await openedHandles(() => store.append(header.id, [message("e5")], { expectSeq: 5 }));
				assert.equal(again.opened.filter(({ flags }) => isAppendHandle(flags)).length, 1);
				await store.close();
				assert.equal(again.opened.find(({ flags }) => isAppendHandle(flags))!.handle.fd, -1, "close closes it");
			} finally {
				await store.close().catch(() => undefined);
			}
		},
	);

	it("commits appends made together in the order made, failing alone one that cannot be saved", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header, []);
			const unsaveable = { ...message("bigint"), details: { size: 1n } } as unknown as SessionEntry;
			const attempts = await Promise.allSettled([
				store.append(header.id, [message("a")], { expectSeq: 0 }),
				store.append(header.id, [unsaveable], { expectSeq: 1 }),
				store.append(header.id, [message("b")], { expectSeq: 1 }),
				store.append(header.id, [message("c"), message("d")], { expectSeq: 2 }),
			]);
			assert.deepEqual(
				attempts.map((attempt) => (attempt.status === "fulfilled" ? attempt.value.lastSeq : "rejected")),
				[1, "rejected", 2, 4],
			);
			assert.deepEqual(
				(await store.load(header.id)).entries.map((entry) => entry.id),
				["a", "b", "c", "d"],
			);
		} finally {
			await store.close();
		}
	});

	it("never appends through a kept handle to a file another writer replaced", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const other = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await store.create(header, []);
			await store.append(header.id, [message("a")], { expectSeq: 0 });
			await other.replace(header.id, header, [message("replaced")], { expectSeq: 1 });
			const path = (await store.findFile(header.id))!;
			const replaced = await readFile(path, "utf8");
			await assert.rejects(store.append(header.id, [message("b")], { expectSeq: 1 }), SessionConflictError);
			assert.equal(await readFile(path, "utf8"), replaced, "the replaced file is not written to");
			assert.deepEqual((await store.load(header.id)).entries, [message("replaced")]);
			await store.append(header.id, [message("c")], { expectSeq: 1 });
			assert.deepEqual((await other.load(header.id)).entries, [message("replaced"), message("c")]);
		} finally {
			await store.close();
			await other.close();
		}
	});

	it("appends after another process's appends and its torn last line through the handle it kept", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header, []);
			await store.append(header.id, [message("a")], { expectSeq: 0 });
			const path = (await store.findFile(header.id))!;
			// Another writer appended a line, then died partway through the next one.
			await fs.appendFile(
				path,
				`${JSON.stringify(message("foreign"))}\n${JSON.stringify(message("torn")).slice(0, 25)}`,
			);
			assert.deepEqual(await store.append(header.id, [message("b")], { expectSeq: 2 }), { lastSeq: 3 });
			const lines = (await readFile(path, "utf8")).split("\n");
			assert.deepEqual(
				lines.slice(1).map((line) => (line ? (JSON.parse(line) as SessionEntry).id : line)),
				["a", "foreign", "b", ""],
			);
		} finally {
			await store.close();
		}
	});

	it("reads a long session's last entries from its end, as a whole read numbers them", async () => {
		const entries = Array.from({ length: 3000 }, (_, index) => message(`e${index}`, "x".repeat(200)));
		const lines = entries.map((entry) => JSON.stringify(entry));
		// Lines of whitespace are not entries, wherever they are.
		lines.splice(2990, 0, "   ", "");
		lines.splice(10, 0, "\t");
		const content = `${JSON.stringify({ type: "session", ...header })}\n${lines.join("\n")}\n`;
		const path = join(directory, "2026-11-25T00-00-00-000Z_kept.jsonl");
		await writeFile(path, content);
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const cold = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			const query = { fromSeq: 2985, toSeq: 3000 };
			const { result: fromEnd, bytes } = await bytesRead(() => store.readEntryRange(header.id, query));
			const { result: whole, bytes: wholeBytes } = await bytesRead(() => cold.readFileEntryRange(path, query));
			assert.deepEqual(fromEnd, whole);
			assert.deepEqual(
				fromEnd.entries.map(({ seq, entry }) => [seq, entry.id]),
				entries.slice(2984).map((entry, index) => [2985 + index, entry.id]),
			);
			// The forward read reads the whole file; from the end, its header and one chunk before the entries.
			assert.ok(wholeBytes >= (await stat(path)).size, `${wholeBytes} bytes read forward`);
			assert.ok(bytes < wholeBytes / 4, `${bytes} bytes read from the end`);
		} finally {
			await store.close();
			await cold.close();
		}
	});

	it("reads forward when a line near the end holds only characters it must decode to call blank", async () => {
		const entries = Array.from({ length: 600 }, (_, index) => message(`e${index}`));
		const lines = entries.map((entry) => JSON.stringify(entry));
		lines.splice(595, 0, "\u3000\u2028");
		const path = join(directory, "2026-11-25T00-00-00-000Z_kept.jsonl");
		await writeFile(path, `${JSON.stringify({ type: "session", ...header })}\n${lines.join("\n")}\n`);
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const cold = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			const query = { fromSeq: 590, toSeq: 600 };
			const fromEnd = await store.readEntryRange(header.id, query);
			assert.deepEqual(fromEnd, await cold.readFileEntryRange(path, query));
			assert.deepEqual(
				fromEnd.entries.map(({ entry }) => entry.id),
				entries.slice(589).map((entry) => entry.id),
			);
		} finally {
			await store.close();
			await cold.close();
		}
	});
});
