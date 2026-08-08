import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	clearWorkflowLifecycleBridgeEvents,
	getWorkflowLifecycleBridgeLineages,
	getWorkflowLifecycleBridgeSnapshot,
	getWorkflowLifecycleBridgeTerminalLineages,
	rememberWorkflowLifecycleBridgeEvent,
	rememberWorkflowLifecycleBridgeLineage,
	resetWorkflowLifecycleBridgeSnapshot,
} from "../src/core/workflow-lifecycle-events.ts";
import { TURN_FAILURE_MESSAGE } from "../src/extensions/herdr/index.ts";
import { HerdrReporter, MAX_REPORT_MESSAGE_LENGTH } from "../src/extensions/herdr/reporter.ts";
import {
	createSocketTransport,
	FIRST_ATTEMPT_TIMEOUT_MS,
	RETRY_ATTEMPT_TIMEOUT_MS,
	resolveSocketEndpoint,
} from "../src/extensions/herdr/transport.ts";
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
		resetWorkflowLifecycleBridgeSnapshot();
		fixture = await startHerdrSocketFixture();
		sessionManager = SessionManager.inMemory();
	});

	afterEach(async () => {
		resetWorkflowLifecycleBridgeSnapshot();
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

	it("settles to blocked with the fixed failure label when the turn ended in an error", async () => {
		// The extension only ever hands the reporter this fixed label; provider
		// error text never gets this far. See herdr-activation for that boundary.
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, TURN_FAILURE_MESSAGE);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		await fixture.waitForRequests(3);
		assert.deepEqual(states(fixture.requests).at(-1), {
			state: "blocked",
			message: "Agent turn failed",
		});
	});

	it("truncates a long failure message rather than shipping it whole", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, "e".repeat(500));
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		await fixture.waitForRequests(3);
		const last = states(fixture.requests).at(-1);
		assert.equal(last?.state, "blocked");
		assert.equal(last?.message?.length, MAX_REPORT_MESSAGE_LENGTH);
		// A raw prefix of the input plus one ellipsis, not a rewritten value.
		assert.equal(last?.message, `${"e".repeat(MAX_REPORT_MESSAGE_LENGTH - 1)}…`);
	});

	it("sends a message that fits the cap exactly as it was given", async () => {
		// Nothing in the contract asks for whitespace normalization, so a label
		// within the cap must reach the wire character for character.
		const label = "  Keep\n  spacing  ";
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		reporter.onBlockOpened(1, label);
		await reporter.drain();

		await fixture.waitForRequests(3);
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: label });
	});

	it("holds a turn failure until the turn actually settles", async () => {
		// `agent_end` still precedes retries and queued continuations, so a failure
		// seen there is not the turn's outcome yet. Storing it straight into the
		// reported state let an unrelated publish — a dialog closing — show the
		// pane as failed in the middle of a retry that then succeeded.
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, TURN_FAILURE_MESSAGE);

		reporter.onBlockOpened(1, "Approve?");
		await reporter.drain();
		reporter.onBlockReleased(0, undefined);
		await reporter.drain();

		assert.deepEqual(
			states(fixture.requests).at(-1),
			{ state: "working", message: undefined },
			"closing a dialog before settlement must not surface the pending failure",
		);

		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: "Agent turn failed" });
	});

	it("drops a pending failure when the retry starts a new turn", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, TURN_FAILURE_MESSAGE);

		// A retry: agent_start clears the pending failure, and the turn that
		// succeeds settles to idle rather than blocked.
		reporter.onAgentStart(sessionManager);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		assert.deepEqual(states(fixture.requests).at(-1), { state: "idle", message: undefined });
	});

	it("keeps a non-idle settle pending rather than reporting it", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, TURN_FAILURE_MESSAGE);
		reporter.onAgentSettled(sessionManager, false);
		await reporter.drain();

		assert.deepEqual(states(fixture.requests).at(-1), { state: "working", message: undefined });

		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: "Agent turn failed" });
	});

	it("latches a failed settlement across a duplicate idle settle", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentEnd(sessionManager, TURN_FAILURE_MESSAGE);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		const afterFailure = states(fixture.requests).at(-1);

		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();

		assert.deepEqual(states(fixture.requests).at(-1), afterFailure);
		assert.deepEqual(afterFailure, { state: "blocked", message: "Agent turn failed" });
	});

	it("tracks concurrent workflow contributions and maps every lifecycle kind", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();

		reporter.onWorkflowLifecycle({ runKey: "run-a", kind: "started", label: "build" });
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "working", message: undefined });

		reporter.onWorkflowLifecycle({ runKey: "run-b", kind: "resumed", label: "test" });
		await reporter.drain();
		reporter.onAgentStart(sessionManager);
		await reporter.drain();
		reporter.onAgentEnd(sessionManager, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "working", message: undefined });

		reporter.onWorkflowLifecycle({ runKey: "run-a", kind: "awaiting_input", label: "build" });
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: "build" });

		reporter.onWorkflowLifecycle({ runKey: "run-b", kind: "failed", label: "test" });
		await reporter.drain();
		reporter.onWorkflowLifecycle({ runKey: "run-a", kind: "completed", label: "build" });
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: "test" });

		reporter.onWorkflowLifecycle({ runKey: "run-b", kind: "paused", label: "test" });
		await reporter.drain();
		reporter.onWorkflowLifecycle({ runKey: "run-b", kind: "quit", label: "test" });
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "idle", message: undefined });
	});

	it("keeps working while one of two live workflow runs completes", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();

		reporter.onWorkflowLifecycle({ runKey: "run-a", kind: "started", label: "build" });
		reporter.onWorkflowLifecycle({ runKey: "run-b", kind: "started", label: "test" });
		await reporter.drain();
		assert.deepEqual(states(fixture.requests), [
			{ state: "idle", message: undefined },
			{ state: "working", message: undefined },
		]);

		reporter.onWorkflowLifecycle({ runKey: "run-a", kind: "completed", label: "build" });
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "working", message: undefined });

		reporter.onWorkflowLifecycle({ runKey: "run-b", kind: "completed", label: "test" });
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "idle", message: undefined });
	});

	it("scopes neutral lifecycle snapshots to their event bus", () => {
		const firstBus = createEventBus();
		const secondBus = createEventBus();
		rememberWorkflowLifecycleBridgeEvent({ runKey: "first-run", kind: "blocked", label: "First workflow" }, firstBus);
		rememberWorkflowLifecycleBridgeLineage("physical-first", "first-run", firstBus);

		assert.deepEqual(getWorkflowLifecycleBridgeSnapshot(firstBus), [
			{ runKey: "first-run", kind: "blocked", label: "First workflow" },
		]);
		assert.deepEqual(getWorkflowLifecycleBridgeSnapshot(secondBus), []);
		assert.deepEqual(getWorkflowLifecycleBridgeLineages(firstBus), [
			{ runId: "physical-first", runKey: "first-run" },
		]);
		assert.deepEqual(getWorkflowLifecycleBridgeLineages(secondBus), []);

		resetWorkflowLifecycleBridgeSnapshot(firstBus);
		assert.deepEqual(getWorkflowLifecycleBridgeSnapshot(firstBus), []);
		assert.deepEqual(getWorkflowLifecycleBridgeSnapshot(secondBus), []);
		assert.deepEqual(getWorkflowLifecycleBridgeLineages(firstBus), []);
		assert.deepEqual(getWorkflowLifecycleBridgeLineages(secondBus), []);
	});

	it("retains terminal continuation tombstones without seeding active work", () => {
		const firstBus = createEventBus();
		const secondBus = createEventBus();
		rememberWorkflowLifecycleBridgeEvent({ runKey: "completed-run", kind: "started", label: "Deploy" }, firstBus);
		rememberWorkflowLifecycleBridgeEvent({ runKey: "completed-run", kind: "completed", label: "Deploy" }, firstBus);

		assert.deepEqual(getWorkflowLifecycleBridgeSnapshot(firstBus), []);
		assert.deepEqual(getWorkflowLifecycleBridgeTerminalLineages(firstBus), ["completed-run"]);
		assert.deepEqual(getWorkflowLifecycleBridgeTerminalLineages(secondBus), []);

		resetWorkflowLifecycleBridgeSnapshot(firstBus);
		assert.deepEqual(getWorkflowLifecycleBridgeTerminalLineages(firstBus), []);
	});

	it("clears active contributions without losing same-session terminal lineage", () => {
		const bus = createEventBus();
		rememberWorkflowLifecycleBridgeEvent({ runKey: "completed-run", kind: "completed", label: "Deploy" }, bus);
		rememberWorkflowLifecycleBridgeLineage("source", "completed-run", bus);

		clearWorkflowLifecycleBridgeEvents(bus);
		assert.deepEqual(getWorkflowLifecycleBridgeSnapshot(bus), []);
		assert.deepEqual(getWorkflowLifecycleBridgeTerminalLineages(bus), ["completed-run"]);
		assert.deepEqual(getWorkflowLifecycleBridgeLineages(bus), [{ runId: "source", runKey: "completed-run" }]);

		resetWorkflowLifecycleBridgeSnapshot(bus);
		assert.deepEqual(getWorkflowLifecycleBridgeTerminalLineages(bus), []);
		assert.deepEqual(getWorkflowLifecycleBridgeLineages(bus), []);
	});

	it("seeds a successor from the current workflow contribution snapshot", async () => {
		const reporter = createReporter();
		reporter.seedWorkflowContributions([
			{ runKey: "active-run", state: "working" },
			{ runKey: "waiting-run", state: "blocked", label: "Review workflow" },
		]);

		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		assert.deepEqual(states(fixture.requests), [{ state: "blocked", message: "Review workflow" }]);
	});

	it("seeds a replacement from the neutral lifecycle snapshot", async () => {
		rememberWorkflowLifecycleBridgeEvent({ runKey: "waiting-run", kind: "awaiting_input", label: "Review workflow" });
		const reporter = createReporter();
		reporter.seedWorkflowLifecycleEvents(getWorkflowLifecycleBridgeSnapshot());

		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		assert.deepEqual(states(fixture.requests), [{ state: "blocked", message: "Review workflow" }]);
	});

	it("keeps a user dialog above workflow blocks and never sends workflow keys", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		reporter.onWorkflowLifecycle({ runKey: "secret-run-id", kind: "blocked", label: "deploy" });
		await reporter.drain();

		reporter.onBlockOpened(1, "Approve local edit?");
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: "Approve local edit?" });
		const wire = JSON.stringify(fixture.requests);
		assert.equal(wire.includes("secret-run-id"), false);
		assert.equal(wire.includes("prompt body"), false);

		reporter.onBlockReleased(0, undefined);
		await reporter.drain();
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: "deploy" });
	});

	it("sends exactly one release when two quits race", async () => {
		// Nothing in the host serializes disposal, and the guard used to sit before
		// the latch, so both callers got past it and each enqueued a release.
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentSettled(sessionManager, true);

		await Promise.all([reporter.onSessionShutdown("quit"), reporter.onSessionShutdown("quit")]);

		const releases = fixture.requests.filter((request) => request.method === "pane.release_agent");
		assert.equal(releases.length, 1, `expected exactly one release, saw ${releases.length}`);
		assert.equal(fixture.requests.at(-1)?.method, "pane.release_agent", "and it is still the final write");
	});

	it("refuses a state report enqueued once a quit has begun", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, false);
		await reporter.drain();

		const quit = reporter.onSessionShutdown("quit");
		reporter.onBlockOpened(1, "Too late");
		await quit;

		assert.equal(fixture.requests.at(-1)?.method, "pane.release_agent");
		assert.equal(
			fixture.requests.some((request) => String(request.params.message ?? "") === "Too late"),
			false,
		);
	});

	it("sends an empty message when the dialog title was empty", async () => {
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		reporter.onBlockOpened(1, "");
		await reporter.drain();

		await fixture.waitForRequests(3);
		assert.deepEqual(states(fixture.requests).at(-1), { state: "blocked", message: "" });
	});

	it("preserves a long value's raw prefix, including its whitespace", async () => {
		const label = `${"  spaced  ".repeat(20)}tail`;
		assert.ok(label.length > MAX_REPORT_MESSAGE_LENGTH);
		const reporter = createReporter();
		await reporter.onSessionStart(sessionManager, true);
		await reporter.drain();
		reporter.onBlockOpened(1, label);
		await reporter.drain();

		await fixture.waitForRequests(3);
		assert.equal(states(fixture.requests).at(-1)?.message, `${label.slice(0, MAX_REPORT_MESSAGE_LENGTH - 1)}…`);
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
		await reporter.drain();
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

/**
 * A Herdr that accepts connections and never answers.
 *
 * This is the case the documentation has to be honest about: ordinary reporting
 * callbacks still return at once, but quit waits for the release attempt, and
 * that wait is bounded by the transport budgets rather than by nothing.
 */
describe("herdr reporter latency against an unresponsive socket", () => {
	let fixture: HerdrSocketFixture;

	beforeEach(async () => {
		fixture = await startHerdrSocketFixture({ respond: false });
	});

	afterEach(async () => {
		await fixture.close();
	});

	/** One request's full budget: first attempt, then the single retry. */
	const REQUEST_BUDGET_MS = FIRST_ATTEMPT_TIMEOUT_MS + RETRY_ATTEMPT_TIMEOUT_MS;

	it("keeps ordinary lifecycle callbacks off the socket, and bounds the quit wait", async () => {
		const sessionManager = SessionManager.inMemory();
		const reporter = new HerdrReporter({
			paneId: PANE_ID,
			transport: createSocketTransport(resolveSocketEndpoint(fixture.socketPath)),
		});

		const startedAt = Date.now();
		await reporter.onSessionStart(sessionManager, false);
		reporter.onAgentStart(sessionManager);
		reporter.onAgentSettled(sessionManager, true);
		const lifecycleMs = Date.now() - startedAt;
		assert.ok(
			lifecycleMs < FIRST_ATTEMPT_TIMEOUT_MS,
			`lifecycle callbacks waited ${lifecycleMs} ms; they must not wait for socket I/O`,
		);

		const quitStartedAt = Date.now();
		await reporter.onSessionShutdown("quit");
		const quitMs = Date.now() - quitStartedAt;

		// L1 requires the release to be attempted after the queue drains, so this
		// wait is by design. What must hold is that it is bounded.
		assert.ok(quitMs >= REQUEST_BUDGET_MS, `quit returned in ${quitMs} ms without spending a request budget`);
		// Three requests at most: session identity, one coalesced state, release.
		assert.ok(quitMs <= 4 * REQUEST_BUDGET_MS, `quit waited ${quitMs} ms, beyond the documented bound`);
	});

	it("opens no further connection after a non-quit shutdown aborts the attempt", async () => {
		// Clearing the queue was not enough. An attempt already in flight still
		// spent its 1500 ms retry and connected again *after* shutdown returned,
		// so a predecessor could talk over the successor that replaced it.
		const sessionManager = SessionManager.inMemory();
		const reporter = new HerdrReporter({
			paneId: PANE_ID,
			transport: createSocketTransport(resolveSocketEndpoint(fixture.socketPath)),
		});
		await reporter.onSessionStart(sessionManager, false);
		await fixture.waitForRequests(1);

		const connectionsAtShutdown = fixture.connectionCount();
		await reporter.onSessionShutdown("reload");

		// Well past the first attempt's budget and into the retry window.
		await new Promise((resolve) => setTimeout(resolve, FIRST_ATTEMPT_TIMEOUT_MS + 400));
		assert.equal(
			fixture.connectionCount(),
			connectionsAtShutdown,
			"a silenced reporter must not open another connection",
		);
	});

	it("drops queued work immediately on a non-quit shutdown", async () => {
		const sessionManager = SessionManager.inMemory();
		const reporter = new HerdrReporter({
			paneId: PANE_ID,
			transport: createSocketTransport(resolveSocketEndpoint(fixture.socketPath)),
		});
		await reporter.onSessionStart(sessionManager, false);

		const startedAt = Date.now();
		await reporter.onSessionShutdown("reload");
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < FIRST_ATTEMPT_TIMEOUT_MS, `non-quit shutdown waited ${elapsed} ms`);
	});
});
