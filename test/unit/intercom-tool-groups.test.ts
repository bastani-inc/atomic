import assert from "node:assert/strict";
import { test } from "vitest";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { GroupSummary, SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = {
	content: Array<{ text: string }>;
	isError: boolean;
	details?: Record<string, unknown>;
};

type Tool = {
	description: string;
	parameters: { properties?: { to?: { description?: string } } };
	execute(
		id: string,
		params: { action?: string; group?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

function session(group: string): SessionInfo {
	return {
		id: "self-session-id",
		name: "self",
		cwd: "/worktree",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		status: "idle",
		groups: [group],
		group,
	};
}

function fixture(homeGroup = "default") {
	let current = session(homeGroup);
	let tool: Tool | undefined;
	const joinedGroups: string[][] = [];
	let cleared = 0;
	const leaveCalls: Array<string | undefined> = [];
	const homeResetCalls: string[][] = [];
	const listSessionCalls: Array<string | undefined> = [];
	const client = {
		sessionId: current.id,
		get groups(): string[] {
			return [...(current.groups ?? [current.group ?? "default"])];
		},
		async listSessions(group?: string): Promise<SessionInfo[]> {
			listSessionCalls.push(group);
			const peer = (id: string, membership: string): SessionInfo => ({
				...current,
				id,
				name: id,
				groups: [membership],
				group: membership,
			});
			if (group === "default") return [current];
			if (group !== undefined) return [current, peer(`${group}-peer`, group)];
			return [current, peer("team-a-peer", "team-a"), peer("other-peer", "other")];
		},
		async listGroups(): Promise<GroupSummary[]> {
			return [
				{ group: "build", sessionCount: 1, member: current.groups?.includes("build") ?? false },
				...(current.groups ?? [])
					.filter((group) => group !== "build")
					.map((group) => ({ group, sessionCount: 1, member: true })),
			];
		},
		async joinGroup(group: string): Promise<string[]> {
			const groups = [...new Set([...(current.groups ?? []), group])];
			current = { ...current, groups };
			return groups;
		},
		async leaveGroup(group?: string): Promise<string[]> {
			leaveCalls.push(group);
			const groups =
				group === undefined ? [homeGroup] : (current.groups ?? []).filter((membership) => membership !== group);
			current = { ...current, groups: groups.length > 0 ? groups : ["default"] };
			return current.groups ?? ["default"];
		},
		async updatePresenceAcked(updates: { groups?: string[] }): Promise<string> {
			const groups = updates.groups ?? [homeGroup];
			homeResetCalls.push([...groups]);
			current = { ...current, groups };
			return groups[0] ?? "default";
		},
		updatePresence(): boolean {
			return true;
		},
		async send() {
			return { id: "message-id", delivered: true };
		},
	};
	const waiterSlot = new ReplyWaiterRegistry();
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			appendEntry() {},
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			homeGroup: () => homeGroup,
			setJoinedGroups(groups: readonly string[]) {
				joinedGroups.push([...groups]);
			},
			clearJoinedGroups() {
				cleared += 1;
			},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
				waiterSlot.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return {
		tool,
		joinedGroups,
		leaveCalls,
		listSessionCalls,
		homeResetCalls,
		get cleared() {
			return cleared;
		},
		get current() {
			return current;
		},
	};
}

const context = {
	sessionManager: { getSessionId: () => "atomic-session" },
	hasUI: false,
};

test("heavy tool guidance teaches exact known workflow-stage targets without replacing live sessions", () => {
	const { tool } = fixture();
	const guidance = `${tool.description}\n${tool.parameters.properties?.to?.description ?? ""}`;
	assert.ok(guidance.includes("`workflow:<rootRunId>/<segment>[/<segment>...]`"));
	assert.match(guidance, /sticky for every future\s+stage/i);
	assert.ok(guidance.includes("`workflow:<rootRunId>/**`"));
	assert.match(guidance, /notInKnownSet/);
	assert.match(guidance, /live session/i);
});

test("join is additive and leave without a group returns home", async () => {
	const current = fixture();

	const joined = await current.tool.execute(
		"join",
		{ action: "join", group: "  team-a  " },
		undefined,
		undefined,
		context,
	);
	assert.equal(joined.isError, false, joined.content[0]?.text);
	assert.deepEqual(current.joinedGroups, [["default", "team-a"]]);
	assert.deepEqual(joined.details?.groups, ["default", "team-a"]);

	const status = await current.tool.execute("status", { action: "status" }, undefined, undefined, context);
	assert.equal(status.isError, false, status.content[0]?.text);
	assert.match(status.content[0]?.text ?? "", /Groups: default, team-a/);

	const left = await current.tool.execute("leave", { action: "leave" }, undefined, undefined, context);
	assert.equal(left.isError, false, left.content[0]?.text);
	assert.equal(left.details?.group, "default");
	assert.deepEqual(current.current.groups, ["default"]);
	assert.deepEqual(current.leaveCalls, []);
	assert.deepEqual(current.homeResetCalls, [["default"]]);
	assert.equal(current.cleared, 1);
});

test("status treats a single membership's own group as an unfiltered status request", async () => {
	const current = fixture();

	const result = await current.tool.execute(
		"status",
		{ action: "status", group: "default" },
		undefined,
		undefined,
		context,
	);

	assert.equal(result.isError, false, result.content[0]?.text);
	assert.doesNotMatch(result.content[0]?.text ?? "", /Selected group/);
	assert.deepEqual(result.details, { group: "default", groups: ["default"] });
	assert.deepEqual(current.listSessionCalls, [undefined]);
});

test("list treats a single membership's own group as the unfiltered session list", async () => {
	const current = fixture();

	const result = await current.tool.execute(
		"list",
		{ action: "list", group: "default" },
		undefined,
		undefined,
		context,
	);

	assert.equal(result.isError, false, result.content[0]?.text);
	assert.match(result.content[0]?.text ?? "", /Current session/);
	assert.doesNotMatch(result.content[0]?.text ?? "", /read-only peek/);
	assert.deepEqual(result.details, { group: "default", groups: ["default"] });
	assert.deepEqual(current.listSessionCalls, [undefined]);
});

test("status applies a group filter even when the session belongs to that group", async () => {
	const current = fixture();
	await current.tool.execute("join", { action: "join", group: "team-a" }, undefined, undefined, context);

	const status = await current.tool.execute(
		"status",
		{ action: "status", group: "default" },
		undefined,
		undefined,
		context,
	);

	assert.equal(status.isError, false, status.content[0]?.text);
	assert.match(status.content[0]?.text ?? "", /Active visible sessions: 3/);
	assert.deepEqual(current.homeResetCalls, []);
	assert.match(status.content[0]?.text ?? "", /Selected group \[default\]: 1 session/);
});

test("leave removes only the named membership and keeps the others", async () => {
	const current = fixture();
	await current.tool.execute("join", { action: "join", group: "reviewers" }, undefined, undefined, context);
	await current.tool.execute("join", { action: "join", group: "build" }, undefined, undefined, context);

	const left = await current.tool.execute(
		"leave",
		{ action: "leave", group: "reviewers" },
		undefined,
		undefined,
		context,
	);

	assert.equal(left.isError, false, left.content[0]?.text);
	assert.deepEqual(left.details?.groups, ["default", "build"]);
	assert.deepEqual(current.current.groups, ["default", "build"]);
	assert.deepEqual(current.leaveCalls, ["reviewers"]);
});

test("groups discovers every available group and marks this session's memberships", async () => {
	const current = fixture();
	await current.tool.execute("join", { action: "join", group: "reviewers" }, undefined, undefined, context);

	const result = await current.tool.execute("groups", { action: "groups" }, undefined, undefined, context);

	assert.equal(result.isError, false, result.content[0]?.text);
	assert.match(result.content[0]?.text ?? "", /build.*1 session/);
	assert.match(result.content[0]?.text ?? "", /default.*member/);
	assert.match(result.content[0]?.text ?? "", /reviewers.*member/);
});

test("join rejects reserved auto-group sentinels without changing membership", async () => {
	const current = fixture();

	const result = await current.tool.execute("join", { action: "join", group: "AUTO" }, undefined, undefined, context);

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /reserved/);
	assert.deepEqual(current.current.groups, ["default"]);
});

test("leave rejects a reserved home group without sending a broker update", async () => {
	const current = fixture("auto");

	const result = await current.tool.execute("leave", { action: "leave" }, undefined, undefined, context);

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /reserved/);
	assert.deepEqual(current.leaveCalls, []);
});
