import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { sessionBlobOutput, TOOL_OUTPUT_ENTRY_TYPE } from "../../packages/coding-agent/src/core/session-tool-output.ts";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { isSessionBlobError, SessionBlobError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { redirectOversizedToolResult } from "../../packages/coding-agent/src/core/tools/oversized-tool-result.ts";
import { MAX_PERSISTED_OUTPUT_BYTES } from "../../packages/coding-agent/src/core/tools/tool-limits.js";
import { createToolOutputRouter } from "../../packages/coding-agent/src/core/tools/tool-output-protocol.ts";
import { countingDatabase } from "../helpers/counting-database.js";
import { withLibsqlDatabase } from "../helpers/libsql-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const MiB = 1024 * 1024;

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** A tool output of `bytes` ASCII bytes: a first line the preview keeps, then filler. */
function outputOf(bytes: number): string {
	const head = "BEGIN tool output\n";
	return head + "x".repeat(bytes - head.length);
}

/**
 * What a released stage's oversized result leaves in its session: the spill as a blob of the session with an entry
 * referencing it, then the result message with the preview. Resolves with the URL the preview names.
 */
async function spillReleased(manager: SessionManager, toolCallId: string, text: string): Promise<string> {
	const replacement = await redirectOversizedToolResult({
		toolName: "bash",
		toolCallId,
		result: { content: [{ type: "text", text }], details: undefined },
		isError: false,
		sessionId: manager.getSessionId(),
		persist: sessionBlobOutput(manager, toolCallId),
	});
	assert.ok(replacement !== undefined, "the output was spilled");
	await manager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: replacement.content,
		isError: false,
		timestamp: Date.now(),
	});
	const location = /Full output saved to: (\S+)\n/.exec(replacement.content[0]!.text)?.[1];
	assert.ok(location !== undefined);
	return location;
}

async function entryRowBytes(database: SqliteDatabase, sessionId: string): Promise<number[]> {
	const rows = await database.all<{ bytes: number }>(
		"SELECT length(CAST(entry_json AS BLOB)) AS bytes FROM session_entries WHERE session_id = ? ORDER BY seq",
		sessionId,
	);
	return rows.map((row) => Number(row.bytes));
}

async function blobRows(
	database: SqliteDatabase,
	sessionId: string,
): Promise<{ readonly count: number; readonly bytes: number; readonly stored: number }> {
	const row = await database.get<{ count: number; bytes: number | null; stored: number | null }>(
		"SELECT count(*) AS count, sum(bytes) AS bytes, sum(length(data)) AS stored FROM session_blobs WHERE session_id = ?",
		sessionId,
	);
	return { count: Number(row?.count), bytes: Number(row?.bytes ?? 0), stored: Number(row?.stored ?? 0) };
}

