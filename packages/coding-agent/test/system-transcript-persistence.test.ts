import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemMessage, getCurrentTools, type SystemMessage, type Tool } from "@bastani/pi-ai";
import { Type } from "typebox";
import { test } from "vitest";
import { estimateTokens } from "../src/core/compaction/compaction.js";
import type { VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { assistantMsg, userMsg } from "./utilities.js";

const tool = (name: string): Tool => ({ name, description: `  ${name}\n`, parameters: Type.Object({}) });

test("system instruction and tool deltas count toward context pressure", () => {
	const message: SystemMessage = {
		role: "system",
		content: "  raw\n".repeat(1000),
		toolsAdded: [tool("lookup")],
		timestamp: 1,
	};
	assert.ok(estimateTokens(message) >= 1500);
});

test("compaction, disk resume, and branches preserve raw system state and tool loadout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-system-transcript-"));
	try {
		const manager = await SessionManager.create(dir, dir);
		const head: SystemMessage = {
			role: "system",
			content: "  base\n\nbase  ",
			sections: { second: "\nsecond\n", first: "  first  " },
			toolsAdded: [tool("first"), tool("second")],
			timestamp: 1,
		};
		await manager.appendMessage(head);
		await manager.appendMessage(userMsg("old question"));
		const branchPoint = await manager.appendMessage(assistantMsg("old answer"));
		const patch: SystemMessage = {
			role: "system",
			content: "\nadded\n",
			sections: { second: null, third: "same\nsame\n" },
			toolsRemoved: [{ name: "first" }],
			timestamp: 2,
		};
		await manager.appendMessage(patch);
		const firstKept = await manager.appendMessage(userMsg("keep me"));
		await manager.appendMessage(assistantMsg("kept answer"));
		const expected = getCurrentSystemMessage(manager.buildSessionContext().messages);
		const details: VerbatimCompactionDetails = {
			strategy: "verbatim-lines",
			promptVersion: 2,
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
			stats: {
				linesBefore: 20,
				linesDeleted: 10,
				linesKept: 10,
				rangeCount: 1,
				tokensBefore: 100,
				tokensAfter: 50,
				percentReduction: 50,
			},
			rung: "planned",
		};
		await manager.appendCompaction("[User]: compacted\n(filtered 8 lines)", firstKept, 100, details);
		const compacted = manager.buildSessionContext().messages;
		assert.deepEqual(getCurrentSystemMessage(compacted), { ...expected, timestamp: compacted[0].timestamp });
		assert.deepEqual(
			compacted.map((message) => message.role),
			["system", "custom"],
		);
		const file = manager.getSessionFile();
		assert.ok(file);
		const resumed = await SessionManager.open(file);
		assert.deepEqual(resumed.buildSessionContext().messages, compacted);
		assert.deepEqual(
			getCurrentTools(compacted).map((value) => value.name),
			["second"],
		);
		assert.equal(Object.hasOwn(compacted[0], "toolsRemoved"), false);
		await resumed.branch(branchPoint);
		assert.deepEqual(getCurrentSystemMessage(resumed.buildSessionContext().messages), head);
		assert.deepEqual(
			getCurrentTools(resumed.buildSessionContext().messages).map((value) => value.name),
			["first", "second"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a chronological system patch between a call and its result does not orphan the real result", () => {
	const assistant = assistantMsg("calling");
	assistant.content = [{ type: "toolCall", id: "call", name: "lookup", arguments: {} }];
	assistant.stopReason = "toolUse";
	const patch: SystemMessage = { role: "system", content: "  update\nupdate  ", timestamp: 2 };
	const result = {
		role: "toolResult" as const,
		toolCallId: "call",
		toolName: "lookup",
		content: [{ type: "text" as const, text: "  result\nresult  " }],
		isError: false,
		timestamp: 3,
	};
	assert.deepEqual(convertToLlm([assistant, patch, result]), [assistant, patch, result]);
});
