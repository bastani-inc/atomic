import assert from "node:assert/strict";
import { test } from "vitest";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = {
	content: Array<{ text: string }>;
	isError: boolean;
	details?: Record<string, unknown>;
};

type Tool = {
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
		group,
	};
}

function fixture(homeGroup = "default") {
	let current = session(homeGroup);
	let tool: Tool | undefined;
	const presenceGroups: string[] = [];
	const joinedGroups: string[] = [];
	let cleared = 0;
	const client = {
		sessionId: current.id,
		async listSessions(): Promise<SessionInfo[]> {
			return [current];
		},
		updatePresence(updates: { group?: string }): boolean {
			if (updates.group !== undefined) {
				current = { ...current, group: updates.group };
				presenceGroups.push(updates.group);
			}
			return true;
		},
		async send() {
			return { id: "message-id", delivered: true };
		},
	};
	const waiterSlot = new ReplyWaiterSlot();
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
			setJoinedGroup(group: string) {
				joinedGroups.push(group);
			},
			clearJoinedGroup() {
				cleared += 1;
			},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
				waiterSlot.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
			hasReplyWaiter: () => waiterSlot.has(),
		} as never,
	);
	assert.ok(tool);
	return {
		tool,
		presenceGroups,
		joinedGroups,
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

test("join changes the broker presence group and leave returns to home", async () => {
	const current = fixture();

	const joined = await current.tool.execute(
		"join",
		{ action: "join", group: "  team-a  " },
		undefined,
		undefined,
		context,
	);
	assert.equal(joined.isError, false, joined.content[0]?.text);
	assert.equal(current.current.group, "team-a");
	assert.deepEqual(current.joinedGroups, ["team-a"]);

	const status = await current.tool.execute("status", { action: "status" }, undefined, undefined, context);
	assert.equal(status.isError, false, status.content[0]?.text);
	assert.match(status.content[0]?.text ?? "", /Group: team-a/);

	const left = await current.tool.execute("leave", { action: "leave" }, undefined, undefined, context);
	assert.equal(left.isError, false, left.content[0]?.text);
	assert.equal(current.current.group, "default");
	assert.deepEqual(current.presenceGroups, ["team-a", "default"]);
	assert.equal(current.cleared, 1);
});

test("join rejects reserved auto-group sentinels without changing presence", async () => {
	const current = fixture();

	const result = await current.tool.execute("join", { action: "join", group: "AUTO" }, undefined, undefined, context);

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /reserved/);
	assert.deepEqual(current.presenceGroups, []);
});

test("leave rejects a reserved home group without sending a broker update", async () => {
	const current = fixture("auto");

	const result = await current.tool.execute("leave", { action: "leave" }, undefined, undefined, context);

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /reserved/);
	assert.deepEqual(current.presenceGroups, []);
});
