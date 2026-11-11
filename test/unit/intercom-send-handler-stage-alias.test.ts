import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	type PendingStageRoute,
	type RemoteSendRequest,
} from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

const RUN = "46390000-3528-413e-84c4-87a43e5037a2";
const STAGE_TARGET = `workflow:${RUN}/orchestrator-id`;
const ALIAS = "subagent-chat-01a1c7ac-ffab-74d0-833c-bc9f2d3a4b9f";

function session(
	id: string,
	name: string,
	group: string,
	extra: Partial<BrokerConnectedSession> = {},
): BrokerConnectedSession {
	const info: SessionInfo = { id, name, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, group };
	return { socket: { id } as unknown as net.Socket, info, ...extra };
}

function message(id: string, extra: Partial<Message> = {}): Message {
	return { id, timestamp: 1, content: { text: "status?" }, ...extra };
}

interface Run {
	readonly writes: BrokerMessage[];
	readonly routed: PendingStageRoute[];
	readonly aliasLookups: Array<{ readonly sender: string; readonly alias: string }>;
	readonly remote: RemoteSendRequest[];
}

/**
 * One send through the broker's handler with a stage-alias resolver that knows {@link ALIAS}, and a pending-stage
 * router that takes every `workflow:` target it is offered, as the run's owner does for a stage without a live session.
 */
function sendAs(
	sessions: BrokerConnectedSession[],
	from: string,
	frame: Record<string, unknown>,
	options: { resolves?: boolean; remote?: boolean } = {},
): Run {
	const map = new Map(sessions.map((entry) => [entry.info.id, entry]));
	const run: Run = { writes: [], routed: [], aliasLookups: [], remote: [] };
	handleBrokerSend(
		map.get(from)!.socket,
		frame as never,
		from,
		map,
		new DeliveredMessageCache(),
		(_socket, value) => {
			run.writes.push(value);
			return true;
		},
		new SupervisorChannelCache(),
		undefined,
		(route) => {
			run.routed.push(route);
			return true;
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		options.remote === true ? (request) => run.remote.push(request) : undefined,
		undefined,
		undefined,
		(sender, alias) => {
			run.aliasLookups.push({ sender: sender.info.id, alias });
			return options.resolves !== false && alias === ALIAS ? STAGE_TARGET : undefined;
		},
	);
	return run;
}

function failure(run: Run): string | undefined {
	const failed = run.writes.find((value) => value.type === "delivery_failed");
	return failed?.type === "delivery_failed" ? failed.reason : undefined;
}

test("a send to a stage session's name nothing else resolves goes to the stage's workflow target (#4639)", () => {
	const run = sendAs([session("launcher", "launcher", "default")], "launcher", {
		type: "send",
		to: ` ${ALIAS} `,
		message: message("m1"),
	});
	assert.deepEqual(run.aliasLookups, [{ sender: "launcher", alias: ALIAS }]);
	assert.equal(run.routed.length, 1);
	assert.equal(run.routed[0]!.target, STAGE_TARGET);
	assert.equal(run.routed[0]!.message.id, "m1");
	assert.equal(failure(run), undefined);
});

test("an alias the resolver does not know, or will not let this sender use, still finds nothing (#4639)", () => {
	const run = sendAs(
		[session("outsider", "outsider", "elsewhere")],
		"outsider",
		{ type: "send", to: ALIAS, message: message("m1") },
		{ resolves: false },
	);
	assert.equal(run.aliasLookups.length, 1);
	assert.deepEqual(run.routed, []);
	assert.equal(failure(run), "Session not found");
});

test("a live session the sender sees under that name keeps the name; the alias is never consulted (#4639)", () => {
	const run = sendAs([session("sender", "sender", "team"), session("peer", ALIAS, "team")], "sender", {
		type: "send",
		to: ALIAS,
		message: message("m1"),
	});
	assert.deepEqual(run.aliasLookups, []);
	assert.deepEqual(run.routed, []);
	assert.ok(run.writes.some((value) => value.type === "message"));
});

test("a subagent's supervisor channel to a stage whose session is gone reaches the stage as a plain send (#4639)", () => {
	const child = session("child", "child", "team", { supervisorId: ALIAS });
	const run = sendAs([child], "child", { type: "supervisor_send", to: ALIAS, message: message("m1") });
	assert.deepEqual(run.aliasLookups, [{ sender: "child", alias: ALIAS }]);
	assert.equal(run.routed[0]?.target, STAGE_TARGET);
	assert.equal(failure(run), undefined);
	const live = sendAs([child, session(ALIAS, "supervisor", "other")], "child", {
		type: "supervisor_send",
		to: ALIAS,
		message: message("m2"),
	});
	assert.deepEqual(live.aliasLookups, [], "a live supervisor keeps its channel");
	const delivered = live.writes.find((value) => value.type === "message");
	assert.ok(delivered?.type === "message" && delivered.channel === "supervisor");
});

test("exact reply routes and workflow targets are never rewritten through an alias (#4639)", () => {
	const sender = session("child", "child", "team", { supervisorId: ALIAS });
	for (const frame of [
		{ type: "send", to: ALIAS, requirePendingReply: true, message: message("m2", { replyTo: "q1" }) },
		{ type: "send", to: ALIAS, expectedRecipientId: "someone", message: message("m3", { replyTo: "q2" }) },
	]) {
		const run = sendAs([sender], "child", frame);
		assert.deepEqual(run.aliasLookups, [], JSON.stringify(frame));
	}
	const workflow = sendAs([sender], "child", { type: "send", to: `workflow:${RUN}/other-id`, message: message("m4") });
	assert.deepEqual(workflow.aliasLookups, []);
	assert.equal(workflow.routed[0]?.target, `workflow:${RUN}/other-id`);
});

test("with multi-node routing, a stage alias is resolved here before the send goes looking on other nodes (#4639)", () => {
	const run = sendAs(
		[session("launcher", "launcher", "default")],
		"launcher",
		{ type: "send", to: ALIAS, message: message("m1") },
		{ remote: true },
	);
	assert.equal(run.routed[0]?.target, STAGE_TARGET);
	assert.deepEqual(run.remote, []);
	const unknown = sendAs(
		[session("launcher", "launcher", "default")],
		"launcher",
		{ type: "send", to: "someone-else", message: message("m2") },
		{ remote: true },
	);
	assert.equal(unknown.remote.length, 1, "a name no stage registered still goes looking on other nodes");
});
