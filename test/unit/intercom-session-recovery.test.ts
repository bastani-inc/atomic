import assert from "node:assert/strict";
import type { PendingRecoveryDelivery } from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	hasIntercomHistory,
	planIntercomRecoveryReplay,
	waitForIntercomPeer,
} from "../../packages/intercom/session-recovery.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

function peer(name: string, id = `${name}-broker-id`): SessionInfo {
	return { id, name, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };
}

function card(
	entryId: string,
	from: SessionInfo,
	text: string,
	timestamp = Date.UTC(2026, 9, 19, 7, 0, 0),
): PendingRecoveryDelivery {
	return {
		entryId,
		customType: "intercom_message",
		content: `**📨 From ${from.name}**\n\n${text}`,
		details: { from, message: { id: `${entryId}-message`, timestamp, content: { text } }, bodyText: text },
		timestamp: new Date(timestamp).toISOString(),
		stageAdmissionKey: `intercom:${entryId}-message`,
		delivery: "steer",
	};
}

test("interrupted Intercom cards replay only for senders that are live again after resume (#3760)", () => {
	const restored = peer("subagent-worker-run1-1", "new-broker-id");
	const live = card("live", peer("subagent-worker-run1-1", "old-broker-id"), "lane 1 finished");
	const gone = card("gone", peer("subagent-worker-run1-2"), "please edit scripts/deploy.sh");
	const goneAgain = card("gone-2", peer("subagent-worker-run1-2"), "second stale note");
	const plan = planIntercomRecoveryReplay([live, gone, goneAgain], [restored]);
	assert.deepEqual(plan.decisions, [
		{ entryId: "live", action: "replay" },
		{ entryId: "gone", action: "drop" },
		{ entryId: "gone-2", action: "drop" },
	]);
	assert.equal(plan.notices?.length, 1);
	const notice = plan.notices![0]!;
	assert.match(notice, /Intercom peer `subagent-worker-run1-2` is gone/);
	assert.match(notice, /2 message\(s\) it sent before the restart were not replayed as new turns/);
	assert.match(notice, /Do not reply to it or send it new messages/);
	assert.match(notice, /please edit scripts\/deploy\.sh/);
	assert.match(notice, /second stale note/);
});

test("when Intercom is unreachable on resume, interrupted cards are deferred, not dropped, and their senders are not called gone (#3760)", () => {
	const plan = planIntercomRecoveryReplay(
		[
			card("unknown", peer("worker"), "status"),
			card("unknown-2", peer("worker"), "second status"),
			card("other", peer("reviewer"), "review notes"),
		],
		undefined,
	);
	assert.deepEqual(plan.decisions, [
		{ entryId: "unknown", action: "defer" },
		{ entryId: "unknown-2", action: "defer" },
		{ entryId: "other", action: "defer" },
	]);
	assert.equal(plan.notices?.length, 1, "one notice covers every deferred delivery");
	const notice = plan.notices![0]!;
	assert.match(notice, /Intercom could not be reached/);
	assert.match(notice, /3 interrupted Intercom deliveries/);
	assert.match(notice, /deferred/);
	assert.match(notice, /`worker`/);
	assert.match(notice, /`reviewer`/);
	assert.doesNotMatch(notice, /\bgone\b/);
	assert.doesNotMatch(notice, /Do not reply/);
});

test("cards from a subagent that was relaunched but has not re-registered yet are deferred, not dropped, and it is not called gone (#3760)", () => {
	const relaunched = [{ name: "subagent-worker-run1-1", ids: ["child-atomic-session-id", "old-broker-id"] }];
	const byName = card("by-name", peer("Subagent-Worker-Run1-1", "some-other-id"), "lane 1 progress");
	const byPreviousId = card("by-id", peer("renamed-since", "old-broker-id"), "lane 1 finished");
	const gone = card("gone", peer("subagent-worker-run1-2"), "stale instruction");
	const live = card("live", peer("subagent-worker-run1-3", "live-broker-id"), "all good");
	const plan = planIntercomRecoveryReplay(
		[byName, byPreviousId, gone, live],
		[peer("subagent-worker-run1-3", "live-broker-id")],
		relaunched,
	);
	assert.deepEqual(plan.decisions, [
		{ entryId: "by-name", action: "defer" },
		{ entryId: "by-id", action: "defer" },
		{ entryId: "gone", action: "drop" },
		{ entryId: "live", action: "replay" },
	]);
	const notices = plan.notices ?? [];
	assert.equal(notices.length, 3, "one notice per kind of outcome: gone, and the two senders still reconnecting");
	assert.equal(notices.filter((notice) => /is gone/.test(notice)).length, 1);
	assert.match(notices.find((notice) => /is gone/.test(notice)) ?? "", /`subagent-worker-run1-2`/);
	const reconnecting = notices.filter((notice) => /has not reconnected to Intercom yet/.test(notice));
	assert.equal(reconnecting.length, 2);
	for (const notice of reconnecting) {
		assert.match(notice, /was relaunched after the restart/);
		assert.match(notice, /deferred: not replayed now and not discarded/);
		assert.match(notice, /It is not gone/);
		assert.doesNotMatch(notice, /launch a fresh subagent/);
	}
});

test("a relaunched subagent that registered in time replays and one that is neither live nor relaunched is gone (#3760)", () => {
	const plan = planIntercomRecoveryReplay(
		[
			card("registered", peer("subagent-worker-run1-1", "reclaimed-id"), "done"),
			card("other", peer("subagent-worker-run1-2"), "stale"),
		],
		[peer("subagent-worker-run1-1", "reclaimed-id")],
		[],
	);
	assert.deepEqual(plan.decisions, [
		{ entryId: "registered", action: "replay" },
		{ entryId: "other", action: "drop" },
	]);
});

test("Intercom leaves other recovery deliveries and local subagent relays to their owners (#3760)", () => {
	const relay = card("relay", { ...peer("subagent-result"), id: "subagent-result" }, "result text");
	const other: PendingRecoveryDelivery = { ...card("heartbeat", peer("x"), "beat"), customType: "workflow-heartbeat" };
	assert.deepEqual(planIntercomRecoveryReplay([relay, other], []), { decisions: [] });
});

test("a resumed session that used Intercom re-registers, a session that never did stays lazy (#3760)", async () => {
	const quiet = SessionManager.inMemory("/repo");
	await quiet.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	assert.equal(hasIntercomHistory(quiet.getEntries()), false);
	const coordinated = SessionManager.inMemory("/repo");
	await coordinated.appendCustomEntry("subagent-child", { childId: "run:0" });
	assert.equal(hasIntercomHistory(coordinated.getEntries()), true);
});

test("waiting for a restored peer resolves once it registers and reports a peer that never returns (#3760)", async () => {
	let polls = 0;
	const client = {
		async listSessions(group?: string) {
			assert.equal(group, "lane-group");
			polls += 1;
			return polls >= 3 ? [peer("Subagent-Worker-Run1-1")] : [peer("other")];
		},
	};
	assert.equal(
		await waitForIntercomPeer(client, { name: "subagent-worker-run1-1", group: "lane-group", timeoutMs: 5_000 }),
		true,
	);
	assert.equal(polls, 3);
	const never = { listSessions: async () => [peer("other")] };
	assert.equal(await waitForIntercomPeer(never, { name: "gone", timeoutMs: 0 }), false);
});
