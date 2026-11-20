import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const { EndedQueueMemory, IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { PAUSED_RECIPIENT_TARGET, RESUMING_RECIPIENT_TARGET } = await import(
	"../../packages/intercom/broker/ended-child-wakes.js"
);

type Frame = Record<string, unknown> & { attemptId: string; requestId: string };

function connectedClient(wakesEndedChildren: boolean, endedQueue?: InstanceType<typeof EndedQueueMemory>) {
	const client = new IntercomClient(undefined, endedQueue === undefined ? {} : { endedQueue });
	const frames: Frame[] = [];
	const socket = new Socket();
	vi.spyOn(socket, "write").mockImplementation((data) => {
		assert.ok(Buffer.isBuffer(data));
		frames.push(JSON.parse(data.subarray(4).toString("utf8")));
		return true;
	});
	client["socket"] = socket;
	client["_sessionId"] = "owner";
	client["brokerMarksEndedChildren"] = true;
	client["brokerWakesEndedChildren"] = wakesEndedChildren;
	const receive = (message: object) => client["handleBrokerMessage"](message as never);
	return { client, frames, receive };
}

test("an owner tells only a broker that wakes ended children what it does with a message to one (#5999)", async () => {
	for (const wakes of [true, false]) {
		const { client, frames, receive } = connectedClient(wakes);
		const marked = client.markEndedChildren([
			{ childName: "subagent-worker-1", outcome: "completed", messages: "wake" },
			{ childName: "subagent-worker-2", outcome: "stopped", messages: "hold" },
			{ childName: "subagent-worker-3", outcome: "cancelled", messages: "wake" },
		]);
		await vi.waitFor(() => assert.equal(frames.length, 1));
		assert.deepEqual(
			(frames[0]!.children as Array<Record<string, unknown>>).map((child) => child.messages),
			wakes ? ["wake", "hold", undefined] : [undefined, undefined, undefined],
		);
		receive({ type: "released_children_ack", requestId: frames[0]!.requestId });
		await marked;
	}
});

test("a send asks to wake an ended recipient only for one exact target, never for a pattern copy (#5999)", async () => {
	const { client, frames, receive } = connectedClient(true);
	const sent = client.send("subagent-worker-1", { text: "hello", messageId: "m1", wakeEndedRecipient: true });
	const copy = client.send("subagent-worker-2", {
		text: "hello",
		messageId: "m2",
		wakeEndedRecipient: true,
		broadcastId: "b1",
	});
	assert.equal(frames[0]!.wakeEndedRecipient, true);
	assert.equal(frames[1]!.wakeEndedRecipient, undefined);
	receive({
		type: "queued",
		messageId: "m1",
		attemptId: frames[0]!.attemptId,
		target: RESUMING_RECIPIENT_TARGET,
		position: 1,
	});
	receive({ type: "delivered", messageId: "m2", attemptId: frames[1]!.attemptId });
	assert.deepEqual(await sent, {
		id: "m1",
		delivered: false,
		queued: true,
		target: RESUMING_RECIPIENT_TARGET,
		position: 1,
	});
	assert.equal((await copy).delivered, true);
});

test("an owner hears each wake the broker asks for, and answers it on the connection that asked (#5999)", () => {
	const { client, frames, receive } = connectedClient(true);
	const notices: unknown[] = [];
	client.on("ended_child_wake", (notice: unknown) => notices.push(notice));
	receive({
		type: "ended_child_wake",
		childName: "subagent-worker-1",
		childId: "run:0",
		wakeId: "w1",
		from: { id: "peer-id", name: "peer" },
		depth: 2,
	});
	assert.deepEqual(notices, [
		{
			childName: "subagent-worker-1",
			childId: "run:0",
			wakeId: "w1",
			from: { id: "peer-id", name: "peer" },
			depth: 2,
		},
	]);
	for (const invalid of [
		{ wakeId: "w", from: { id: "p" }, depth: 1 },
		{ childName: "c", from: { id: "p" }, depth: 1 },
		{ childName: "c", wakeId: "w", from: "p", depth: 1 },
		{ childName: "c", wakeId: "w", from: { id: "p" } },
	])
		assert.throws(() => receive({ type: "ended_child_wake", ...invalid }), /Invalid ended_child_wake message/);

	assert.equal(client.answerEndedChildWake("subagent-worker-1", "w1", false, "it was cancelled for good"), true);
	assert.deepEqual(frames.at(-1), {
		type: "answer_ended_child_wake",
		childName: "subagent-worker-1",
		wakeId: "w1",
		accepted: false,
		reason: "it was cancelled for good",
	});
	const older = connectedClient(false);
	assert.equal(
		older.client.answerEndedChildWake("subagent-worker-1", "w1", true),
		false,
		"an older broker never asked",
	);
	assert.deepEqual(older.frames, []);
});

test("messages queued for subagents that ended fail here, once, when the broker that kept them is gone (#5999)", async () => {
	// A session connects with a new client after each disconnect; what it keeps outlives each one.
	const memory = new EndedQueueMemory();
	const register = (receive: (message: object) => void, instanceId: string | undefined) =>
		receive({ type: "registered", sessionId: "owner", ...(instanceId === undefined ? {} : { instanceId }) });
	const first = connectedClient(true, memory);
	first.client["_sessionId"] = null;
	register(first.receive, "broker-a");
	const sent = first.client.send("subagent-worker-1", { text: "hello", messageId: "m1", wakeEndedRecipient: true });
	const asked = first.client.send("subagent-worker-2", {
		text: "why?",
		messageId: "m2",
		expectsReply: true,
		logicalTarget: "worker two",
		wakeEndedRecipient: true,
	});
	const reached = first.client.send("subagent-worker-3", { text: "hi", messageId: "m3", wakeEndedRecipient: true });
	const answered = first.client.send("subagent-worker-4", { text: "and?", messageId: "m4", wakeEndedRecipient: true });
	for (const [index, target] of [
		RESUMING_RECIPIENT_TARGET,
		PAUSED_RECIPIENT_TARGET,
		RESUMING_RECIPIENT_TARGET,
		RESUMING_RECIPIENT_TARGET,
	].entries())
		first.receive({
			type: "queued",
			messageId: `m${index + 1}`,
			attemptId: first.frames[index]!.attemptId,
			target,
			position: 1,
		});
	await Promise.all([sent, asked, reached, answered]);
	// m3 reached its subagent, and m4 was answered, before the broker went away; m1 and m2 had not.
	first.receive({ type: "delivered", messageId: "m3" });
	first.receive({
		type: "message",
		from: { id: "w4", name: "subagent-worker-4", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
		message: { id: "r4", timestamp: 1, replyTo: "m4", content: { text: "done" } },
	});

	const same = connectedClient(true, memory);
	const lost: unknown[] = [];
	same.client.on("ended_queue_lost", (messages: unknown[]) => lost.push(...messages));
	same.client["_sessionId"] = null;
	register(same.receive, "broker-a");
	assert.equal(lost.length, 0, "the same broker still keeps them");

	const next = connectedClient(true, memory);
	next.client.on("ended_queue_lost", (messages: unknown[]) => lost.push(...messages));
	next.client["_sessionId"] = null;
	register(next.receive, "broker-b");
	assert.deepEqual(
		[...lost],
		[
			{
				messageId: "m1",
				to: "subagent-worker-1",
				logicalTarget: "subagent-worker-1",
				expectsReply: false,
				queue: "resuming",
			},
			{ messageId: "m2", to: "subagent-worker-2", logicalTarget: "worker two", expectsReply: true, queue: "paused" },
		],
	);
	const later = connectedClient(true, memory);
	later.client.on("ended_queue_lost", (messages: unknown[]) => lost.push(...messages));
	later.client["_sessionId"] = null;
	register(later.receive, "broker-c");
	assert.equal(lost.length, 2, "each is given up once");
});
