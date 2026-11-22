import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import { afterEach, describe, it } from "vitest";
import { type FileEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SessionFormatVersionError } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function directory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(path, { recursive: true, force: true }));
	return path;
}

const SESSION_ID = "saved-extension-fields";
const header = (cwd: string) => ({ id: SESSION_ID, version: 4 as const, createdAt: "2026-11-01T00:00:00Z", cwd });
const question: SessionEntry = {
	type: "message",
	id: "u1",
	parentId: null,
	timestamp: "2026-11-01T00:00:01Z",
	message: { role: "user", content: "find release notes", timestamp: 1 },
};
const base = { id: "e1", parentId: "u1", timestamp: "2026-11-01T00:00:02Z" };
const notice = (fields: Record<string, unknown>) =>
	({
		type: "custom_message",
		...base,
		customType: "curator-config",
		content: [{ type: "text", text: "Curator enabled" }],
		details: {},
		...fields,
	}) as unknown as SessionEntry;
const without = (entry: SessionEntry, key: string) =>
	Object.fromEntries(Object.entries(entry).filter(([name]) => name !== key)) as unknown as SessionEntry;

/** How the reopened session reads the saved entry `e1`. */
function readBack(manager: SessionManager): unknown {
	const entry = manager.getEntry("e1");
	switch (entry?.type) {
		case "custom_message":
			return { customType: entry.customType, content: entry.content, display: entry.display };
		case "custom":
			return { customType: entry.customType, data: entry.data };
		case "label":
			return { label: manager.getLabel("u1") };
		default:
			return entry;
	}
}

/** Every shape releases before 0.10.2 let an extension store, and how the chat reads it now. */
const SAVED_SHAPES: Array<{ label: string; entry: SessionEntry; read: unknown }> = [
	{
		label: 'a custom message display of "tool"',
		entry: notice({ display: "tool" }),
		read: { customType: "curator-config", content: [{ type: "text", text: "Curator enabled" }], display: true },
	},
	{
		label: "a custom message without display",
		entry: without(notice({}), "display"),
		read: { customType: "curator-config", content: [{ type: "text", text: "Curator enabled" }], display: false },
	},
	{
		label: "a custom message display of 1",
		entry: notice({ display: 1 }),
		read: { customType: "curator-config", content: [{ type: "text", text: "Curator enabled" }], display: true },
	},
	{
		label: "a custom message without content",
		entry: without(notice({ display: true }), "content"),
		read: { customType: "curator-config", content: [], display: true },
	},
	{
		label: "a custom message whose content is an object",
		entry: notice({ display: true, content: { text: "Curator enabled" } }),
		read: { customType: "curator-config", content: [], display: false },
	},
	{
		label: "a custom message whose customType is a number",
		entry: notice({ display: true, customType: 7 }),
		read: { customType: "", content: [{ type: "text", text: "Curator enabled" }], display: true },
	},
	{
		label: "a custom entry without customType",
		entry: { type: "custom", ...base, data: { saved: true } } as unknown as SessionEntry,
		read: { customType: "", data: { saved: true } },
	},
	{
		label: "a label that is a number",
		entry: { type: "label", ...base, targetId: "u1", label: 7 } as unknown as SessionEntry,
		read: { label: undefined },
	},
];

