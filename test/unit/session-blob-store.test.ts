import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	isSessionBlobError,
	isStorageError,
	rehydrateStorageError,
	SessionBlobError,
	serializeStorageError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SessionNotFoundError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { ageBlobs, openSharedSnapshotDatabase, textBlob } from "../helpers/snapshot-reference-index.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

async function blobRows(
	database: SqliteDatabase,
	sessionId: string,
): Promise<{ readonly count: number; readonly bytes: number; readonly stored: number; readonly chunks: number }> {
	const header = await database.get<{ count: number; bytes: number | null }>(
		"SELECT count(*) AS count, sum(bytes) AS bytes FROM session_blobs WHERE session_id = ?",
		sessionId,
	);
	const chunks = await database.get<{ count: number; stored: number | null }>(
		"SELECT count(*) AS count, sum(length(data)) AS stored FROM session_blob_chunks WHERE session_id = ?",
		sessionId,
	);
	return {
		count: Number(header?.count),
		bytes: Number(header?.bytes ?? 0),
		stored: Number(chunks?.stored ?? 0),
		chunks: Number(chunks?.count),
	};
}

describe("session blobs beside the snapshot blobs of a shared database (#4379)", () => {
	test("snapshot collection never deletes a session's blobs, even of bytes it collects as a snapshot blob (#4379)", async () => {
		const directory = makeTempDirectory("atomic-tool-output-gc-");
		const shared = await openSharedSnapshotDatabase(join(directory, "shared.sqlite"));
		try {
			const manager = await SessionManager.create(shared.sessions, "/project");
			const text = "x".repeat(64 * 1024);
			const { hash } = await shared.sessions.putBlob(manager.getSessionId(), new TextEncoder().encode(text));
			const orphan = textBlob("an unreferenced snapshot blob");
			const sameBytes = { hash, data: new Uint8Array(Buffer.from(text, "utf8")) };
			await shared.sessions.snapshotBlobs.putBlobs([orphan, sameBytes]);
			await ageBlobs(shared.database, "snapshot_blobs", 3600);

			const { deleted } = await collectSnapshotGarbage(shared.sessions.snapshotBlobs, { graceSeconds: 0 });

			assert.deepEqual([...deleted].sort(), [orphan.hash, hash].sort());
			assert.equal(await shared.sessions.snapshotBlobs.getBlob(hash), undefined);
			assert.equal(Buffer.from((await shared.sessions.getBlob(manager.getSessionId(), hash))!).toString(), text);
		} finally {
			await shared.close();
			removeTempDirectory(directory);
		}
	});
	test("a blob stored while another connection deletes its session is never left behind (#4379)", async () => {
		const directory = makeTempDirectory("atomic-tool-output-race-");
		const path = join(directory, "sessions.sqlite");
		const writer = await openNodeSqliteDatabase(path);
		const deleter = await openNodeSqliteDatabase(path);
		try {
			const putting = await SqlSessionStore.open(writer);
			const deleting = await SqlSessionStore.open(deleter);
			const data = new TextEncoder().encode("output");
			for (let round = 0; round < 20; round++) {
				const id = `race-${round}`;
				await putting.create({ id, version: 4, createdAt: new Date(0).toISOString(), cwd: "/project" }, []);
				const [put, removed] = await Promise.allSettled([putting.putBlob(id, data), deleting.delete(id)]);
				assert.equal(removed.status, "fulfilled");
				if (put.status === "rejected") assert.ok(put.reason instanceof SessionNotFoundError);
				assert.deepEqual(
					await blobRows(writer, id),
					{ count: 0, bytes: 0, stored: 0, chunks: 0 },
					`round ${round}`,
				);
			}
		} finally {
			await writer.close();
			await deleter.close();
			removeTempDirectory(directory);
		}
	});
});

