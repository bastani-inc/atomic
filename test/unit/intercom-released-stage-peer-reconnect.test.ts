import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { type ReleasedStageAnnouncement, ReleasedStagePeers } from "../../packages/intercom/released-stage-peers.js";

const RECONNECT_WINDOW_MS = 60_000;

const route: ReleasedStageAnnouncement = {
	runId: "run-3622",
	stageId: "stage-3622",
	stageName: "review",
	sessionId: "session-3622",
	group: "workflow:run-3622",
	answer: async () => "answer",
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("a released stage peer keeps retrying after its connection fails (#3622)", async () => {
	vi.useFakeTimers();
	const outcomes: string[] = [];
	const peers = new ReleasedStagePeers({
		prepare: async () => {},
		cwd: () => "/workspace",
		relay: () => {},
		createClient: (returnAddress) => {
			const client = new IntercomClient(returnAddress);
			const attempt = outcomes.length;
			vi.spyOn(client, "connect").mockImplementation(async () => {
				outcomes.push(attempt < 2 ? "broker down" : "connected");
				if (attempt < 2) throw new Error("broker down");
			});
			vi.spyOn(client, "disconnect").mockResolvedValue();
			return client;
		},
	});

	await assert.rejects(peers.adopt(route), /broker down/);
	await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS);

	assert.deepEqual(outcomes, ["broker down", "broker down", "connected"]);
	await peers.disconnectAll();
});