describe("sessions saved with extension fields of any shape (#6097)", () => {
	for (const shape of SAVED_SHAPES) {
		it(`opens a JSONL session with ${shape.label} and leaves the file as it was (#6097)`, async () => {
			const dir = await directory("saved-shape-jsonl-");
			const path = join(dir, "saved.jsonl");
			const lines = [{ type: "session", ...header(dir) }, question, shape.entry];
			const content = `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
			await writeFile(path, content);

			const opened = await SessionManager.open(path);
			assert.deepEqual(readBack(opened), shape.read);
			assert.deepEqual(readBack(await opened.inMemoryBranch(dir)), shape.read);
			const seeded = await SessionManager.inMemory(dir, undefined, JSON.parse(JSON.stringify(lines)) as FileEntry[]);
			assert.deepEqual(readBack(seeded), shape.read);
			assert.deepEqual(readBack(await SessionManager.forkFrom(path, dir, dir)), shape.read);
			assert.ok((await SessionManager.list(dir, dir)).some((session) => session.id === SESSION_ID));
			assert.equal(await readFile(path, "utf8"), content);

			await opened.appendMessage({ role: "user", content: "next", timestamp: 2 });
			assert.ok((await readFile(path, "utf8")).startsWith(content));
		});

		it(`opens a SQLite session with ${shape.label} and leaves the rows as they were (#6097)`, async () => {
			const dir = await directory("saved-shape-sqlite-");
			const database = await openNodeSqliteDatabase(join(dir, "sessions.db"));
			const store = await SqlSessionStore.open(database);
			cleanups.push(async () => {
				await store.close();
				await database.close();
			});
			await store.create(header(dir), [question, shape.entry]);
			const rows = async () =>
				(
					await database.all<{ entry_json: string }>(
						"SELECT entry_json FROM session_entries WHERE session_id = ? ORDER BY seq",
						SESSION_ID,
					)
				).map((row) => row.entry_json);
			const before = await rows();

			const opened = await SessionManager.open(store, SESSION_ID);
			assert.deepEqual(readBack(opened), shape.read);
			assert.deepEqual(readBack(await opened.inMemoryBranch(dir)), shape.read);
			await opened.appendMessage({ role: "user", content: "next", timestamp: 2 });
			assert.deepEqual((await rows()).slice(0, before.length), before);
		});
	}

	for (const [label, display, visible] of [
		["null", { display: null }, false],
		['""', { display: "" }, false],
		["0", { display: 0 }, false],
	] as const) {
		it(`reads a custom message display of ${label} as hidden, as the chat always did (#6097)`, async () => {
			const dir = await directory("saved-display-");
			const entries = [{ type: "session", ...header(dir) }, question, notice(display)] as FileEntry[];
			const manager = await SessionManager.inMemory(dir, undefined, entries);
			assert.deepEqual(readBack(manager), {
				customType: "curator-config",
				content: [{ type: "text", text: "Curator enabled" }],
				display: visible,
			});
		});
	}

	for (const [label, entry] of [
		["a message whose content is a number", { ...question, message: { role: "user", content: 7, timestamp: 1 } }],
		["a label whose target is a number", { type: "label", ...base, targetId: 7, label: "kept" }],
		["a custom message whose id is a number", { ...notice({ display: "tool" }), id: 7 }],
	] as const) {
		it(`still rejects ${label} (#6097)`, async () => {
			const dir = await directory("saved-strict-");
			const path = join(dir, "invalid.jsonl");
			const lines = [{ type: "session", ...header(dir) }, question, entry];
			const content = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
			await writeFile(path, content);
			await assert.rejects(async () => await SessionManager.open(path), SessionFormatVersionError);
			await assert.rejects(
				SessionManager.inMemory(dir, undefined, JSON.parse(JSON.stringify(lines)) as FileEntry[]),
				SessionFormatVersionError,
			);
			assert.equal(await readFile(path, "utf8"), content);
		});
	}
});

type Stored = { type: string; customType?: unknown; display?: unknown; label?: unknown };

/** An extension's session on a real store, with a way to read what the store holds and to reopen it. */
async function extensionSession(storage: "jsonl" | "sqlite") {
	const dir = await directory(`extension-writes-${storage}-`);
	let reopen: () => Promise<SessionManager>;
	let stored: () => Promise<Stored[]>;
	let manager: SessionManager;
	if (storage === "jsonl") {
		manager = await SessionManager.create(dir, dir);
		reopen = () => SessionManager.open(manager.getSessionFile()!);
		stored = async () =>
			(await readFile(manager.getSessionFile()!, "utf8"))
				.trim()
				.split("\n")
				.slice(1)
				.map((line) => JSON.parse(line) as Stored);
	} else {
		const database = await openNodeSqliteDatabase(join(dir, "sessions.db"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await store.close();
			await database.close();
		});
		manager = await SessionManager.create(store, dir);
		reopen = () => SessionManager.open(store, manager.getSessionId());
		stored = async () =>
			(
				await database.all<{ entry_json: string }>(
					"SELECT entry_json FROM session_entries WHERE session_id = ? ORDER BY seq",
					manager.getSessionId(),
				)
			).map((row) => JSON.parse(row.entry_json) as Stored);
	}
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			(atomic: ExtensionAPI) => {
				api = atomic;
			},
		],
	});
	cleanups.push(async () => harness.cleanup());
	await harness.session.bindExtensions({});
	const userEntry = await manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
	assert.ok(api);
	return { pi: api, reopen, stored, userEntry };
}

const notices = (entries: Stored[]) =>
	entries
		.filter((entry) => entry.type === "custom_message" || entry.type === "custom" || entry.type === "label")
		.map((entry) => [entry.type, entry.customType ?? entry.label, entry.display]);

for (const storage of ["jsonl", "sqlite"] as const) {
	describe(`an extension writing to a ${storage === "jsonl" ? "JSONL" : "SQLite"} session (#6097)`, () => {
		it("stores display as a boolean, as the chat reads it (#6097)", async () => {
			const { pi: atomic, reopen, stored } = await extensionSession(storage);
			const send = atomic.sendMessage as (message: object) => Promise<void>;
			await send({ customType: "tool-display", content: "shown", display: "tool" });
			await send({ customType: "one-display", content: "shown", display: 1 });
			await send({ customType: "no-display", content: "hidden" });
			await (atomic.sendMessages as (messages: object[]) => Promise<void>)([
				{ customType: "batch-display", content: "shown", display: "tool" },
			]);
			const expected = [
				["custom_message", "tool-display", true],
				["custom_message", "one-display", true],
				["custom_message", "no-display", false],
				["custom_message", "batch-display", true],
			];
			assert.deepEqual(notices(await stored()), expected);
			assert.deepEqual(notices((await reopen()).getEntries() as Stored[]), expected);
		});

		it("rejects what the session could not read back, at the call, and stores nothing (#6097)", async () => {
			const { pi: atomic, reopen, stored, userEntry } = await extensionSession(storage);
			const before = await stored();
			const calls: Array<[string, () => unknown]> = [
				[
					"content that is an object",
					() =>
						(atomic.sendMessage as (message: object) => unknown)({ customType: "x", content: {}, display: true }),
				],
				[
					"a customType that is a number",
					() =>
						(atomic.sendMessage as (message: object) => unknown)({ customType: 7, content: "x", display: true }),
				],
				[
					"a batch with one bad message",
					() =>
						(atomic.sendMessages as (messages: object[]) => unknown)([
							{ customType: "fine", content: "x", display: true },
							{ customType: "x", content: 7, display: true },
						]),
				],
				["an entry without customType", () => (atomic.appendEntry as (type?: string) => unknown)(undefined)],
				[
					"a label that is a number",
					() => (atomic.setLabel as (id: string, label: unknown) => unknown)(userEntry, 7),
				],
			];
			for (const [label, call] of calls)
				await assert.rejects(
					async () => await call(),
					(error: Error) => error instanceof TypeError,
					`${label} is rejected`,
				);
			assert.deepEqual(await stored(), before);
			assert.deepEqual(notices((await reopen()).getEntries() as Stored[]), []);
		});
	});
}
