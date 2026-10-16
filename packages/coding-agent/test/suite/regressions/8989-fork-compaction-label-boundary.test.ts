import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type CompactionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { userMsg } from "../../utilities.ts";

describe("regression #8989", () => {
	it("preserves compaction context when a fork removes the boundary label", async () => {
		const session = SessionManager.inMemory();
		const oldId = await session.appendMessage(userMsg("old"));
		// findCutPoint() can move a compaction boundary back to this context-invisible label.
		const labelId = await session.appendLabelChange(oldId, "checkpoint");
		const keptId = await session.appendMessage(userMsg("kept"));
		const compactionId = await session.appendCompaction("summary", labelId, 100, {
			strategy: "verbatim-lines",
			promptVersion: 3,
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
			stats: {
				linesBefore: 2,
				linesDeleted: 1,
				linesKept: 1,
				rangeCount: 1,
				tokensBefore: 100,
				tokensAfter: 50,
				percentReduction: 50,
			},
			rung: "planned",
		});
		const leafId = await session.appendMessage(userMsg("after"));

		await session.createBranchedSession(leafId);

		assert.equal((session.getEntry(compactionId) as CompactionEntry).firstKeptEntryId, keptId);
		const messages = session.buildSessionContext().messages;
		assert.equal(messages.length, 2);
		assert.equal(messages[0]?.role, "custom");
		assert.match(JSON.stringify(messages[0]?.content), /summary/);
		assert.match(JSON.stringify(messages[0]?.content), /\[User\]: kept/);
		assert.equal(messages[1]?.role, "user");
		assert.equal(messages[1]?.content, "after");
	});
});
