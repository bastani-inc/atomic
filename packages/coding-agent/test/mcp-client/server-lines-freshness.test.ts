import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { CompactionEntry, SessionEntry } from "../../src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.ts";
import {
	MCP_TOOL_RECORD_ENTRY_TYPE,
	type McpServerLineRecord,
	type McpToolRecordData,
	readToolRecords,
} from "../../src/extensions/mcp/tool-records.ts";

const stamp = "2026-11-21T00:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const user = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp,
	message: { role: "user", content: id, timestamp: 1 },
});

const lines = (servers: string[]): McpServerLineRecord[] =>
	servers.map((server) => ({ server, line: `- mcp__a_b_c (codemode): ${server}` }));

const linesRecord = (id: string, parentId: string, servers: string[]): SessionEntry => ({
	type: "custom",
	id,
	parentId,
	timestamp: stamp,
	customType: MCP_TOOL_RECORD_ENTRY_TYPE,
	data: { tools: [], serverLines: lines(servers) } satisfies McpToolRecordData,
});

const compaction = (id: string, parentId: string): CompactionEntry => ({
	type: "compaction",
	id,
	parentId,
	timestamp: stamp,
	summary: "summary",
	tokensBefore: 100,
	firstKeptEntryId: null,
	details: { strategy: "verbatim-lines", backend: "summary" },
});

/** A session in the default SQLite store, opened with its full history and with only the tail since its compaction. */
async function openBoth(entries: SessionEntry[]) {
	const dir = await mkdtemp(join(tmpdir(), "mcp-server-lines-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
	const db = await openNodeSqliteDatabase(join(dir, "s.sqlite"));
	cleanups.push(() => db.close());
	const store = await SqlSessionStore.open(db);
	cleanups.push(() => store.close());
	await store.create({ id: "session", version: 4, createdAt: stamp, cwd: "/project" }, entries);
	return Promise.all(
		(["full", "tail"] as const).map(
			async (history) =>
				(await SessionManager.open(store, "session", undefined, { history })).getBranch() as SessionEntry[],
		),
	);
}

it("does not trust the record of a shared namespace's lines that a compaction followed, also when a resume reads only the tail", async () => {
	// The record of the first request's lines, then a request whose own record was not written, then a compaction.
	const branches = await openBoth([
		user("first", null),
		linesRecord("lines", "first", ["a_b_c", "a_b-c"]),
		user("second", "lines"),
		compaction("cut", "second"),
	]);
	for (const branch of branches) expect(readToolRecords(branch).serverLines).toBeUndefined();
});

it("trusts the record of a shared namespace's lines written after a compaction", async () => {
	const branches = await openBoth([
		user("first", null),
		linesRecord("lines", "first", ["a_b_c", "a_b-c"]),
		user("second", "lines"),
		compaction("cut", "second"),
		user("third", "cut"),
		linesRecord("later", "third", ["a_b-c", "a-b_c"]),
	]);
	for (const branch of branches) expect(readToolRecords(branch).serverLines).toEqual(lines(["a_b-c", "a-b_c"]));
});
