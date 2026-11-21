import assert from "node:assert/strict";
import { getCurrentSystemMessage } from "@bastani/atomic-ai";
import { test } from "vitest";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";

const details: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	form: "cleared",
	promptVersion: 7,
	parameters: { query: "clear" },
	stats: {
		linesBefore: 1,
		linesDeleted: 1,
		linesKept: 0,
		rangeCount: 0,
		tokensBefore: 100,
		tokensAfter: 0,
		percentReduction: 100,
	},
};

const prompt = (text: string, timestamp: number) =>
	({ role: "system", content: "", sections: { choice: text }, timestamp }) as const;

/** The prompt sections the session sends now, and how many messages set the choice section. */
function promptState(manager: SessionManager) {
	const messages = manager.buildSessionProjection().messages;
	const setting = messages.filter((message) => message.role === "system" && message.sections?.choice !== undefined);
	return { choice: getCurrentSystemMessage(messages)?.sections?.choice, setting: setting.length };
}

test("a boundary that covers the history through an earlier entry carries the prompt as of it, and a later change replays once", async () => {
	const manager = await SessionManager.create(new MemorySessionStore(), process.cwd());
	await manager.appendMessage(prompt("First choice", 1));
	const covered = await manager.appendMessage({ role: "user", content: "restored", timestamp: 2 });
	await manager.appendMessage(prompt("Current choice", 3));
	await manager.appendMessage({ role: "user", content: "later", timestamp: 4 });

	const boundary = await manager.appendCompaction("clear", null, 100, details, undefined, covered);
	const entry = manager.getEntry(boundary);
	assert.equal(entry?.type === "compaction" ? entry.systemMessage?.sections?.choice : undefined, "First choice");
	// The boundary's prompt, then the change after the covered entry, once.
	assert.deepEqual(promptState(manager), { choice: "Current choice", setting: 2 });
});

test("a boundary naming an entry of another branch carries the prompt as it is now", async () => {
	const manager = await SessionManager.create(new MemorySessionStore(), process.cwd());
	const root = await manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	await manager.appendMessage(prompt("First choice", 2));
	const sibling = await manager.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
	await manager.branch(root);
	await manager.appendMessage(prompt("Current choice", 4));
	await manager.appendMessage({ role: "user", content: "current branch", timestamp: 5 });

	await manager.appendCompaction("clear", null, 100, details, undefined, sibling);
	assert.equal(promptState(manager).choice, "Current choice");
});
