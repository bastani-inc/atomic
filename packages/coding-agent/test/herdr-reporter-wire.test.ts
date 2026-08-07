import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { HerdrReporter } from "../src/extensions/herdr/reporter.ts";
import { createSocketTransport, resolveSocketEndpoint } from "../src/extensions/herdr/transport.ts";
import { HERDR_AGENT, HERDR_SOURCE } from "../src/extensions/herdr/types.ts";
import { type HerdrSocketFixture, type RecordedRequest, startHerdrSocketFixture } from "./herdr-socket-fixture.ts";

const PANE_ID = "pane-7";

function states(requests: RecordedRequest[]): Array<{ state: string; message: string | undefined }> {
	return requests
		.filter((request) => request.method === "pane.report_agent")
		.map((request) => ({
			state: String(request.params.state),
			message: request.params.message === undefined ? undefined : String(request.params.message),
		}));
}

function seqs(requests: RecordedRequest[]): number[] {
	return requests.map((request) => Number(request.params.seq));
}

describe("herdr reporter wire behavior", () => {
	let fixture: HerdrSocketFixture;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		fixture = await startHerdrSocketFixture();
		sessionManager = SessionManager.inMemory();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function createReporter(): HerdrReporter {
		return new HerdrReporter({
			paneId: PANE_ID,
			transport: createSocketTransport(resolveSocketEndpoint(fixture.socketPath)),
		});
	}

	it("reports identity, then working, then idle across one turn", async () => {
		const reporter = createReporter();
		// Each phase is drained before the next, which is what a real turn does:
		// a socket round trip is orders of magnitude shorter than an agent turn.
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		reporter.onAgentStart(sessionManager);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		const requests = await fixture.waitForRequests(4);
		assert.deepEqual(
			requests.map((request) => request.method),
			["pane.report_agent_session", "pane.report_agent", "pane.report_agent", "pane.report_agent"],
		);
		assert.deepEqual(states(requests), [
			{ state: "idle", message: undefined },
			{ state: "working", message: undefined },
			{ state: "idle", message: undefined },
		]);
	});

	it("coalesces queued state to the latest value and drains in order", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		// No drain between these: the writer is serialized, so the intermediate
		// values collapse into the newest one rather than queueing up behind it.
		reporter.onAgentStart(sessionManager);
		reporter.onBlockOpened(1, "Approve?");
		reporter.onBlockReleased(0, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		const reported = states(await fixture.waitForRequests(2));
		assert.equal(reported.at(-1)?.state, "idle", "the newest state always wins");
		assert.ok(reported.length <= 4, `coalescing should collapse writes, saw ${reported.length}`);
	});
	it("seeds a mid-turn activation as working rather than a false idle", async () => {
		// A reload — or a deferred extension load — can create this reporter while
		// a turn is already running, with no agent_start left to come.
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		await reporter.drain();

		const requests = await fixture.waitForRequests(2);
		assert.equal(requests[0]?.method, "pane.report_agent_session");
		assert.deepEqual(states(requests), [{ state: "working", message: undefined }]);

		// The turn that was already running still settles this instance.
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		await fixture.waitForRequests(3);
		assert.deepEqual(states(fixture.requests).at(-1), { state: "idle", message: undefined });
	});

	it("uses exactly the herdr:atomic identity and the pane id on every request", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		await reporter.drain();
		await reporter.onSessionShutdown("quit");

		const requests = await fixture.waitForRequests(3);
		for (const request of requests) {
			assert.equal(request.params.source, HERDR_SOURCE);
			assert.equal(request.params.source, "herdr:atomic");
			assert.equal(request.params.agent, HERDR_AGENT);
			assert.equal(request.params.agent, "atomic");
			assert.equal(request.params.pane_id, PANE_ID);
		}
	});

	it("stays blocked until the last nested block releases", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		await reporter.drain();
		const beforeBlocks = fixture.requests.length;

		reporter.onBlockOpened(1, "Approve edit?");
		await reporter.drain();
		reporter.onBlockOpened(2, "Approve edit?");
		await reporter.drain();
		reporter.onBlockReleased(1, "Approve edit?");
		await reporter.drain();

		// The nested open and the first release do not change the pane state, so
		// they must not produce their own reports.
		const duringBlocks = states(fixture.requests.slice(beforeBlocks));
		assert.deepEqual(duringBlocks, [{ state: "blocked", message: "Approve edit?" }]);

		reporter.onBlockReleased(0, undefined);
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "working", message: undefined });
	});

	it("settles to blocked with a short error message when the turn ended in an error", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		reporter.onAgentEnd(sessionManager, "overloaded_error: upstream is busy");
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		await fixture.waitForRequests(3);
		assert.deepEqual(states(fixture.requests).at(-1), {
			state: "blocked",
			message: "overloaded_error: upstream is busy",
		});
	});

	it("truncates a long failure message rather than shipping it whole", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		reporter.onAgentEnd(sessionManager, "e".repeat(500));
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		await fixture.waitForRequests(3);
		const last = states(fixture.requests).at(-1);
		assert.equal(last?.state, "blocked");
		assert.ok((last?.message?.length ?? 0) <= 120, `message length ${last?.message?.length}`);
	});

	it("ignores a duplicate settle and a settle while still streaming", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		await reporter.drain();
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		const afterFirstSettle = fixture.requests.length;

		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		reporter.onAgentSettled(sessionManager, false);
		await reporter.drain();

		assert.equal(fixture.requests.length, afterFirstSettle, "a repeated settle writes nothing");
		assert.deepEqual(states(fixture.requests), [
			{ state: "working", message: undefined },
			{ state: "idle", message: undefined },
		]);
	});

	it("ignores lifecycle events from a session it did not bind", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		const beforeCount = fixture.requests.length;

		const otherSession = SessionManager.inMemory();
		reporter.onAgentStart(otherSession);
		reporter.onAgentSettled(otherSession, true);
		await reporter.drain();

		assert.equal(fixture.requests.length, beforeCount);
	});

	it("keeps sequences strictly increasing across every message kind", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		reporter.onBlockOpened(1, "Approve?");
		reporter.onBlockReleased(0, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		await reporter.onSessionShutdown("quit");

		const requests = await fixture.waitForRequests(2);
		const values = seqs(requests);
		assert.ok(values.length >= 2);
		for (let index = 1; index < values.length; index++) {
			assert.ok(
				values[index] > values[index - 1],
				`seq ${values[index]} at ${index} is not above ${values[index - 1]}`,
			);
		}
	});

	it("silences the predecessor on a non-quit shutdown and lets the successor continue above it", async () => {
		const predecessor = createReporter();
		await predecessor.onSessionStart(sessionManager, false);
		await predecessor.drain();
		await predecessor.onSessionShutdown("reload");

		const beforeCount = fixture.requests.length;
		const predecessorMaxSeq = Math.max(...seqs(fixture.requests));

		// A silenced predecessor writes nothing further, and never releases.
		predecessor.onAgentStart(sessionManager);
		predecessor.onAgentSettled(sessionManager, true);
		await predecessor.drain();
		assert.equal(fixture.requests.length, beforeCount);
		assert.equal(
			fixture.requests.some((request) => request.method === "pane.release_agent"),
			false,
		);

		const successor = createReporter();
		await successor.onSessionStart(sessionManager, false);
		await successor.drain();

		const successorRequests = fixture.requests.slice(beforeCount);
		assert.ok(successorRequests.length > 0, "successor re-reports on its own session_start");
		for (const seq of seqs(successorRequests)) {
			assert.ok(seq > predecessorMaxSeq, `successor seq ${seq} is not above ${predecessorMaxSeq}`);
		}
	});

	it("drains the queue and then makes the release the final write on quit", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.onSessionShutdown("quit");

		const requests = await fixture.waitForRequests(4);
		const last = requests.at(-1);
		assert.equal(last?.method, "pane.release_agent");
		assert.deepEqual(states(requests).at(-1), { state: "idle", message: undefined });
		assert.equal(
			requests.filter((request) => request.method === "pane.release_agent").length,
			1,
			"exactly one release",
		);

		// Post-release reports are refused.
		const countAfterRelease = fixture.requests.length;
		reporter.onAgentStart(sessionManager);
		reporter.onBlockOpened(1, "Approve?");
		await reporter.drain();
		assert.equal(fixture.requests.length, countAfterRelease);
	});

	it("prefers the absolute session path and falls back to the session id", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();

		const sessionReport = (await fixture.waitForRequests(1))[0];
		assert.equal(sessionReport?.method, "pane.report_agent_session");
		const file = sessionManager.getSessionFile();
		if (file !== undefined) {
			assert.equal(sessionReport?.params.agent_session_path, file);
			assert.equal(sessionReport?.params.agent_session_id, undefined);
		} else {
			assert.equal(sessionReport?.params.agent_session_id, sessionManager.getSessionId());
			assert.equal(sessionReport?.params.agent_session_path, undefined);
		}
	});

	it("never carries prompt text, tool arguments, or model output", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		reporter.onBlockOpened(1, "Approve?");
		reporter.onBlockReleased(0, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		await reporter.onSessionShutdown("quit");

		const allowedKeys = new Set([
			"pane_id",
			"source",
			"agent",
			"state",
			"message",
			"seq",
			"agent_session_path",
			"agent_session_id",
		]);
		for (const request of await fixture.waitForRequests(1)) {
			for (const key of Object.keys(request.params)) {
				assert.ok(allowedKeys.has(key), `unexpected wire field ${key}`);
			}
		}
	});

	it("degrades to silence when the socket is gone", async () => {
		const reporter = new HerdrReporter({
			paneId: PANE_ID,
			transport: createSocketTransport(resolveSocketEndpoint(`${fixture.socketPath}-missing`)),
		});
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		await reporter.onSessionShutdown("quit");
		assert.equal(fixture.requests.length, 0);
	});
});
