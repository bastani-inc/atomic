import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { HostedSessionRequestError } from "../../packages/intercom/broker/hosted-session-errors.js";
import { HOSTED_SESSION_FRAME_MAX } from "../../packages/intercom/broker/hosted-sessions.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { type ReleasedStageAnnouncement, ReleasedStagePeers } from "../../packages/intercom/released-stage-peers.js";
import type { HostedSessionFrameItem } from "../../packages/intercom/types.js";

const RECONNECT_WINDOW_MS = 60_000;

const route = (index: number): ReleasedStageAnnouncement => ({
	runId: "run-4642",
	stageId: `stage-${index}`,
	stageName: `review-${index}`,
	sessionId: `stage-session-${index}`,
	group: "workflow:run-4642",
	answer: async () => "answer",
});

interface FakeConnections {
	readonly peers: ReleasedStagePeers;
	readonly connects: string[];
	readonly hosted: HostedSessionFrameItem[][];
	readonly disconnects: number[];
	readonly clients: IntercomClient[];
}

/** Peers whose connections are real clients with the broker calls stubbed; the first `failures` connects fail. */
function fakeConnections(options: { readonly failures?: number; readonly connect?: () => Promise<void> } = {}) {
	const connects: string[] = [];
	const hosted: HostedSessionFrameItem[][] = [];
	const disconnects: number[] = [];
	const clients: IntercomClient[] = [];
	const peers = new ReleasedStagePeers({
		prepare: async () => {},
		cwd: () => "/workspace",
		relay: () => {},
		createClient: (returnAddress) => {
			const client = new IntercomClient(returnAddress);
			clients.push(client);
			const attempt = connects.length;
			vi.spyOn(client, "connect").mockImplementation(async () => {
				const failed = attempt < (options.failures ?? 0);
				connects.push(failed ? "broker down" : "connected");
				if (failed) throw new Error("broker down");
				await options.connect?.();
			});
			vi.spyOn(client, "hostSessions").mockImplementation(async (sessions) => {
				hosted.push([...sessions]);
				return sessions.map((session) => ({ key: session.key, sessionId: `broker-${session.key}` }));
			});
			vi.spyOn(client, "disconnect").mockImplementation(async () => {
				disconnects.push(attempt);
			});
			return client;
		},
	});
	return { peers, connects, hosted, disconnects, clients } satisfies FakeConnections;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("released stages share one connection that keeps retrying with one timer after it fails (#3622, #4642)", async () => {
	vi.useFakeTimers();
	const { peers, connects, hosted } = fakeConnections({ failures: 2 });

	const adopted = await Promise.allSettled([0, 1, 2].map((index) => peers.adopt(route(index))));

	assert.deepEqual(
		adopted.map((outcome) => outcome.status),
		["rejected", "rejected", "rejected"],
	);
	assert.equal(vi.getTimerCount(), 1, "one reconnect timer for every peer");
	await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS);

	assert.deepEqual(connects, ["broker down", "broker down", "connected"]);
	assert.equal(hosted.length, 1, "every peer is hosted again in one frame");
	assert.deepEqual(
		hosted[0]!.map((item) => item.session.name),
		["subagent-chat-stage-session-0", "subagent-chat-stage-session-1", "subagent-chat-stage-session-2"],
	);
	assert.equal(vi.getTimerCount(), 0);
	await peers.disconnectAll();
});

test("a released stage is hosted under its old name, group and return address, closed for post-mortem replies (#4642)", async () => {
	const { peers, hosted } = fakeConnections();

	await peers.adopt({
		...route(0),
		model: "faux/model",
		liveRoute: { stageKeys: ["stage-0", "review-0"], capability: "cap" },
	});
	await peers.adopt(route(1));

	assert.equal(hosted.length, 2);
	const [first] = hosted[0]!;
	assert.equal(first?.session.name, "subagent-chat-stage-session-0");
	assert.equal(first?.session.status, "closed · reply: post-mortem only");
	assert.equal(first?.session.replyCapability, "live");
	assert.equal(first?.session.model, "faux/model");
	assert.deepEqual(first?.session.groups, ["workflow:run-4642"]);
	assert.equal(first?.session.group, "workflow:run-4642");
	assert.equal(first?.returnAddress, "stage-session-0:released-stage");
	assert.deepEqual(first?.liveRoute, { runId: "run-4642", stageKeys: ["stage-0", "review-0"], capability: "cap" });
	const [second] = hosted[1]!;
	assert.equal(second?.session.model, "unknown");
	assert.equal(second?.liveRoute, undefined);
	await peers.disconnectAll();
});

test("adopting a stage again with the same registration sends nothing, and a changed one replaces it (#4642)", async () => {
	const { peers, connects, hosted, clients } = fakeConnections();
	await peers.adopt(route(0));
	const unhost = vi.fn(async () => {});

	await peers.adopt({ ...route(0), answer: async () => "newer" });
	assert.equal(hosted.length, 1);
	assert.equal(connects.length, 1);
	assert.equal(peers.size, 1);

	vi.spyOn(clients[0]!, "unhostSessions").mockImplementation(unhost);
	await peers.adopt({ ...route(0), group: "workflow:other" });
	assert.equal(peers.size, 1);
	assert.equal(hosted.length, 2);
	assert.deepEqual(unhost.mock.calls, [[["broker-run-4642\0stage-0"]]]);
	assert.equal(connects.length, 1);
	await peers.disconnectAll();
});

test("more released stages than one frame holds are hosted in frames of at most 500 (#4642)", async () => {
	const { peers, hosted, connects } = fakeConnections();

	await Promise.all(Array.from({ length: HOSTED_SESSION_FRAME_MAX + 3 }, (_, index) => peers.adopt(route(index))));

	assert.equal(connects.length, 1);
	assert.deepEqual(
		hosted.map((frame) => frame.length),
		[HOSTED_SESSION_FRAME_MAX, 3],
	);
	await peers.disconnectAll();
});

test("disconnecting while the connection opens closes it instead of keeping it (#4642)", async () => {
	vi.useFakeTimers();
	let open: () => void = () => {};
	const { peers, disconnects, hosted } = fakeConnections({
		connect: () =>
			new Promise<void>((resolveOpen) => {
				open = resolveOpen;
			}),
	});

	const adopting = peers.adopt(route(0));
	await vi.advanceTimersByTimeAsync(0);
	const disconnecting = peers.disconnectAll();
	open();

	await assert.rejects(adopting, (error: Error) => error instanceof IntercomClientDisconnectedError);
	await disconnecting;
	assert.deepEqual(disconnects, [0], "the connection opened after the peers were disconnected is closed");
	assert.deepEqual(hosted, []);
	assert.equal(peers.size, 0);
	assert.equal(vi.getTimerCount(), 0, "nothing retries once the peers are disconnected");
});

test("an announcement the broker would refuse is rejected alone and hosts nothing (#4642)", async () => {
	const { peers, hosted, connects } = fakeConnections();

	await assert.rejects(
		peers.adopt({ ...route(0), liveRoute: { stageKeys: ["stage-0", ""], capability: "cap" } }),
		(error: Error) => {
			assert.ok(error instanceof HostedSessionRequestError);
			assert.equal(error.code, "invalid_hosted_session");
			assert.equal(error.key, "run-4642\0stage-0");
			return true;
		},
	);
	await peers.adopt(route(1));

	assert.equal(peers.size, 1);
	assert.equal(connects.length, 1);
	assert.deepEqual(
		hosted.map((frame) => frame.map((item) => item.key)),
		[["run-4642\0stage-1"]],
	);
	await peers.disconnectAll();
});
