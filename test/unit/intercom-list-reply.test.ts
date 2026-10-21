import assert from "node:assert/strict";
import { test } from "vitest";
import { replyToList, type SessionsReply } from "../../packages/intercom/broker/list-reply.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const GROUP = "workflow:5d3a5f1e-0000-4000-8000-000000000001";

function session(id: string, group: string): SessionInfo {
	return { id, group, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 } as SessionInfo;
}

function directory(...infos: SessionInfo[]): ReadonlyMap<string, { readonly info: SessionInfo }> {
	return new Map(infos.map((info) => [info.id, { info }]));
}

test("a group joined while the remote read is pending is not reported as restricted", async () => {
	const requester = session("requester", "other-group");
	const peer = session("peer", GROUP);
	let joined = false;
	let releaseRemote: (sessions: ReturnType<typeof directory>) => void = () => {};
	const replies: SessionsReply[] = [];

	replyToList({
		requestId: "list-1",
		requesterInfo: requester,
		selectedGroup: GROUP,
		localSessions: () => directory(requester, peer),
		remoteSessions: () => new Promise((resolve) => (releaseRemote = resolve)),
		canInspectSelectedGroup: () => joined,
		workflowStages: () => [],
		workflowFutureStages: () => [],
		write: (reply) => replies.push(reply),
	});
	joined = true;
	releaseRemote(directory());
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.restricted, undefined);
	assert.deepEqual(
		replies[0]?.sessions.map((info) => info.id),
		["peer"],
	);
});

test("a peek that stays refused after the remote read is reported as restricted with no rows", async () => {
	const requester = session("requester", "other-group");
	const replies: SessionsReply[] = [];

	replyToList({
		requestId: "list-2",
		requesterInfo: requester,
		selectedGroup: GROUP,
		localSessions: () => directory(requester, session("peer", GROUP)),
		remoteSessions: () => Promise.resolve(directory(session("remote-peer", GROUP))),
		canInspectSelectedGroup: () => false,
		workflowStages: () => [],
		workflowFutureStages: () => [],
		write: (reply) => replies.push(reply),
	});
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(replies[0]?.restricted, true);
	assert.deepEqual(replies[0]?.sessions, []);
});
