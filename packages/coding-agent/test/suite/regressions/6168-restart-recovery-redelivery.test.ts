import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../../src/core/agent-session-persistent-custom-messages.js";
import type { VerbatimCompactionDetails } from "../../../src/core/compaction/compaction-types.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

const COMPACTION_DETAILS: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 7,
	parameters: { query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	form: "compacted",
};

const peer = {
	id: "peer-session",
	name: "subagent-worker-1",
	cwd: "/p",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

/** A card the model already took in a turn: its reconciliation is saved right after it, as a turn saves it. */
async function shownCard(manager: SessionManager, details: object, key: string): Promise<string> {
	const id = await manager.appendCustomMessageEntry(
		"intercom_message",
		"card text",
		true,
		details,
		true,
		{
			delivery: "steer",
		},
		key,
	);
	await manager.appendCustomMessageEntry(
		PROTECTED_RECONCILIATION_CUSTOM_TYPE,
		"card text",
		false,
		{ protectedReconciliationOf: id },
		true,
	);
	await manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "acted on it" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 3,
	});
	return id;
}

async function compacted(manager: SessionManager): Promise<void> {
	await manager.appendCompaction("summary", null, 100, COMPACTION_DETAILS);
	await manager.appendMessage(userMsg("after the compaction"));
}

describe("restart recovery after a compaction (#6168)", () => {
	it("does not offer again a reply card the session already took in a turn (#6168)", async () => {
		const manager = SessionManager.inMemory();
		await manager.appendMessage(userMsg("earlier work"));
		await manager.appendCustomEntry("intercom_ask", {
			askId: "ask-1",
			sessionId: manager.getSessionId(),
			to: peer.name,
			recipientId: peer.id,
			question: "status?",
			askedAt: 1,
		});
		const cardId = await shownCard(
			manager,
			{ from: peer, message: { id: "reply-1", timestamp: 2, replyTo: "ask-1", content: { text: "done" } } },
			"intercom:reply-1",
		);
		await compacted(manager);
		// The window still holds the reply card, which tells the ask was answered, but not its reconciliation.
		assert.ok(manager.getBranch().some((entry) => entry.id === cardId));

		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("a second turn for an old reply")]);
		await harness.session.bindExtensions({});

		const report = await harness.session.startPendingRecovery("resume");

		assert.deepEqual(report, { replayed: 0, dropped: 0, completions: 0, notices: [] });
		assert.equal(harness.faux.state.callCount, 0);
	});

	it("does not offer again an unanswered ask card the session already took in a turn (#6168)", async () => {
		const manager = SessionManager.inMemory();
		await manager.appendMessage(userMsg("earlier work"));
		await manager.appendCustomEntry("intercom_session_identity", {
			sessionId: manager.getSessionId(),
			intercomSessionId: "intercom-owner",
		});
		await shownCard(
			manager,
			{ from: peer, message: { id: "question-1", timestamp: 2, expectsReply: true, content: { text: "which?" } } },
			"intercom:question-1",
		);
		await compacted(manager);

		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("a second turn for an old question")]);
		await harness.session.bindExtensions({});

		const report = await harness.session.startPendingRecovery("resume");

		assert.deepEqual(report, { replayed: 0, dropped: 0, completions: 0, notices: [] });
		assert.equal(harness.faux.state.callCount, 0);
	});

	it("still offers a card whose turn never ran, after a compaction (#6168)", async () => {
		const manager = SessionManager.inMemory();
		await manager.appendMessage(userMsg("earlier work"));
		await manager.appendCustomEntry("intercom_ask", {
			askId: "ask-1",
			sessionId: manager.getSessionId(),
			to: peer.name,
			recipientId: peer.id,
			question: "status?",
			askedAt: 1,
		});
		await manager.appendCustomMessageEntry(
			"intercom_message",
			"UNSHOWN-REPLY",
			true,
			{ from: peer, message: { id: "reply-1", timestamp: 2, replyTo: "ask-1", content: { text: "done" } } },
			true,
			{ delivery: "steer" },
			"intercom:reply-1",
		);
		await compacted(manager);

		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("took the reply")]);
		await harness.session.bindExtensions({});

		const report = await harness.session.startPendingRecovery("resume");

		assert.equal(report.replayed, 1);
		assert.equal(harness.faux.state.callCount, 1);
	});
});
