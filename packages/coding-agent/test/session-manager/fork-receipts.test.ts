import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { sessionBlobOutput } from "../../src/core/session-tool-output.js";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { readSessionHistory, readSessionHistoryChunks } from "../../src/core/storage/session/history-pages.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../src/core/storage/session/types.js";

useTemporaryAgentDir();

test.each(["memory", "sqlite", "jsonl"])(
	"a %s child archives a referenced historical receipt without decoding it or carrying unrelated history (#5594)",
	async (adapter) => {
		const dir = await mkdtemp(join(tmpdir(), "fork-receipt-"));
		const db = adapter === "sqlite" ? await openNodeSqliteDatabase(join(dir, "test.db")) : undefined;
		const store: SessionStore = db
			? await SqlSessionStore.open(db)
			: adapter === "memory"
				? new MemorySessionStore()
				: await JsonlSessionStore.open(dir, { exactDirectory: true });
		try {
			const parent = await SessionManager.create(store, dir);
			const hash = createHash("sha256").update("answer").digest("hex");
			await store.putBlob?.(parent.getSessionId(), Buffer.from("answer"));
			const receipt = await parent.appendCustomEntry("atomic.tool-output", {
				hash,
				toolCallId: "saved",
				bytes: 6,
				extra: "x".repeat(2 * 1024 * 1024),
			});
			const original = createHash("sha256")
				.update(JSON.stringify(parent.getEntry(receipt)))
				.digest("hex");
			await parent.appendCustomEntry("atomic.tool-output", { hash: "a".repeat(64), extra: "unrelated" });
			await parent.appendCompaction("clear", null, 100, {
				strategy: "verbatim-lines",
				promptVersion: 7,
				parameters: { query: "clear" },
				form: "cleared",
				stats: {
					linesBefore: 1,
					linesDeleted: 1,
					linesKept: 0,
					rangeCount: 0,
					tokensBefore: 100,
					tokensAfter: 0,
					percentReduction: 100,
				},
			});
			await parent.appendMessage({ role: "user", content: `Inspect tool-output://${hash}`, timestamp: 1 });
			const read = store.readRange!.bind(store);
			store.readRange = async (...args) => {
				const result = await read(...args);
				if (args[0] === parent.getSessionId())
					assert.ok(
						result.entries.every((e) => e.id !== receipt),
						"decoded the archived receipt",
					);
				return result;
			};
			const child = await parent.forkTo(dir, store);
			assert.equal(child.getEntry(receipt), undefined);
			await store.delete(parent.getSessionId());
			let found = false;
			for await (const page of readSessionHistory(store, child.getSessionId()))
				for (const item of page.items) {
					if ("entry" in item) {
						assert.ok(!JSON.stringify(item.entry).includes("unrelated"));
						continue;
					}
					const digest = createHash("sha256");
					for await (const part of readSessionHistoryChunks(store, item)) digest.update(part);
					assert.equal(digest.digest("hex"), original);
					found = true;
				}
			assert.ok(found);
			if (store.getBlob)
				assert.equal(Buffer.from((await store.getBlob(child.getSessionId(), hash))!).toString(), "answer");
		} finally {
			await store.close();
			await db?.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("a fork keeps an archived receipt after its original settings, including when reopening at the receipt (#5594)", async () => {
	const store = new MemorySessionStore();
	try {
		const parent = await SessionManager.create(store, process.cwd());
		await parent.appendModelChange("anthropic", "chosen");
		await parent.appendThinkingLevelChange("high");
		const saved = await sessionBlobOutput(parent, "call")!("answer");
		const receipt = parent.getLeafId()!;
		await parent.appendMessage({ role: "user", content: "retired", timestamp: 1 });
		await parent.appendCompaction("cleared", null, 100, {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters: { query: "clear" },
			form: "cleared",
			stats: {
				linesBefore: 1,
				linesDeleted: 1,
				linesKept: 0,
				rangeCount: 0,
				tokensBefore: 100,
				tokensAfter: 0,
				percentReduction: 100,
			},
		});
		await parent.appendMessage({ role: "user", content: `Inspect ${saved.location}`, timestamp: 2 });
		const child = await parent.forkTo(process.cwd(), store);
		const earlier = await SessionManager.open(store, child.getSessionId(), process.cwd(), { leafId: receipt });
		assert.deepEqual(earlier.buildSessionContext().model, { provider: "anthropic", modelId: "chosen" });
		assert.equal(earlier.buildSessionContext().thinkingLevel, "high");
	} finally {
		await store.close();
	}
});

test("a named historical output at the clear boundary does not disconnect the fork's settings (#5594)", async () => {
	const source = new MemorySessionStore();
	const destination = new MemorySessionStore();
	try {
		const parent = await SessionManager.create(source, process.cwd());
		await parent.appendThinkingLevelChange("high");
		await parent.appendModelChange("anthropic", "claude-opus-4-5");
		await parent.appendMessage({ role: "user", timestamp: 1, content: "covered turn" });
		const named = await sessionBlobOutput(parent, "saved-call")!("saved answer");
		const receipt = parent.getLeafEntry()!;
		await parent.appendMessage({ role: "user", timestamp: 2, content: `Read ${named.location}` });
		await parent.appendCompaction(
			"cleared",
			null,
			100,
			{
				strategy: "verbatim-lines",
				promptVersion: 7,
				parameters: { query: "clear" },
				form: "cleared",
				stats: {
					linesBefore: 1,
					linesDeleted: 1,
					linesKept: 0,
					rangeCount: 0,
					tokensBefore: 100,
					tokensAfter: 0,
					percentReduction: 100,
				},
			},
			undefined,
			receipt.id,
		);
		const child = await parent.forkTo(process.cwd(), destination);
		const reopened = await SessionManager.open(destination, child.getSessionId());
		for (const manager of [child, reopened]) {
			const context = manager.buildSessionContext();
			assert.deepEqual(context.model, { provider: "anthropic", modelId: "claude-opus-4-5" });
			assert.equal(context.thinkingLevel, "high");
			assert.equal(context.messages.at(-1)?.role, "user");
			assert.deepEqual(await manager.readEntry(receipt.id), receipt);
		}
	} finally {
		await source.close();
		await destination.close();
	}
});
