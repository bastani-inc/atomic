/**
 * The default session store wraps the SQLite database and the JSONL sessions saved before it; it keeps blobs in the
 * database, and a legacy session is moved into the database before it stores one (#4379).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { getDefaultSessionDirPath } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";

useTemporaryAgentDir();

let root: string;
let agentDir: string;
let cwd: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "legacy-session-tool-output-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv(ENV_SESSION_DIR, "");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	while (closers.length > 0) await closers.pop()?.();
	rmSync(root, { recursive: true, force: true });
});

function writeLegacy(id: string): void {
	const createdAt = "2026-10-16T10:00:00.000Z";
	const directory = getDefaultSessionDirPath(cwd, agentDir);
	mkdirSync(directory, { recursive: true });
	const user = { role: "user", content: "before the database", timestamp: Date.parse(createdAt) + 1000 };
	writeFileSync(
		join(directory, `${createdAt.replace(/[:.]/g, "-")}_${id}.jsonl`),
		`${[
			{ type: "session", version: 4, id, createdAt, cwd },
			{ type: "message", id: "u0000001", parentId: null, timestamp: createdAt, message: user },
		]
			.map((line) => JSON.stringify(line))
			.join("\n")}\n`,
	);
}

async function defaultStore(): Promise<SessionStore> {
	const store = await resolveSessionStore(cwd, { agentDir, settings: {} });
	closers.push(() => store.close());
	assert.ok(store instanceof LegacySessionStore);
	return store;
}

test("a legacy session moves into the database before it stores a blob, which it then reads back (#4379)", async () => {
	writeLegacy("legacy-session");
	const store = await defaultStore();
	const data = new TextEncoder().encode("a released stage's output");

	const blob = await store.putBlob!("legacy-session", data);

	assert.equal(blob.bytes, data.byteLength);
	assert.deepEqual(await store.getBlob!("legacy-session", blob.hash), data);
	assert.equal((await store.load("legacy-session")).entries.length, 1);
	await store.delete("legacy-session");
	assert.equal(await store.getBlob!("legacy-session", blob.hash), undefined);
});

/** `inner` with only the blob methods named in `keep`. */
function withBlobMethods(inner: MemorySessionStore, keep: readonly ("putBlob" | "getBlob")[]): SessionStore {
	return {
		descriptor: inner.descriptor,
		create: (header, entries) => inner.create(header, entries),
		append: (sessionId, entries, options) => inner.append(sessionId, entries, options),
		replace: (sessionId, header, entries, options) => inner.replace(sessionId, header, entries, options),
		load: (sessionId) => inner.load(sessionId),
		readHeader: (sessionId) => inner.readHeader(sessionId),
		delete: (sessionId) => inner.delete(sessionId),
		list: (query) => inner.list(query),
		findMostRecent: (query) => inner.findMostRecent(query),
		close: () => inner.close(),
		...(keep.includes("putBlob")
			? { putBlob: (sessionId: string, data: Uint8Array) => inner.putBlob(sessionId, data) }
			: {}),
		...(keep.includes("getBlob")
			? { getBlob: (sessionId: string, hash: string) => inner.getBlob(sessionId, hash) }
			: {}),
	};
}

test("the default store holds blobs only when the store it wraps has both blob methods (#4379)", () => {
	const wrap = (inner: SessionStore) =>
		new LegacySessionStore(inner, { legacyDirectory: root, databasePath: join(root, "db.sqlite") });

	const capable = wrap(withBlobMethods(new MemorySessionStore(), ["putBlob", "getBlob"]));
	assert.equal(typeof capable.putBlob, "function");
	assert.equal(typeof capable.getBlob, "function");
	for (const keep of [[], ["putBlob"], ["getBlob"]] as const) {
		const partial = wrap(withBlobMethods(new MemorySessionStore(), keep));
		assert.equal(partial.putBlob, undefined, `with ${keep.join(", ") || "neither"}`);
		assert.equal(partial.getBlob, undefined, `with ${keep.join(", ") || "neither"}`);
	}
});
