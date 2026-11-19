import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION, type SessionRecordHeader } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { HISTORY_TEXT_FORMAT } from "../src/core/tools/history-session.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/index-prefilter");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT };
}

function message(id: string, text: string, at: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	};
}

const request = (pattern: string): InternalSearchRequest => ({
	pattern,
	ignoreCase: false,
	literal: false,
	contextBefore: 0,
	contextAfter: 0,
});

const cases: readonly { readonly name: string; readonly pattern: string; readonly text: string }[] = [
	{ name: "word boundaries written \\< and \\>", pattern: "\\<foo\\>", text: "xx foo yy" },
	{ name: "an eight-digit \\U escape", pattern: "\\U00000061bc", text: "see abc here" },
	{ name: "a repetition stacked on an optional item", pattern: "a?{2}bcd", text: "xx bcd yy" },
	{ name: "a repetition stacked on a counted repetition", pattern: "[a-z]{2}{2}xyz", text: "the abcdxyz end" },
	{ name: "\\p followed by a character class", pattern: "A\\p[a-z]", text: "see Apq here" },
	{ name: "\\c followed by a repetition", pattern: "zz\\c{0,2}yy", text: "a zz\\yy b" },
	{
		name: "a repetition bound longer than two dozen digits",
		pattern: "xyz{0,99999999999999999999999999}abc",
		text: "before xyabc after",
	},
];

describe("indexed history searches find what an unindexed scan finds (#5250)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "history-index-prefilter-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	for (const { name, pattern, text } of cases) {
		it(`returns the same matches before and after indexing a session: ${name} (#5250)`, async () => {
			const database = await openNodeSqliteDatabase(join(dir, "history.sqlite"));
			const store = await SqlSessionStore.open(database);
			try {
				await store.create(header("p"), [message("e1", text, BASE), message("e2", "another entry", BASE + 1000)]);
				const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
				const scanned = (await router.search?.("history://sessions/p", request(pattern))) ?? "";
				assert.match(scanned, /history:\/\/sessions\/p:1: /);
				assert.equal((await store.searchIndex?.coverage("p", HISTORY_TEXT_FORMAT))?.indexedSeq, 2);
				assert.equal((await router.search?.("history://sessions/p", request(pattern))) ?? "", scanned);
			} finally {
				await store.close();
				await database.close();
			}
		});
	}
});