describe("a released stage's oversized output is a blob of its session (#4379)", () => {
	test("session rows stay the same small size whatever the output's size, and the bytes are stored once (#4379)", async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const counted = countingDatabase(database);
			const store = await SqlSessionStore.open(counted.wrapped);
			const measured: { size: number; rows: number[]; blobs: Awaited<ReturnType<typeof blobRows>> }[] = [];
			for (const size of [MiB, 20 * MiB]) {
				const manager = await SessionManager.create(store, "/project");
				const text = outputOf(size);
				const location = await spillReleased(manager, `call-${size}`, text);
				assert.equal(location, `tool-output://${sha256(text)}`);
				measured.push({
					size,
					rows: await entryRowBytes(database, manager.getSessionId()),
					blobs: await blobRows(database, manager.getSessionId()),
				});

				counted.statements.length = 0;
				const loaded = await store.load(manager.getSessionId());
				for await (const _summary of store.list({ includeInternal: true })) {
					// Listing reads summaries only.
				}
				assert.deepEqual(
					counted.statements.filter((statement) => statement.sql.includes("session_blobs")),
					[],
					"loading and listing never read blobs",
				);
				assert.equal(
					loaded.entries.filter((entry) => entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE)
						.length,
					1,
				);
			}
			const [small, large] = measured;
			for (const { rows, blobs, size } of measured) {
				assert.equal(rows.length, 2, "one reference entry and one result message");
				for (const bytes of rows)
					assert.ok(bytes < 4096, `an entry row of ${bytes} bytes for a ${size}-byte output`);
				assert.deepEqual(blobs, { count: 1, bytes: size, stored: size });
			}
			const total = (rows: number[]) => rows.reduce((sum, bytes) => sum + bytes, 0);
			// Only the size printed in the preview and recorded in the reference differs.
			assert.ok(total(large!.rows) - total(small!.rows) <= 4, `${total(small!.rows)} → ${total(large!.rows)}`);
		});
	});

	for (const [adapter, withDatabase] of [
		["SQLite", withNodeSqliteDatabase],
		["libSQL", withLibsqlDatabase],
	] as const) {
		test(`an output at the persisted-output cap round-trips through ${adapter} (#4379)`, async () => {
			await withDatabase(async ({ database }) => {
				const store = await SqlSessionStore.open(database);
				const manager = await SessionManager.create(store, "/project");
				const text = outputOf(MAX_PERSISTED_OUTPUT_BYTES + MiB);

				const location = await spillReleased(manager, "call-1", text);

				const hash = location.slice("tool-output://".length);
				const data = await store.getBlob(manager.getSessionId(), hash);
				assert.ok(data !== undefined);
				assert.ok(data.byteLength <= MAX_PERSISTED_OUTPUT_BYTES, `${data.byteLength} bytes kept`);
				assert.ok(data.byteLength > MAX_PERSISTED_OUTPUT_BYTES - MiB, `${data.byteLength} bytes kept`);
				assert.equal(sha256(data), hash);
				assert.equal(Buffer.from(data.subarray(0, 18)).toString("utf8"), "BEGIN tool output\n");
				for (const bytes of await entryRowBytes(database, manager.getSessionId())) assert.ok(bytes < 4096);
				const reopened = await SqlSessionStore.open(database);
				assert.equal(sha256((await reopened.getBlob(manager.getSessionId(), hash))!), hash);
			});
		});
	}
});

describe("tool-output:// URLs (#4379)", () => {
	test("read the current session's blob; another session's, an unknown hash or a malformed URL are blob-missing (#4379)", async () => {
		const store = new MemorySessionStore();
		const header = (id: string) => ({ id, version: 4 as const, createdAt: new Date(0).toISOString(), cwd: "/" });
		await store.create(header("current"), []);
		await store.create(header("other"), []);
		const { hash } = await store.putBlob("current", new TextEncoder().encode("kept output"));
		const { hash: otherHash } = await store.putBlob("other", new TextEncoder().encode("other output"));
		const router = createToolOutputRouter({ sessionId: () => "current", sessionStore: () => store });
		const reads = vi.spyOn(store, "getBlob");

		assert.equal(await router.read?.(`tool-output://${hash}`), "kept output");
		assert.equal(await router.read?.("history://sessions"), undefined, "another scheme is left to its router");
		for (const [url, missing] of [
			[`tool-output://${otherHash}`, otherHash],
			[`tool-output://${"0".repeat(64)}`, "0".repeat(64)],
			[`tool-output://${hash.toUpperCase()}`, hash.toUpperCase()],
			["tool-output://not-a-hash", "not-a-hash"],
			[`tool-output://x${hash}`, `x${hash}`],
			[`tool-output://${hash}x`, `${hash}x`],
		] as const) {
			await assert.rejects(Promise.resolve(router.read?.(url)), (error) => {
				assert.ok(isSessionBlobError(error));
				assert.equal(error.code, "blob-missing");
				assert.equal(error.sessionId, "current");
				assert.equal(error.hash, missing);
				return true;
			});
		}
		assert.deepEqual(
			reads.mock.calls.map(([, read]) => read),
			[hash, otherHash, "0".repeat(64)],
			"a URL that names no hash is not looked up",
		);
	});

	test("a store that holds no blobs is blobs-unsupported, with how to fix it (#4379)", async () => {
		const directory = makeTempDirectory("atomic-tool-output-url-");
		try {
			const jsonl = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const router = createToolOutputRouter({ sessionId: () => "current", sessionStore: () => jsonl });

			await assert.rejects(Promise.resolve(router.read?.(`tool-output://${"a".repeat(64)}`)), (error) => {
				assert.ok(error instanceof SessionBlobError);
				assert.equal(error.code, "blobs-unsupported");
				assert.equal(error.adapter, "jsonl");
				assert.equal(
					error.message,
					`Session store cannot hold blobs: jsonl store of session current (blobs-unsupported). ${error.hint}`,
				);
				return true;
			});
		} finally {
			removeTempDirectory(directory);
		}
	});
});
