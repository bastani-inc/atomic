/**
 * A long session resumes from the window after its last compaction. The records of the MCP tools it declared are
 * kept with the branch, like other extension state, so the resumed session still has them however old they are.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { SESSION_HISTORY_PAGE_BYTES, type SessionStore } from "../src/core/storage/session/types.js";
import { MCP_TOOL_RECORD_ENTRY_TYPE, readToolRecords } from "../src/extensions/mcp/tool-records.ts";

const closers: (() => Promise<void>)[] = [];
const directories: string[] = [];
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

async function openStore(kind: "memory" | "sqlite"): Promise<SessionStore> {
	if (kind === "memory") {
		const store = new MemorySessionStore();
		closers.push(() => store.close());
		return store;
	}
	const directory = mkdtempSync(join(tmpdir(), "atomic-mcp-records-window-"));
	directories.push(directory);
	const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const SESSION = "01a1f50b-074b-7715-aa80-f62a14fe3a0b";
const createdAt = "2026-11-20T00:00:00.000Z";
const at = (index: number) => new Date(Date.parse(createdAt) + index * 1000).toISOString();

const SEARCH = {
	name: "search",
	description: "Search the docs.",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

function message(id: string, parentId: string | null, index: number, body: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at(index),
		message: { ...body, timestamp: index },
	} as SessionEntry;
}

function assistant(id: string, parentId: string, index: number, size = 16): SessionEntry {
	return message(id, parentId, index, {
		role: "assistant",
		content: [{ type: "text", text: `answer ${index} ${"x".repeat(size)}` }],
		api: "anthropic-messages",
		provider: "test",
		model: "model",
		usage: {
			input: 4,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	});
}

describe.each(["memory", "sqlite"] as const)("a %s store", (kind) => {
	test("keeps a resumed long session's MCP tool records when it loads only the window after a compaction", async () => {
		const store = await openStore(kind);
		const declared = {
			name: "mcp__docs__search",
			description: "Search the docs.",
			parameters: SEARCH.inputSchema,
		};
		const record = { name: "mcp__docs__search", server: "docs", transport: "0123456789abcdef", tool: SEARCH };
		const entries: SessionEntry[] = [
			message("s0", null, 0, { role: "system", content: "You are helpful.", toolsAdded: [declared] }),
			{
				type: "custom",
				id: "r0",
				parentId: "s0",
				timestamp: at(1),
				customType: MCP_TOOL_RECORD_ENTRY_TYPE,
				data: { tools: [record] },
			} as SessionEntry,
			message("u0", "r0", 2, { role: "user", content: "first question" }),
			assistant("a0", "u0", 3, SESSION_HISTORY_PAGE_BYTES + 17),
			message("u1", "a0", 4, { role: "user", content: "second question" }),
			assistant("a1", "u1", 5),
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				timestamp: at(6),
				summary: "compacted",
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				details: { strategy: "verbatim-lines" },
			} as SessionEntry,
			message("u2", "c1", 7, { role: "user", content: "after question" }),
			assistant("a2", "u2", 8),
		];
		await store.create({ id: SESSION, version: 4, createdAt, cwd: "/project" }, entries);

		const manager = await SessionManager.open(store, SESSION);
		assert.equal(manager.hasFullHistory(), false, "the resumed session holds only its window");
		assert.deepEqual([...readToolRecords(manager.getBranch()).tools.values()], [record]);
	});
});
