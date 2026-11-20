/**
 * An HTML export reads its session twice, a page at a time. Against a database server every store call is a round trip,
 * so the cost of a page decides the export's time: main's export reads the whole session in one transaction (#5571).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { exportSessionToHtml } from "../../packages/coding-agent/src/core/export-html/index.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_HISTORY_PAGE_BYTES } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { countingDatabase } from "../helpers/counting-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";

const header = { id: "session", version: 4 as const, createdAt: new Date(0).toISOString(), cwd: "/project" };

/** 20,000 alternating questions and answers of about 700 bytes each: some 14 MB, fourteen pages a pass. */
function conversation(): SessionEntry[] {
	return Array.from({ length: 20_000 }, (_, i): SessionEntry => {
		const base = { id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, timestamp: new Date(i * 1000).toISOString() };
		return i % 2 === 0
			? {
					...base,
					type: "message",
					message: { role: "user", content: `question ${i} ${"x".repeat(520)}`, timestamp: i },
				}
			: ({
					...base,
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `answer ${i} ${"y".repeat(600)}` }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						stopReason: "stop",
						timestamp: i,
					},
				} as SessionEntry);
	});
}

test("an HTML export of a long SQL-stored session reads each page in one statement, without a transaction or size read a page (#5571)", async () => {
	initTheme("dark");
	const directory = makeTempDirectory("export-round-trips-");
	try {
		await withNodeSqliteDatabase(async ({ database }) => {
			const counted = countingDatabase(database);
			const store = await SqlSessionStore.open(counted.wrapped);
			const entries = conversation();
			await store.create(header, entries);
			const manager = await SessionManager.open(store, "session");
			const bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
			const pages = Math.ceil(bytes / SESSION_HISTORY_PAGE_BYTES) + 1;
			counted.statements.length = 0;
			counted.counts.transactions = 0;

			// What /export and RPC export_html run: the renderer inputs pass, then the data pass.
			await exportSessionToHtml(manager, undefined, {
				outputPath: join(directory, "out.html"),
				toolRenderer: { renderCall: () => undefined, renderResult: () => undefined },
			});

			const rows = counted.statements.reduce((sum, statement) => sum + statement.rows, 0);
			const summary = `${counted.counts.transactions} transactions, ${counted.statements.length} statements, ${rows} rows`;
			// Main loads the session in one transaction; the export needs none, its capture is one statement too.
			assert.equal(counted.counts.transactions, 0, summary);
			// Each page of each pass is one statement, which also checks the generation it reads.
			assert.ok(counted.statements.length <= 2 * pages + 8, summary);
			// No size is read again for a later page: each entry is returned once a pass.
			assert.ok(rows <= 2 * entries.length + 2 * pages + 8, summary);
			// The renderer inputs pass is sent only entries that can hold a tool call or result, none here: a server sends
			// each stored byte once, as for main's single load.
			const sent = counted.statements.reduce((sum, statement) => sum + statement.bytes, 0);
			assert.ok(sent <= bytes * 1.05, `${summary}, ${sent} of ${bytes} bytes sent`);
			await store.close();
		});
	} finally {
		removeTempDirectory(directory);
	}
}, 120_000);

test("an HTML export streams an entry larger than a page a page's bytes a statement, without a transaction a chunk (#5571)", async () => {
	initTheme("dark");
	const directory = makeTempDirectory("export-round-trips-oversized-");
	try {
		await withNodeSqliteDatabase(async ({ database }) => {
			const counted = countingDatabase(database);
			const store = await SqlSessionStore.open(counted.wrapped);
			const output = "z".repeat(3 * SESSION_HISTORY_PAGE_BYTES);
			const at = new Date(0).toISOString();
			// An extension's tool result: the renderer inputs pass reads its exposed fields, the data pass streams it.
			const entries = [
				...conversation().slice(0, 200),
				{
					type: "message",
					id: "call",
					parentId: "e199",
					timestamp: at,
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "custom_tool", arguments: { path: "x" } }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						stopReason: "toolUse",
						timestamp: 200,
					},
				},
				{
					type: "message",
					id: "result",
					parentId: "call",
					timestamp: at,
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "custom_tool",
						content: [{ type: "text", text: output }],
						isError: false,
						timestamp: 201,
					},
				},
			] as SessionEntry[];
			await store.create(header, entries);
			const manager = await SessionManager.open(store, "session");
			counted.statements.length = 0;
			counted.counts.transactions = 0;

			const path = await exportSessionToHtml(manager, undefined, {
				outputPath: join(directory, "out.html"),
				toolRenderer: { renderCall: () => undefined, renderResult: () => undefined },
			});

			const chunks = counted.statements.filter(
				(statement) => /entry_chunks/.test(statement.sql) && statement.bytes > 0,
			);
			const summary = `${counted.counts.transactions} transactions, ${counted.statements.length} statements, ${chunks.length} chunk reads`;
			assert.ok(counted.counts.transactions <= 1, summary);
			// The entry is streamed a few times (its header, its exposed fields and their values, then the data), a page's
			// bytes a read, not one read and one transaction every SESSION_HISTORY_CHUNK_BYTES.
			const reads = Math.ceil(Buffer.byteLength(JSON.stringify(entries.at(-1))) / SESSION_HISTORY_PAGE_BYTES);
			assert.ok(chunks.length <= 6 * reads, summary);
			assert.ok(counted.statements.length <= chunks.length + 16, summary);
			const html = await readFile(path, "utf8");
			const encoded = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1];
			const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as { entries: SessionEntry[] };
			assert.deepEqual(data.entries.at(-1), entries.at(-1));
			await store.close();
		});
	} finally {
		removeTempDirectory(directory);
	}
}, 120_000);

