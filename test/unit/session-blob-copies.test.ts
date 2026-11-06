import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import {
	inlineToolOutput,
	readToolOutputBlobs,
	sessionBlobOutput,
	storeSessionBlobs,
	TOOL_OUTPUT_ENTRY_TYPE,
	takeInlineToolOutput,
	toolOutputHashes,
} from "../../packages/coding-agent/src/core/session-tool-output.ts";
import { isSessionBlobError, SessionBlobError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { redirectOversizedToolResult } from "../../packages/coding-agent/src/core/tools/oversized-tool-result.ts";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

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

describe("tool-output references in copies and exports (#4379)", () => {
	async function sessionWithOutput(store: SessionStore, text = outputOf(64 * 1024)) {
		const manager = await SessionManager.create(store, "/project");
		await manager.appendMessage({ role: "user", content: "run it", timestamp: 1 });
		await spillReleased(manager, "call-1", text);
		return { manager, hash: sha256(text), text };
	}

	test("a branch, a fork to another store and a rebound store each hold the blobs their entries reference (#4379)", async () => {
		const source = new MemorySessionStore();
		const { manager, hash, text } = await sessionWithOutput(source);
		const parentId = manager.getSessionId();
		const other = new MemorySessionStore();

		const forked = await manager.forkTo("/project", other);
		await manager.createBranchedSession(manager.getLeafId()!);
		const rebound = new MemorySessionStore();
		await manager.rebindStore(rebound, false);

		await source.delete(parentId);
		assert.deepEqual(
			(await other.load(forked.getSessionId())).entries.map((entry) => entry.id),
			manager.getEntries().map((entry) => entry.id),
		);
		assert.equal(Buffer.from((await other.getBlob(forked.getSessionId(), hash))!).toString(), text);
		assert.equal(Buffer.from((await source.getBlob(manager.getSessionId(), hash))!).toString(), text);
		assert.equal(Buffer.from((await rebound.getBlob(manager.getSessionId(), hash))!).toString(), text);
	});

	test("a copy into a store that holds no blobs fails before anything is written (#4379)", async () => {
		const { manager } = await sessionWithOutput(new MemorySessionStore());
		const directory = makeTempDirectory("atomic-tool-output-jsonl-");
		try {
			const jsonl = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const writes: string[] = [];
			const create = jsonl.create.bind(jsonl);
			jsonl.create = async (...args) => {
				writes.push(args[0].id);
				return create(...args);
			};

			await assert.rejects(manager.forkTo("/project", jsonl), (error) => {
				assert.ok(isSessionBlobError(error));
				assert.equal(error.code, "blobs-unsupported");
				assert.equal(error.adapter, "jsonl");
				assert.match(error.hint, /SQLite or libSQL/);
				return true;
			});
			await assert.rejects(manager.rebindStore(jsonl, false), SessionBlobError);

			assert.deepEqual(writes, []);
		} finally {
			removeTempDirectory(directory);
		}
	});

	test("a copy whose blob cannot be stored deletes the session it created and keeps the store's failure (#4379)", async () => {
		const { manager } = await sessionWithOutput(new MemorySessionStore());
		const target = new MemorySessionStore();
		const failure = new Error("disk full");
		target.putBlob = async () => {
			throw failure;
		};
		const cleanup = new Error("delete failed");
		const created: string[] = [];
		const create = target.create.bind(target);
		target.create = async (header, entries) => {
			created.push(header.id);
			return create(header, entries);
		};

		await assert.rejects(manager.forkTo("/project", target), (error) => error === failure);
		assert.equal(await target.readHeader(created[0]!), undefined, "the created session was deleted");

		target.delete = async () => {
			throw cleanup;
		};
		await assert.rejects(manager.forkTo("/project", target), (error) => {
			assert.equal(error, failure);
			assert.equal((error as { cleanupCause?: unknown }).cleanupCause, cleanup);
			return true;
		});
	});

	test("an export carries each blob once inline, and taking it back checks its hash before anything is written (#4379)", async () => {
		const store = new MemorySessionStore();
		const { manager, hash, text } = await sessionWithOutput(store);
		await spillReleased(manager, "call-2", text);
		const entries = manager.getBranch();
		assert.deepEqual(toolOutputHashes(entries), [hash]);

		const exported = await inlineToolOutput(entries, store, manager.getSessionId());

		const carried = exported.flatMap((entry) =>
			entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE
				? [entry.data as { readonly base64?: string }]
				: [],
		);
		assert.deepEqual(
			carried.map((data) => data.base64),
			[Buffer.from(text).toString("base64"), undefined],
		);
		const taken = takeInlineToolOutput(exported, "imported");
		assert.deepEqual(taken.entries, entries);
		assert.deepEqual(
			taken.blobs.map((blob) => [blob.hash, Buffer.from(blob.data).toString()]),
			[[hash, text]],
		);

		const tampered = exported.map((entry) =>
			entry.type === "custom" && (entry.data as { base64?: string }).base64 !== undefined
				? { ...entry, data: { ...(entry.data as object), base64: Buffer.from(`${text}!`).toString("base64") } }
				: entry,
		);
		assert.throws(
			() => takeInlineToolOutput(tampered, "imported"),
			(error) => {
				assert.ok(isSessionBlobError(error));
				assert.equal(error.code, "blob-corrupt");
				assert.equal(error.sessionId, "imported");
				assert.equal(error.hash, hash);
				assert.equal(error.actualHash, sha256(`${text}!`));
				return true;
			},
		);
	});

	test("an export leaves out an output its store no longer holds, keeping the reference (#4379)", async () => {
		const store = new MemorySessionStore();
		const { manager } = await sessionWithOutput(store);
		const entries = manager.getBranch();
		const withoutBlobs = Object.assign(Object.create(store) as MemorySessionStore, {
			getBlob: async () => undefined,
		});

		assert.deepEqual(await inlineToolOutput(entries, withoutBlobs, manager.getSessionId()), entries);
	});
});
describe("tool-output entries and blob copies (#4379)", () => {
	const base = { id: "e", parentId: null, timestamp: new Date(0).toISOString() };
	const reference = (data: object | null): SessionEntry =>
		({ ...base, type: "custom", customType: TOOL_OUTPUT_ENTRY_TYPE, data }) as SessionEntry;

	test("only atomic.tool-output custom entries with a text hash reference a blob (#4379)", () => {
		assert.equal(TOOL_OUTPUT_ENTRY_TYPE, "atomic.tool-output");
		const entries = [
			reference({ toolCallId: "call-1", hash: "a".repeat(64), bytes: 1 }),
			{ ...base, type: "custom", customType: "another-extension", data: { hash: "b".repeat(64) } },
			{ ...base, type: "custom_message", customType: TOOL_OUTPUT_ENTRY_TYPE, data: { hash: "c".repeat(64) } },
			reference(null),
			reference({ hash: 64 }),
			reference({ toolCallId: "call-2", hash: "a".repeat(64), bytes: 1 }),
		] as unknown as SessionEntry[];

		assert.deepEqual(toolOutputHashes(entries), ["a".repeat(64)]);
	});

	test("a store without getBlob holds no blob to copy, even for entries that reference one (#4379)", async () => {
		const store = new MemorySessionStore();
		const blobless = Object.assign(Object.create(store) as MemorySessionStore, { getBlob: undefined });

		assert.deepEqual(await readToolOutputBlobs(blobless, "session", [reference({ hash: "a".repeat(64) })]), []);
	});

	test("storing blobs into a store that cannot hold them deletes the session just created (#4379)", async () => {
		const store = new MemorySessionStore();
		await store.create({ id: "copy", version: 4, createdAt: new Date(0).toISOString(), cwd: "/" }, []);
		const blobless = Object.assign(Object.create(store) as MemorySessionStore, { putBlob: undefined });

		await assert.rejects(
			storeSessionBlobs(blobless, "copy", [{ hash: "a".repeat(64), data: new Uint8Array([1]) }]),
			(error) => isSessionBlobError(error) && error.code === "blobs-unsupported" && error.sessionId === "copy",
		);
		assert.equal(await store.readHeader("copy"), undefined);
	});
});
