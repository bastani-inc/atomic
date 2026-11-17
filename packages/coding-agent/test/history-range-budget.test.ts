import assert from "node:assert/strict";
import { it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { HistoryCallBudget, readSessionRanges } from "../src/core/tools/history-session.js";

it.each([0, 1])("keeps session text unread when only %i output bytes remain (#5250)", async (allowance) => {
	const store = new MemorySessionStore();
	const timestamp = "2026-11-17T00:00:00.000Z";
	const entry: SessionEntry = {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "keep every character", timestamp: Date.parse(timestamp) },
	};
	try {
		await store.create({ id: "exhausted", version: SESSION_FORMAT_VERSION, cwd: "/project", createdAt: timestamp }, [
			entry,
		]);
		const budget = new HistoryCallBudget({ bytes: 1_000, rows: 10, timeMs: 1_000 }, undefined);
		budget.spend(budget.bytesAvailable() - allowance);
		const output = await readSessionRanges(
			{
				store,
				sessionId: "exhausted",
				urlWith: ({ cursor }) =>
					`history://sessions/exhausted${cursor === undefined ? "" : `?cursor=${cursor}`}:1-1`,
			},
			[{ start: 1, end: 1 }],
			true,
			undefined,
			budget,
		);
		assert.ok(output.startsWith("[read up to entry"), output);
		assert.doesNotMatch(output, /cursor=1\.0\.1/);
		assert.equal(budget.bytesAvailable(), allowance);
	} finally {
		await store.close();
	}
});