test("an HTML export reads each oversized result from the store once, and only a prefix of a template tool's in its first pass (#5571)", async () => {
	initTheme("dark");
	const directory = makeTempDirectory("export-round-trips-once-");
	try {
		await withNodeSqliteDatabase(async ({ database }) => {
			const counted = countingDatabase(database);
			const store = await SqlSessionStore.open(counted.wrapped);
			const at = new Date(0).toISOString();
			const call = (id: string, name: string, parentId: string): SessionEntry =>
				({
					type: "message",
					id: `${id}-call`,
					parentId,
					timestamp: at,
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id, name, arguments: { path: "x" } }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						stopReason: "toolUse",
						timestamp: 1,
					},
				}) as unknown as SessionEntry;
			const result = (id: string, name: string, text: string): SessionEntry =>
				({
					type: "message",
					id,
					parentId: `${id}-call`,
					timestamp: at,
					message: {
						role: "toolResult",
						toolCallId: id,
						toolName: name,
						content: [{ type: "text", text }],
						details: { lines: 3 },
						isError: false,
						timestamp: 1,
					},
				}) as SessionEntry;
			// An extension's 3 MiB result, whose exposed fields the renderer inputs pass reads, and bash's 2 MiB result,
			// which that pass never uses.
			const extension = result("ext", "custom_tool", "x".repeat(3 * SESSION_HISTORY_PAGE_BYTES));
			const bash = result("sh", "bash", "y".repeat(2 * SESSION_HISTORY_PAGE_BYTES));
			const entries = [
				...conversation().slice(0, 50),
				call("ext", "custom_tool", "e49"),
				extension,
				call("sh", "bash", "ext"),
				bash,
			];
			await store.create(header, entries);
			const manager = await SessionManager.open(store, "session");
			counted.statements.length = 0;

			const path = await exportSessionToHtml(manager, undefined, {
				outputPath: join(directory, "out.html"),
				toolRenderer: { renderCall: () => "<b>call</b>", renderResult: () => ({ collapsed: "c", expanded: "e" }) },
			});

			const reads = (seq: number) =>
				counted.statements.filter(
					// A chunk read binds the entry's sequence just before the session's ID.
					(statement) =>
						/entry_chunks/.test(statement.sql) && statement.bytes > 0 && statement.params.at(-2) === seq,
				);
			const stored = (entry: SessionEntry) =>
				Math.ceil(Buffer.byteLength(JSON.stringify(entry)) / SESSION_HISTORY_PAGE_BYTES);
			// Each read also returns the session's generation and revision, under 128 bytes.
			const sent = (seq: number) => reads(seq).reduce((sum, statement) => sum + statement.bytes - 128, 0);
			const summary = `extension ${reads(52).length} reads ${sent(52)} bytes, bash ${reads(54).length} reads ${sent(54)} bytes`;
			// Once in all, beginning with a short prefix, as main reads it once: the data pass writes the bytes the renderer
			// inputs pass kept.
			assert.ok(reads(52).length <= stored(extension) + 1, summary);
			assert.ok(sent(52) <= Buffer.byteLength(JSON.stringify(extension)) + 64 * 1024, summary);
			// Bash's result is read whole only to write it: the first pass stops at its prefix.
			assert.ok(reads(54).length <= stored(bash) + 1, summary);
			assert.ok(sent(54) <= Buffer.byteLength(JSON.stringify(bash)) + 64 * 1024, summary);
			const html = await readFile(path, "utf8");
			const encoded = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1];
			const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as {
				entries: SessionEntry[];
				renderedTools?: Record<string, unknown>;
			};
			assert.deepEqual(data.entries.slice(-4), entries.slice(-4));
			assert.deepEqual(Object.keys(data.renderedTools ?? {}).sort(), ["ext"]);
			await store.close();
		});
	} finally {
		removeTempDirectory(directory);
	}
}, 120_000);
