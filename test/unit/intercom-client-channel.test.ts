import assert from "node:assert/strict";
import { test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

test("client preserves the supervisor channel on inbound broker messages", () => {
	const client = new IntercomClient();
	const internals = client as unknown as {
		_sessionId: string;
		handleBrokerMessage(message: unknown): void;
	};
	internals._sessionId = "parent";
	const from: SessionInfo = {
		id: "child",
		name: "reviewer",
		cwd: "/repo",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		group: "reviewers",
	};
	const message: Message = { id: "update-1", timestamp: 1, content: { text: "progress" } };
	let receivedChannel: string | undefined;
	client.on("message", (_from: SessionInfo, _message: Message, channel?: string) => {
		receivedChannel = channel;
	});

	internals.handleBrokerMessage({ type: "message", from, message, channel: "supervisor" });

	assert.equal(receivedChannel, "supervisor");
});

test("client uses the broker-confirmed supervisor id after registration", () => {
	const client = new IntercomClient();
	const internals = client as unknown as { handleBrokerMessage(message: unknown): void };
	internals.handleBrokerMessage({
		type: "registered",
		sessionId: "child-session",
		supervisorSessionId: "current-supervisor-session",
	});

	assert.equal(client.supervisorSessionId, "current-supervisor-session");
});

test("client sends runtime group changes as presence updates", () => {
	const client = new IntercomClient();
	const frames: Buffer[] = [];
	const internals = client as unknown as {
		socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
		_sessionId: string;
	};
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			frames.push(data);
			return true;
		},
	};
	internals._sessionId = "self";

	assert.equal(client.updatePresence({ group: "named" }), true);
	assert.deepEqual(JSON.parse(frames[0]!.subarray(4).toString("utf8")), {
		type: "presence",
		group: "named",
	});
	assert.deepEqual(client.groups, ["named"]);
});

test("client resolves acknowledged runtime group changes", async () => {
	const client = new IntercomClient();
	const frames: Buffer[] = [];
	const internals = client as unknown as {
		socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
		_sessionId: string;
		handleBrokerMessage(message: unknown): void;
	};
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			frames.push(data);
			return true;
		},
	};
	internals._sessionId = "self";

	const result = client.updatePresenceAcked({ group: "named" });
	const frame = JSON.parse(frames[0]!.subarray(4).toString("utf8")) as { requestId: string };
	assert.equal(typeof frame.requestId, "string");
	internals.handleBrokerMessage({ type: "presence_ack", requestId: frame.requestId, group: "named" });
	assert.equal(await result, "named");
	assert.deepEqual(client.groups, ["named"]);
});

test("client preserves all memberships from an acknowledged multi-group presence update", async () => {
	const client = new IntercomClient();
	const frames: Buffer[] = [];
	const internals = client as unknown as {
		socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
		_sessionId: string;
		handleBrokerMessage(message: unknown): void;
	};
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			frames.push(data);
			return true;
		},
	};
	internals._sessionId = "self";

	const result = client.updatePresenceAcked({ groups: ["alpha", "beta"] });
	const frame = JSON.parse(frames[0]!.subarray(4).toString("utf8")) as { requestId: string };
	internals.handleBrokerMessage({ type: "presence_ack", requestId: frame.requestId, group: "alpha" });

	assert.equal(await result, "alpha");
	assert.deepEqual(client.groups, ["alpha", "beta"]);
});

test("client joins groups additively and tracks the acknowledged membership set", async () => {
	const client = new IntercomClient();
	const frames: Buffer[] = [];
	const internals = client as unknown as {
		socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
		_sessionId: string;
		handleBrokerMessage(message: unknown): void;
	};
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			frames.push(data);
			return true;
		},
	};
	internals._sessionId = "self";

	const joined = client.joinGroup("reviewers");
	const frame = JSON.parse(frames[0]!.subarray(4).toString("utf8")) as { requestId: string };
	assert.deepEqual(
		{ ...frame, requestId: "request" },
		{
			type: "join_group",
			requestId: "request",
			group: "reviewers",
		},
	);
	internals.handleBrokerMessage({
		type: "membership_ack",
		requestId: frame.requestId,
		groups: ["default", "reviewers"],
	});

	assert.deepEqual(await joined, ["default", "reviewers"]);
	assert.deepEqual(client.groups, ["default", "reviewers"]);
});

test("client leaves one group while retaining its other memberships", async () => {
	const client = new IntercomClient();
	const frames: Buffer[] = [];
	const internals = client as unknown as {
		socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
		_sessionId: string;
		handleBrokerMessage(message: unknown): void;
	};
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			frames.push(data);
			return true;
		},
	};
	internals._sessionId = "self";

	const left = client.leaveGroup("reviewers");
	const frame = JSON.parse(frames[0]!.subarray(4).toString("utf8")) as { requestId: string };
	assert.deepEqual(
		{ ...frame, requestId: "request" },
		{
			type: "leave_group",
			requestId: "request",
			group: "reviewers",
		},
	);
	internals.handleBrokerMessage({ type: "membership_ack", requestId: frame.requestId, groups: ["default", "build"] });

	assert.deepEqual(await left, ["default", "build"]);
	assert.deepEqual(client.groups, ["default", "build"]);
});

test("client lists every broker group with membership markers", async () => {
	const client = new IntercomClient();
	const frames: Buffer[] = [];
	const internals = client as unknown as {
		socket: { destroyed: boolean; writableEnded: boolean; writable: boolean; write(data: Buffer): boolean };
		_sessionId: string;
		handleBrokerMessage(message: unknown): void;
	};
	internals.socket = {
		destroyed: false,
		writableEnded: false,
		writable: true,
		write(data) {
			frames.push(data);
			return true;
		},
	};
	internals._sessionId = "self";

	const listed = client.listGroups();
	const frame = JSON.parse(frames[0]!.subarray(4).toString("utf8")) as { requestId: string };
	assert.deepEqual({ ...frame, requestId: "request" }, { type: "list_groups", requestId: "request" });
	const groups = [
		{ group: "build", sessionCount: 1, member: false },
		{ group: "default", sessionCount: 2, member: true },
	];
	internals.handleBrokerMessage({ type: "groups", requestId: frame.requestId, groups });

	assert.deepEqual(await listed, groups);
});
