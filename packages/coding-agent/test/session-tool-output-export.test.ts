/**
 * An exported session carries the tool outputs its released stages kept as session blobs, inline, so the file restores
 * them into another store; an import checks each against its hash before writing anything (#4379).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import type { CustomEntry } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	sessionBlobOutput,
	TOOL_OUTPUT_ENTRY_TYPE,
	type ToolOutputReference,
} from "../src/core/session-tool-output.js";
import { isSessionBlobError } from "../src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { createHarness, type Harness } from "./suite/harness.js";

useTemporaryAgentDir();

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function sqlStore(directory: string, name: string): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(join(directory, `${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const OUTPUT = `BEGIN\n${"exported output ".repeat(8192)}\nEND`;
const HASH = createHash("sha256").update(OUTPUT, "utf8").digest("hex");

/** A session in its own database whose released stage kept `OUTPUT` as a blob, exported to a file. */
async function exported(directory: string, options?: { readonly toolOutputContent?: boolean }) {
	const store = await sqlStore(directory, "source");
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await createHarness({ sessionManager: manager });
	harnesses.push(harness);
	await manager.appendMessage({ role: "user", content: "run the report", timestamp: Date.now() });
	const kept = await sessionBlobOutput(manager, "call-1")!(OUTPUT);
	assert.equal(kept.location, `tool-output://${HASH}`);
	const path = await harness.session.exportToJsonl(join(directory, "export.jsonl"), options);
	return { path, sessionId: manager.getSessionId() };
}

function references(lines: readonly string[]): ToolOutputReference[] {
	return lines
		.map((line) => JSON.parse(line) as CustomEntry<ToolOutputReference>)
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "atomic.tool-output" ? [entry.data!] : []));
}

function fileLines(path: string): string[] {
	return readFileSync(path, "utf8").trim().split("\n");
}

test("an export carries the blob inline and an import into another database restores it (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-export-");
	const { path, sessionId } = await exported(directory);
	assert.deepEqual(references(fileLines(path)), [
		{
			toolCallId: "call-1",
			hash: HASH,
			bytes: Buffer.byteLength(OUTPUT),
			base64: Buffer.from(OUTPUT).toString("base64"),
		},
	]);
	const target = await sqlStore(directory, "target");

	const imported = await SessionManager.importFromJsonl(path, process.cwd(), target);

	assert.equal(imported.getSessionId(), sessionId);
	assert.equal(Buffer.from((await target.getBlob(sessionId, HASH))!).toString("utf8"), OUTPUT);
	const stored = (await target.load(sessionId)).entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE ? [entry.data] : [],
	);
	assert.deepEqual(stored, [{ toolCallId: "call-1", hash: HASH, bytes: Buffer.byteLength(OUTPUT) }]);
});

test("an export for sharing leaves the blob out and keeps the reference (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-share-");

	const { path } = await exported(directory, { toolOutputContent: false });

	assert.deepEqual(references(fileLines(path)), [
		{ toolCallId: "call-1", hash: HASH, bytes: Buffer.byteLength(OUTPUT) },
	]);
});

test("an import whose inline output does not match its hash is blob-corrupt and writes nothing (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-corrupt-");
	const { path, sessionId } = await exported(directory);
	const tampered = fileLines(path).map((line) => {
		const entry = JSON.parse(line) as CustomEntry<ToolOutputReference>;
		if (entry.type !== "custom" || entry.customType !== TOOL_OUTPUT_ENTRY_TYPE) return line;
		return JSON.stringify({
			...entry,
			data: { ...entry.data, base64: Buffer.from(`${OUTPUT}!`).toString("base64") },
		});
	});
	writeFileSync(path, `${tampered.join("\n")}\n`);
	const target = await sqlStore(directory, "target");

	await assert.rejects(SessionManager.importFromJsonl(path, process.cwd(), target), (error) => {
		assert.ok(isSessionBlobError(error));
		assert.equal(error.code, "blob-corrupt");
		assert.equal(error.sessionId, sessionId);
		assert.equal(error.hash, HASH);
		return true;
	});

	assert.equal(await target.readHeader(sessionId), undefined);
});

test("an import into a session directory, which holds no blobs, is blobs-unsupported and writes nothing (#4379)", async () => {
	const directory = temporaryDirectory("atomic-tool-output-jsonl-import-");
	const { path } = await exported(directory);
	const sessionDir = join(directory, "sessions");
	const creates = vi.spyOn(JsonlSessionStore.prototype, "create");

	await assert.rejects(SessionManager.importFromJsonl(path, process.cwd(), sessionDir), (error) => {
		assert.ok(isSessionBlobError(error));
		assert.equal(error.code, "blobs-unsupported");
		assert.equal(error.adapter, "jsonl");
		return true;
	});

	assert.equal(creates.mock.calls.length, 0, "no session was created");
	assert.ok(!existsSync(sessionDir) || readdirSync(sessionDir).length === 0, "no session file was written");
	creates.mockRestore();
});
