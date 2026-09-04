import assert from "node:assert/strict";
import { test } from "vitest";
import type { BrokerMessage, ClientMessage, SessionInfo } from "../../packages/intercom/types.js";

const BASE_SESSION = {
	id: "session-1",
	cwd: "/repo",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
} as const;

test("the session protocol carries a set of group memberships", () => {
	const session: SessionInfo = { ...BASE_SESSION, groups: ["default", "reviewers"] };
	const presence: ClientMessage = { type: "presence", groups: ["default", "reviewers"] };
	const registration: ClientMessage = {
		type: "register",
		session: {
			cwd: BASE_SESSION.cwd,
			model: BASE_SESSION.model,
			pid: BASE_SESSION.pid,
			startedAt: BASE_SESSION.startedAt,
			lastActivity: BASE_SESSION.lastActivity,
			groups: ["default", "reviewers"],
		},
	};

	assert.deepEqual(session.groups, ["default", "reviewers"]);
	assert.deepEqual(presence.groups, ["default", "reviewers"]);
	assert.deepEqual(registration.session.groups, ["default", "reviewers"]);
});

test("logical targets are optional retry metadata and preserve legacy send frames", () => {
	const legacy: ClientMessage = {
		type: "send",
		to: "resolved-session-id",
		message: { id: "legacy", timestamp: 1, content: { text: "legacy" } },
	};
	const retryAware: ClientMessage = {
		type: "send",
		to: "resolved-session-id",
		logicalTarget: "caller-issued name  ",
		requirePendingReply: true,
		message: { id: "retry", timestamp: 1, replyTo: "question", content: { text: "retry" } },
	};
	assert.equal("logicalTarget" in legacy, false);
	assert.equal(retryAware.logicalTarget, "caller-issued name  ");
	assert.equal(retryAware.requirePendingReply, true);
});

test("legacy single-group clients remain valid protocol clients", () => {
	const session: SessionInfo = { ...BASE_SESSION, group: "reviewers" };
	const registration: ClientMessage = {
		type: "register",
		session: {
			cwd: session.cwd,
			model: session.model,
			pid: session.pid,
			startedAt: session.startedAt,
			lastActivity: session.lastActivity,
			group: session.group,
		},
	};
	const presence: ClientMessage = { type: "presence", group: "reviewers" };

	assert.equal(session.group, "reviewers");
	assert.equal(registration.session.group, "reviewers");
	assert.equal(presence.group, "reviewers");
});

test("the broker protocol carries membership commands and all-group summaries", () => {
	const join: ClientMessage = { type: "join_group", requestId: "join", group: "reviewers" };
	const leave: ClientMessage = { type: "leave_group", requestId: "leave", group: "reviewers" };
	const leaveHome: ClientMessage = { type: "leave_group", requestId: "home" };
	const listGroups: ClientMessage = { type: "list_groups", requestId: "groups" };
	const summaries: BrokerMessage = {
		type: "groups",
		requestId: "groups",
		groups: [{ group: "reviewers", sessionCount: 2, member: true }],
	};

	assert.equal(join.type, "join_group");
	assert.equal(leave.type, "leave_group");
	assert.equal(leaveHome.type, "leave_group");
	assert.equal(listGroups.type, "list_groups");
	assert.deepEqual(summaries.groups, [{ group: "reviewers", sessionCount: 2, member: true }]);
});
