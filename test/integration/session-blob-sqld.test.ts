import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	copySessionBlobs,
	inlineToolOutput,
	sessionBlobOutput,
	TOOL_OUTPUT_ENTRY_TYPE,
	takeInlineToolOutput,
} from "../../packages/coding-agent/src/core/session-tool-output.ts";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { redirectOversizedToolResult } from "../../packages/coding-agent/src/core/tools/oversized-tool-result.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/**
 * Session blobs on a real libSQL server (sqld) over HTTP, through the shipped adapter, whose default limits refuse any
 * value over 5 MB. Runs only when a server is named, for example one started with
 *   sqld --db-path <dir> --http-listen-addr 127.0.0.1:8080 --auth-jwt-key-file <public key>
 * and `ATOMIC_TEST_LIBSQL_URL=http://127.0.0.1:8080`. A server that checks tokens needs `ATOMIC_TEST_LIBSQL_TOKEN_FILE`,
 * a file holding one; the token is read from it and never appears on a command line. Every test works under a table
 * prefix and session ids of its own and removes its sessions, so the server may be shared and may outlive the tests.
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const tokenFile = process.env.ATOMIC_TEST_LIBSQL_TOKEN_FILE;
const MiB = 1024 * 1024;
const header = (id: string, cwd = "/project") => ({
	id,
	version: 4 as const,
	createdAt: new Date(0).toISOString(),
	cwd,
});

let database: SqliteDatabase;
let store: SqlSessionStore;
const created: string[] = [];
beforeAll(async () => {
	if (serverUrl === undefined) return;
	const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
	database = await openLibsqlDatabase({ url: serverUrl, ...(authToken === undefined ? {} : { authToken }) });
	store = await SqlSessionStore.open(database, { prefix: `blobs_${randomUUID().replaceAll("-", "_").slice(0, 12)}_` });
});
afterAll(async () => {
	if (serverUrl === undefined) return;
	for (const id of created) await store.delete(id).catch(() => undefined);
	await store.close();
	await database.close();
});

async function session(): Promise<string> {
	const id = randomUUID();
	await store.create(header(id), []);
	created.push(id);
	return id;
}

function bytesOf(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index++) bytes[index] = (index * 131 + (index >>> 8)) & 0xff;
	return bytes;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe.skipIf(serverUrl === undefined)("session blobs on a libSQL server (#4379)", () => {
	for (const size of [4_900_000, 5_000_000, 6 * MiB, 20 * MiB, 64 * MiB]) {
		test(`a blob of ${size} bytes is stored once and read back whole`, async () => {
			const id = await session();
			const bytes = bytesOf(size);

			const blob = await store.putBlob(id, bytes);
			const read = await store.getBlob(id, blob.hash);

			assert.deepEqual(blob, { hash: sha256(bytes), bytes: size });
			assert.ok(read !== undefined && Buffer.from(read).equals(Buffer.from(bytes)));
			assert.deepEqual(await store.putBlob(id, bytes), blob, "the same bytes again");
			await store.delete(id);
			assert.equal(await store.getBlob(id, blob.hash), undefined, "deleted with the session");
		}, 300_000);
	}

	test("a released stage's 6 MiB result is stored, previewed, copied and exported (#4379)", async () => {
		const output = `BEGIN a released stage's output\n${"s".repeat(6 * MiB)}`;
		const first = await SessionManager.create(store, "/project");
		created.push(first.getSessionId());

		const replacement = await redirectOversizedToolResult({
			toolName: "bash",
			toolCallId: "call-1",
			result: { content: [{ type: "text", text: output }], details: undefined },
			isError: false,
			sessionId: first.getSessionId(),
			persist: sessionBlobOutput(first, "call-1"),
		});

		const message = replacement?.content[0];
		assert.ok(message?.type === "text");
		assert.match(message.text, /Full output saved to: tool-output:\/\/[0-9a-f]{64}\n/);
		const hash = sha256(new TextEncoder().encode(output));
		assert.equal(Buffer.from((await store.getBlob(first.getSessionId(), hash))!).toString("utf8"), output);
		const forkTarget = await session();
		await copySessionBlobs(store, first.getSessionId(), store, forkTarget, [hash]);
		assert.equal(Buffer.from((await store.getBlob(forkTarget, hash))!).toString("utf8"), output);
		const exported = await inlineToolOutput(first.getEntries(), store, first.getSessionId());
		const { entries, blobs } = takeInlineToolOutput(exported, "imported");
		assert.equal(blobs.length, 1);
		assert.equal(
			entries.filter((entry) => entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE).length,
			1,
		);
		assert.equal(sha256(blobs[0]!.data), hash);
	}, 300_000);
});