describe("SessionBlobError (#4379)", () => {
	test("each code renders what failed, the code and what to do, and carries only the fields it names (#4379)", () => {
		const unsupported = new SessionBlobError("blobs-unsupported", { sessionId: "s", adapter: "jsonl" });
		const missing = new SessionBlobError("blob-missing", { sessionId: "s", hash: "h" });
		const corrupt = new SessionBlobError("blob-corrupt", { sessionId: "s", hash: "h", actualHash: "a" });
		const incomplete = new SessionBlobError("blob-incomplete", { sessionId: "s", hash: "h", bytes: 12 });
		const severalMissing = new SessionBlobError("blob-missing", { sessionId: "s", hash: "h", missing: 3 });

		assert.equal(
			unsupported.message,
			"Session store cannot hold blobs: jsonl store of session s (blobs-unsupported). Keep the session in a SQLite or libSQL session store (the default sessions database, --session-store <path>, or a sessions.storage selection), or give a custom store putBlob and getBlob",
		);
		assert.equal(
			missing.message,
			"Session blob not found: h in session s (blob-missing). The session no longer holds this output; run the tool again to see it",
		);
		assert.equal(
			corrupt.message,
			"Session blob does not match its hash: h in session s (blob-corrupt). The exported session was changed after it was written; export it again from its source",
		);
		assert.equal(
			incomplete.message,
			"Session blob is incomplete: h (12 bytes) in session s (blob-incomplete). The store lost part of this output; run the tool again to see it",
		);
		assert.equal(
			severalMissing.message,
			"Session blob not found: h and 2 more in session s (blob-missing). The session no longer holds this output; run the tool again to see it",
		);
		for (const [missing, suffix] of [
			[undefined, ""],
			[1, ""],
			[2, " and 1 more"],
		] as const) {
			assert.equal(
				new SessionBlobError("blob-missing", { sessionId: "s", hash: "h", missing }).message.split(
					" (blob-missing)",
				)[0],
				`Session blob not found: h${suffix} in session s`,
			);
		}
		assert.deepEqual(Object.keys(incomplete).sort(), ["bytes", "code", "hash", "hint", "name", "sessionId"]);
		assert.deepEqual(Object.keys(severalMissing).sort(), ["code", "hash", "hint", "missing", "name", "sessionId"]);
		assert.deepEqual(Object.keys(unsupported).sort(), ["adapter", "code", "hint", "name", "sessionId"]);
		assert.deepEqual(Object.keys(missing).sort(), ["code", "hash", "hint", "name", "sessionId"]);
		assert.deepEqual(Object.keys(corrupt).sort(), ["actualHash", "code", "hash", "hint", "name", "sessionId"]);
		assert.equal(Object.hasOwn(missing, "cause"), false);
		assert.equal(Object.hasOwn(rehydrateStorageError(serializeStorageError(missing)), "cause"), false);
	});
	test("every code crosses a process boundary as the same class, fields and cause; an unknown code keeps its name (#4379)", () => {
		const errors = [
			new SessionBlobError("blobs-unsupported", { sessionId: "s", adapter: "jsonl" }),
			new SessionBlobError("blob-missing", { sessionId: "s", hash: "a".repeat(64), missing: 4 }),
			new SessionBlobError("blob-incomplete", { sessionId: "s", hash: "a".repeat(64), bytes: 2_500_000 }),
			new SessionBlobError(
				"blob-corrupt",
				{ sessionId: "s", hash: "a".repeat(64), actualHash: "b".repeat(64) },
				{ cause: new SessionNotFoundError("s") },
			),
		];
		for (const error of errors) {
			const serialized = JSON.parse(JSON.stringify(serializeStorageError(error)));
			const rehydrated = rehydrateStorageError(serialized);
			assert.ok(rehydrated instanceof SessionBlobError);
			assert.ok(isStorageError(rehydrated));
			assert.equal(rehydrated.code, error.code);
			assert.equal(rehydrated.message, error.message);
			assert.equal(rehydrated.hint, error.hint);
			assert.deepEqual(
				[
					rehydrated.sessionId,
					rehydrated.hash,
					rehydrated.actualHash,
					rehydrated.adapter,
					rehydrated.missing,
					rehydrated.bytes,
				],
				[error.sessionId, error.hash, error.actualHash, error.adapter, error.missing, error.bytes],
			);
			assert.equal((rehydrated.cause as Error | undefined)?.name, (error.cause as Error | undefined)?.name);
			assert.ok(isSessionBlobError({ name: "SessionBlobError", code: error.code }));
		}
		assert.equal(isSessionBlobError({ name: "SessionBlobError", code: "something-new" }), false);
		const future = rehydrateStorageError({
			name: "SessionBlobError",
			code: "something-new",
			message: "newer",
			fields: { sessionId: "s" },
		});
		assert.equal(future.name, "SessionBlobError");
		assert.equal((future as { code?: string }).code, "something-new");
		assert.ok(!(future instanceof SessionBlobError));
		const sparse = rehydrateStorageError({
			name: "SessionBlobError",
			code: "blob-missing",
			message: "m",
			fields: {},
		});
		assert.ok(sparse instanceof SessionBlobError);
		assert.equal(sparse.sessionId, "");
		assert.equal(sparse.hash, undefined);
	});
});
