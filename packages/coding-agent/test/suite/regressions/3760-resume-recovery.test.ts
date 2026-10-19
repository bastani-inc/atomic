import assert from "node:assert/strict";
import { type Context, fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../../src/core/agent-session-persistent-custom-messages.js";
import {
	SESSION_RECOVERY_NOTICE_TYPE,
	SESSION_RECOVERY_REPLAY_TYPE,
} from "../../../src/core/agent-session-recovery.js";
import type { PendingRecoveryDelivery, SessionRecoveryReason } from "../../../src/core/extensions/index.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function track(harness: Promise<Harness>): Promise<Harness> {
	const created = await harness;
	harnesses.push(created);
	return created;
}

async function interruptedSession(cards: Array<{ text: string; key: string; from: string }>): Promise<SessionManager> {
	const manager = SessionManager.inMemory();
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "earlier work" }], timestamp: 1 });
	for (const card of cards) {
		await manager.appendCustomMessageEntry(
			"intercom_message",
			card.text,
			true,
			{ from: { name: card.from } },
			true,
			{ delivery: "steer" },
			card.key,
		);
	}
	return manager;
}

function contextText(context: Context): string {
	return context.messages.map((message) => getMessageText(message)).join("\n");
}

describe("resume recovery (#3760)", () => {
	it("binding a resumed session never starts a turn for interrupted deliveries (#3760)", async () => {
		const sessionManager = await interruptedSession([{ text: "STALE-WORKER-NOTE", key: "intercom:1", from: "w1" }]);
		const harness = await track(createHarness({ sessionManager }));
		harness.setResponses([fauxAssistantMessage("hidden turn")]);

		await harness.session.bindExtensions({});
		await harness.session.bindExtensions({});

		assert.equal(harness.faux.state.callCount, 0);
		assert.equal(harness.eventsOfType("agent_start").length, 0);
		assert.equal(harness.session.agent.hasQueuedMessages(), false);
	});

	it("a startup reload before recovery still runs no hidden turn (#3760)", async () => {
		const sessionManager = await interruptedSession([{ text: "STALE-WORKER-NOTE", key: "intercom:1", from: "w1" }]);
		const harness = await track(createHarness({ sessionManager }));
		harness.setResponses([fauxAssistantMessage("hidden turn")]);

		await harness.session.bindExtensions({});
		await harness.session.reload({ reason: "startup" });

		assert.equal(harness.faux.state.callCount, 0);
		assert.equal(harness.eventsOfType("agent_start").length, 0);
	});

	it("startPendingRecovery replays a live delivery in a visible turn, once (#3760)", async () => {
		const sessionManager = await interruptedSession([{ text: "LIVE-WORKER-NOTE", key: "intercom:2", from: "w2" }]);
		const harness = await track(createHarness({ sessionManager }));
		const contexts: Context[] = [];
		harness.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("answered the worker");
			},
		]);
		await harness.session.bindExtensions({});

		const [report, again] = await Promise.all([
			harness.session.startPendingRecovery("resume"),
			harness.session.startPendingRecovery("resume"),
		]);

		assert.equal(report, again);
		assert.deepEqual(report, { replayed: 1, dropped: 0, completions: 0, notices: [] });
		assert.equal(harness.faux.state.callCount, 1);
		assert.match(contextText(contexts[0]!), /LIVE-WORKER-NOTE/);
		const replayCard = harness
			.eventsOfType("message_end")
			.find((event) => event.message.role === "custom" && event.message.customType === SESSION_RECOVERY_REPLAY_TYPE);
		assert.ok(replayCard, "the replay is announced in the transcript");
		const agentStart = harness.events.findIndex((event) => event.type === "agent_start");
		assert.ok(harness.events.indexOf(replayCard) < agentStart, "the announcement precedes the recovery turn");
		assert.doesNotMatch(contextText(contexts[0]!), /Replaying 1 interrupted delivery/);
		assert.equal(
			sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
				).length,
			1,
		);
	});

	it("dropped deliveries and notices become one non-triggering message, never offered again (#3760)", async () => {
		const sessionManager = await interruptedSession([
			{ text: "GONE-WORKER-NOTE", key: "intercom:3", from: "gone-worker" },
			{ text: "LIVE-WORKER-NOTE", key: "intercom:4", from: "live-worker" },
		]);
		const seen: Array<{ type: string; reason: SessionRecoveryReason; pending?: readonly PendingRecoveryDelivery[] }> =
			[];
		const harness = await track(
			createHarness({
				sessionManager,
				extensionFactories: [
					(pi) => {
						pi.on("session_recovery_restore", (event) => {
							seen.push({ type: event.type, reason: event.reason });
							return { notices: ["Subagent gone-worker could not be restored and is gone."] };
						});
						pi.on("session_recovery_replay", (event) => {
							seen.push({ type: event.type, reason: event.reason, pending: event.pending });
							const gone = event.pending.find((entry) => entry.stageAdmissionKey === "intercom:3");
							return {
								decisions: gone ? [{ entryId: gone.entryId, action: "drop" }] : [],
								notices: ["1 message from gone-worker was not replayed."],
							};
						});
					},
				],
			}),
		);
		const contexts: Context[] = [];
		harness.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("answered the live worker");
			},
		]);
		await harness.session.bindExtensions({});

		const report = await harness.session.startPendingRecovery("resume");

		assert.deepEqual(
			seen.map((event) => [event.type, event.reason]),
			[
				["session_recovery_restore", "resume"],
				["session_recovery_replay", "resume"],
			],
		);
		const pending = seen[1]!.pending!;
		assert.deepEqual(
			pending.map((entry) => [entry.customType, entry.stageAdmissionKey, entry.delivery, entry.details]),
			[
				["intercom_message", "intercom:3", "steer", { from: { name: "gone-worker" } }],
				["intercom_message", "intercom:4", "steer", { from: { name: "live-worker" } }],
			],
		);
		assert.equal(report.replayed, 1);
		assert.equal(report.dropped, 1);
		assert.equal(harness.faux.state.callCount, 1);
		const modelText = contextText(contexts[0]!);
		assert.doesNotMatch(modelText, /GONE-WORKER-NOTE/);
		assert.match(modelText, /LIVE-WORKER-NOTE/);
		assert.match(modelText, /Subagent gone-worker could not be restored and is gone\./);

		const notices = sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_RECOVERY_NOTICE_TYPE);
		assert.equal(notices.length, 1);
		const notice = notices[0]!;
		assert.ok(notice.type === "custom_message");
		assert.equal(notice.display, true);
		assert.notEqual(notice.excludeFromContext, true);
		assert.match(String(notice.content), /could not be restored and is gone[\s\S]*was not replayed/);

		const reopened = await track(createHarness({ sessionManager }));
		reopened.setResponses([fauxAssistantMessage("unexpected replay")]);
		await reopened.session.bindExtensions({});
		const later = await reopened.session.startPendingRecovery("resume");
		assert.deepEqual(later, { replayed: 0, dropped: 0, completions: 0, notices: [] });
		assert.equal(reopened.faux.state.callCount, 0);
	});

	it("dropping every delivery starts no turn at all (#3760)", async () => {
		const sessionManager = await interruptedSession([{ text: "GONE-WORKER-NOTE", key: "intercom:5", from: "gone" }]);
		const harness = await track(
			createHarness({
				sessionManager,
				extensionFactories: [
					(pi) => {
						pi.on("session_recovery_replay", (event) => ({
							decisions: event.pending.map((entry) => ({ entryId: entry.entryId, action: "drop" as const })),
							notices: ["Worker gone is gone."],
						}));
					},
				],
			}),
		);
		harness.setResponses([fauxAssistantMessage("unexpected turn")]);
		await harness.session.bindExtensions({});

		const report = await harness.session.startPendingRecovery("resume");

		assert.deepEqual(report, { replayed: 0, dropped: 1, completions: 0, notices: ["Worker gone is gone."] });
		assert.equal(harness.faux.state.callCount, 0);
		assert.equal(harness.eventsOfType("agent_start").length, 0);
		const dropped = sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE);
		assert.ok(dropped?.type === "custom_message");
		assert.equal(dropped.excludeFromContext, true);
		assert.equal(dropped.display, false);
	});

	it("a completion intent left by an earlier process is shown without starting a turn (#3760)", async () => {
		const sessionManager = SessionManager.inMemory();
		await sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "launch" }], timestamp: 1 });
		await sessionManager.appendCustomEntry("task-completion-intent", {
			completionId: "earlier-completion",
			ownerId: "earlier-owner",
			taskId: "earlier-task",
			terminalSequence: 3,
			result: { kind: "completed" },
			display: false,
		});
		const harness = await track(createHarness({ sessionManager }));
		harness.setResponses([fauxAssistantMessage("unexpected turn")]);
		await harness.session.bindExtensions({});
		harness.session.getAgentTaskHost();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(
			sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === "task-completion"),
			false,
			"creating the task host never flushes an earlier process's intents",
		);

		const report = await harness.session.startPendingRecovery("startup");

		assert.equal(report.completions, 1);
		assert.equal(harness.faux.state.callCount, 0);
		assert.equal(harness.eventsOfType("agent_start").length, 0);
		const card = sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom_message" && entry.customType === "task-completion");
		assert.ok(card?.type === "custom_message");
		assert.equal(card.display, true);
		assert.equal(card.protectedReconciliation, undefined);
		assert.ok(
			sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "task-completion-ack"),
		);
	});
});
