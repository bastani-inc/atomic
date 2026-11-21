import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { type ReplyRouteFacts, replyRouteVerdict } from "../../packages/intercom/broker/reply-routes.js";
import { closeRelaunchedChildAsks } from "../../packages/intercom/finished-asks.js";
import {
	INTERCOM_ASK_CLOSED_ENTRY,
	ReplyTracker,
	restorePendingInboundAsks,
} from "../../packages/intercom/reply-tracker.js";
import type { ReplyRouteVerdict } from "../../packages/intercom/session-recovery.js";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { answerRelaunchedAskRequests } from "../../packages/subagents/src/runs/foreground/intercom-children.js";
import type { SubagentChildRecord } from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";

/**
 * After a restart, an ask a subagent's earlier run sent its owner can no longer be answered when the restart relaunched
 * the subagent and its route did not come back with it: the broker refuses every reply to it. The owner asks the broker
 * how it would take a reply to each such ask, and closes those it would refuse, as a refused reply closes one (#6168).
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function child(index: number): SessionInfo {
	return {
		id: `child-intercom-id-${index}`,
		name: `subagent-worker-run1-${index + 1}`,
		cwd: "/p",
		model: "m",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
}

function relaunchedRecord(index: number): SubagentChildRecord {
	return {
		version: 1,
		childId: `run1:${index}`,
		runId: "run1",
		index,
		agent: "worker",
		state: "running",
		cwd: "/repo",
		owner: { kind: "session", sessionId: "owner" },
		intercomTarget: `subagent-worker-run1-${index + 1}`,
	};
}

function eventBus() {
	const handlers = new Map<string, (payload: unknown) => void>();
	return {
		on(eventName: string, handler: (payload: unknown) => void) {
			handlers.set(eventName, handler);
			return () => handlers.delete(eventName);
		},
		emit(eventName: string, payload: unknown) {
			handlers.get(eventName)?.(payload);
		},
	};
}

/** An owner holding one unanswered ask from each of `senders`; Subagents relaunched the children in `relaunched`. */
async function owner(senders: readonly SessionInfo[], relaunched: readonly SubagentChildRecord[]) {
	const manager = SessionManager.inMemory("/repo");
	await manager.appendCustomEntry("intercom_session_identity", {
		sessionId: manager.getSessionId(),
		intercomSessionId: "owner-intercom-id",
	});
	for (const [index, from] of senders.entries()) {
		const message = {
			id: `ask-${index}`,
			timestamp: 1,
			expectsReply: true,
			...(from.name?.startsWith("subagent-") === true
				? { source: { subagentRunId: "run1", subagentIndex: Number(from.id.at(-1)) } }
				: {}),
			content: { text: `question ${index}` },
		};
		await manager.appendCustomMessageEntry("intercom_message", message.content.text, true, { from, message }, true);
	}
	const events = eventBus();
	cleanups.push(
		answerRelaunchedAskRequests(
			events,
			() => true,
			() => relaunched,
		),
	);
	const pi = {
		events,
		appendEntry: async (customType: string, data: unknown) =>
			void (await manager.appendCustomEntry(customType, data)),
	};
	return { manager, pi, ctx: { sessionManager: manager } };
}

function pendingIds(manager: SessionManager): string[] {
	const tracker = new ReplyTracker();
	restorePendingInboundAsks(tracker, manager.getBranch(), manager.getSessionId());
	return tracker.listPending().map((context) => context.message.id);
}

describe("asks of a subagent this restart relaunched", () => {
	test("an ask whose reply the broker would refuse is closed and named once in the recovery notice", async () => {
		const { manager, pi, ctx } = await owner([child(0)], [relaunchedRecord(0)]);
		const asked: Array<readonly { replyTo: string; to: string }[]> = [];

		const notices = await closeRelaunchedChildAsks(pi, ctx, async (replies) => {
			asked.push(replies);
			return ["refused"];
		});

		assert.deepEqual(asked, [[{ replyTo: "ask-0", to: "child-intercom-id-0" }]]);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /Intercom would refuse a reply to it now/);
		assert.match(notices[0]!, /ask-0 from `subagent-worker-run1-1`/);
		assert.deepEqual(pendingIds(manager), []);
		assert.deepEqual(
			manager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === INTERCOM_ASK_CLOSED_ENTRY)
				.map((entry) => (entry as { data: unknown }).data),
			[{ messageId: "ask-0", reason: "route-expired" }],
		);
	});

	const kept: ReadonlyArray<readonly [string, ReplyRouteVerdict]> = [
		["would route", "deliver"],
		["cannot tell", "unknown"],
	];
	for (const [how, verdict] of kept)
		test(`an ask whose reply the broker ${how} stays pending`, async () => {
			const { manager, pi, ctx } = await owner([child(0)], [relaunchedRecord(0)]);

			assert.deepEqual(await closeRelaunchedChildAsks(pi, ctx, async () => [verdict]), []);
			assert.deepEqual(pendingIds(manager), ["ask-0"]);
		});

	test("asks of a subagent the restart did not relaunch, or of another session, are never asked about or closed", async () => {
		const peer: SessionInfo = { ...child(5), name: "another-session" };
		const { manager, pi, ctx } = await owner([child(0), child(1), peer], [relaunchedRecord(1)]);
		const asked: string[] = [];

		await closeRelaunchedChildAsks(pi, ctx, async (replies) => {
			asked.push(...replies.map((reply) => reply.replyTo));
			return replies.map(() => "refused");
		});

		assert.deepEqual(asked, ["ask-1"]);
		assert.deepEqual(pendingIds(manager), ["ask-0", "ask-2"]);
	});

	test("without asks of a relaunched subagent the broker is not asked at all", async () => {
		const { pi, ctx } = await owner([child(0)], []);
		let asked = false;

		await closeRelaunchedChildAsks(pi, ctx, async (replies) => {
			asked = true;
			return replies.map(() => "refused");
		});

		assert.equal(asked, false);
	});

	test("a close that cannot be saved leaves the ask pending", async () => {
		const { manager, pi, ctx } = await owner([child(0)], [relaunchedRecord(0)]);
		const failing = {
			...pi,
			appendEntry: async () => {
				throw new Error("disk full");
			},
		};

		assert.deepEqual(await closeRelaunchedChildAsks(failing, ctx, async () => ["refused"]), []);
		assert.deepEqual(pendingIds(manager), ["ask-0"]);
	});
});

describe("how the broker would take a reply", () => {
	const routed: ReplyRouteFacts = {
		acrossMachines: false,
		keptRouteTakes: false,
		askerConnected: true,
		correlated: false,
		restoring: false,
		reservedOrWaking: false,
	};
	const cases: ReadonlyArray<readonly [string, Partial<ReplyRouteFacts>, ReplyRouteVerdict]> = [
		["no pending question authorizes it", {}, "refused"],
		["a pending question authorizes it", { correlated: true }, "deliver"],
		["a kept route its owner reserved takes it", { keptRouteTakes: true, askerConnected: false }, "deliver"],
		["its asker is reserved as released or being woken", { reservedOrWaking: true }, "deliver"],
		["routes are still being restored", { restoring: true }, "unknown"],
		["its asker is not connected here", { askerConnected: false }, "unknown"],
		["replies are routed across machines", { acrossMachines: true, correlated: true }, "unknown"],
	];
	for (const [when, facts, verdict] of cases)
		test(`when ${when}: ${verdict}`, () => {
			assert.equal(replyRouteVerdict({ ...routed, ...facts }), verdict);
		});
});
