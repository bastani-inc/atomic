import assert from "node:assert/strict";
import { appendFile, type FileHandle, mkdtemp, open, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.ts";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.ts";

const stamp = new Date(0).toISOString();
const MiB = 1024 * 1024;
const header = { type: "session", version: 4, id: "cold", createdAt: stamp, cwd: "/tmp" };
const usage = {
	input: 3,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};
const user = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp,
	message: { role: "user", timestamp: 0, content: text },
});
const custom = (id: string, parentId: string | null) => ({
	type: "custom",
	id,
	parentId,
	timestamp: stamp,
	customType: "note",
	data: {},
});
/** Every earlier entry leaves the window; only the compaction is read on open. */
const compaction = (parentId: string) => ({
	type: "compaction",
	id: "c",
	parentId,
	timestamp: stamp,
	summary: "C",
	firstKeptEntryId: null,
	tokensBefore: 100,
	details: { strategy: "verbatim-lines" },
});

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function sessionFile(lines: readonly (string | object)[]) {
	const dir = await mkdtemp(join(tmpdir(), "atomic-cold-index-"));
	directories.push(dir);
	const file = join(dir, "session.jsonl");
	await writeFile(
		file,
		`${[header, ...lines].map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
	);
	return { dir, file };
}
function causes(error: unknown): string[] {
	const names: string[] = [];
	for (let cause = error; cause instanceof Error; cause = cause.cause) names.push(cause.name);
	return names;
}
/** Count the JSON.parse calls whose text matches. */
function countParses(match: (text: string) => boolean) {
	const parse = JSON.parse;
	const counted = { calls: 0 };
	vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
		if (match(String(text))) counted.calls++;
		return parse(text, reviver);
	});
	return counted;
}

describe("cold JSONL index (#5554)", () => {
	it.each([7, true, { old: true }])(
		"does not interpret legacy non-string admission metadata (%j) as a key",
		async (stageAdmissionKey) => {
			const { file } = await sessionFile([
				{
					type: "custom_message",
					id: "notice",
					parentId: null,
					timestamp: stamp,
					customType: "unknown-extension",
					content: "visible",
					display: true,
					stageAdmissionKey,
				},
			]);
			const manager = await SessionManager.open(file);
			try {
				assert.equal(manager.getLeafId(), "notice");
				assert.equal(manager.getAdmissionKeys().has(String(stageAdmissionKey)), false);
			} finally {
				await manager.getSessionStore().close();
			}
		},
	);
	it.each([
		{
			first: "an entry of invalid structure",
			later: "a malformed line",
			lines: [{ ...custom("a", null), parentId: 5 }, custom("b", "a"), "{oops"],
			reported: "SyntaxError",
		},
		{
			first: "an entry with an invalid timestamp",
			later: "an entry of invalid structure",
			lines: [
				{ ...custom("a", null), timestamp: "yesterday" },
				custom("b", "a"),
				{ ...custom("c", "b"), parentId: 5 },
			],
			reported: "SessionFormatVersionError",
		},
	])("reports $later after $first, as a whole-file load does", async ({ lines, reported }) => {
		const { file } = await sessionFile(lines);
		await assert.rejects(SessionManager.open(file), (error) => causes(error).includes(reported));
	});

	it("counts an oversized retired row by its last duplicate key, as JSON.parse reads it", async () => {
		const row = JSON.stringify(user("u", null, `retired ${"x".repeat(2 * MiB)}`));
		const { file } = await sessionFile([`{"type":"custom",${row.slice(1)}`, compaction("u")]);
		const manager = await SessionManager.open(file);
		try {
			assert.equal(manager.getEntry("u"), undefined);
			assert.equal(manager.getOmittedHistoryTotals()?.userMessages, 1);
			assert.equal(manager.getOmittedHistoryTotals()?.totalMessages, 1);
		} finally {
			await manager.getSessionStore().close();
		}
	});

	it("indexes a large append by another writer from the cached end, without reading the indexed lines again", async () => {
		const prefix = Array.from({ length: 200 }, (_, i) => custom(`p${i}`, i ? `p${i - 1}` : null));
		const { dir, file } = await sessionFile(prefix);
		const open = () => JsonlSessionStore.open(dir, { exactDirectory: true, scanExisting: false });
		const first = await open();
		assert.equal(await first.findEntrySeq("cold", "p199"), 200);
		await first.close();
		const appended = Array.from({ length: 150 }, (_, i) =>
			JSON.stringify(user(`s${i}`, i ? `s${i - 1}` : "p199", "s".repeat(10 * 1024))),
		);
		await appendFile(file, `${appended.join("\n")}\n`);
		const indexed = countParses((text) => text.includes('"customType":"note"'));
		const reopened = await open();
		try {
			assert.equal(await reopened.findEntrySeq("cold", "s149"), 350);
			assert.equal(await reopened.findEntrySeq("cold", "s0"), 201);
			assert.equal(indexed.calls, 0);
		} finally {
			await reopened.close();
		}
	});

	it("finds an oversized row by its ID without decoding its body", async () => {
		const { dir } = await sessionFile([
			custom("a", null),
			user("big", "a", `body ${"x".repeat(2 * MiB)}`),
			custom("b", "big"),
		]);
		const whole = countParses((text) => text.length > MiB);
		const store = await JsonlSessionStore.open(dir, { exactDirectory: true, scanExisting: false });
		try {
			assert.equal(await store.findEntrySeq("cold", "big"), 2);
			assert.equal(whole.calls, 0);
		} finally {
			await store.close();
		}
	});

	it("ignores an oversized torn last line without decoding it", async () => {
		const torn = JSON.stringify(user("t", "b", "x".repeat(2 * MiB))).slice(0, -3);
		const { file } = await sessionFile([custom("a", null), custom("b", "a")]);
		await appendFile(file, torn);
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const whole = countParses((text) => text.length > MiB);
		const manager = await SessionManager.open(file);
		try {
			assert.equal(manager.getLeafId(), "b");
			assert.equal(whole.calls, 0);
		} finally {
			await manager.getSessionStore().close();
		}
	});

	it("treats an oversized unfinished last line as torn when its writer removes it while it is read", async () => {
		const { file } = await sessionFile([custom("a", null), custom("b", "a")]);
		const complete = (await stat(file)).size;
		await appendFile(file, JSON.stringify(user("t", "b", "x".repeat(2 * MiB))).slice(0, -3));
		const probe = await open(file, "r");
		const handle = Object.getPrototypeOf(probe) as FileHandle;
		await probe.close();
		const read = handle.read;
		let removed = false;
		vi.spyOn(handle, "read").mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
			// Another store's next append removes the unfinished line while this one reads it.
			if (typeof args[3] === "number" && args[3] >= complete && !removed) {
				removed = true;
				await truncate(file, complete);
			}
			return (read as (...values: unknown[]) => ReturnType<FileHandle["read"]>).apply(this, args);
		} as FileHandle["read"]);
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const manager = await SessionManager.open(file);
		try {
			assert.equal(removed, true);
			assert.equal(manager.getLeafId(), "b");
		} finally {
			await manager.getSessionStore().close();
		}
	});
});

describe("dirty in-memory resume index (#5554)", () => {
	it("rebuilds a branched session's totals like a fresh fold, without decoding an oversized row", async () => {
		const assistant = {
			type: "message",
			id: "big",
			parentId: "a",
			timestamp: stamp,
			message: {
				role: "assistant",
				provider: "p",
				model: "m",
				usage,
				stopReason: "toolUse",
				timestamp: 1,
				content: [
					{ type: "text", text: "x".repeat(2 * MiB) },
					{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
					{ type: "toolCall", id: "t2", name: "bash", arguments: {} },
				],
			},
		};
		const reply = {
			...assistant,
			id: "reply",
			parentId: "big",
			message: { ...assistant.message, content: [{ type: "text", text: "done" }] },
		};
		const entries = [
			user("a", null, "first"),
			assistant,
			// The latest reply is read on resume; the oversized one before it only counts in the totals.
			reply,
			user("b", "reply", "second"),
			compaction("b"),
			user("d", "c", "third"),
			// A sibling of the last entry: the append's index must be folded again.
			user("branch", "c", "fourth"),
		] as never[];
		const { type: _type, ...record } = header;
		const fresh = new MemorySessionStore();
		await fresh.create(record, entries);
		const dirty = new MemorySessionStore();
		await dirty.create(record, entries.slice(0, -1));
		await dirty.append("cold", entries.slice(-1), { expectSeq: 6 });
		const whole = countParses((text) => text.length > MiB);
		const rebuilt = await dirty.readResume("cold");
		assert.equal(whole.calls, 0);
		const expected = await fresh.readResume("cold");
		assert.equal(rebuilt.omitted.toolCalls, 2);
		assert.deepEqual(rebuilt.omitted, expected.omitted);
		assert.equal(rebuilt.leafId, expected.leafId);
		await fresh.close();
		await dirty.close();
	});
});
