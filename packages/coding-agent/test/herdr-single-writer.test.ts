import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { HerdrReporter } from "../src/extensions/herdr/reporter.ts";
import type { HerdrTransport } from "../src/extensions/herdr/transport.ts";
import type { HerdrRequest } from "../src/extensions/herdr/types.ts";

/**
 * A transport that holds every request open until released.
 *
 * The real socket fixture answers immediately, which hides a second concurrent
 * write behind the speed of loopback. Gating the transport is what makes
 * "at most one in flight" observable at all.
 */
interface GatedTransport {
	transport: HerdrTransport;
	/** Methods in the order the writer started them. */
	started: string[];
	/** Highest number of simultaneously in-flight writes observed. */
	maxInFlight: number;
	/** Release the oldest pending write. */
	releaseOne(): void;
	/** Release every pending write, including ones enqueued later. */
	releaseAll(): void;
	pendingCount(): number;
}

function createGatedTransport(): GatedTransport {
	const pending: Array<() => void> = [];
	let inFlight = 0;
	let autoRelease = false;
	const gate: GatedTransport = {
		started: [],
		maxInFlight: 0,
		transport: (request: HerdrRequest) => {
			inFlight += 1;
			gate.maxInFlight = Math.max(gate.maxInFlight, inFlight);
			gate.started.push(request.method);
			return new Promise<boolean>((resolve) => {
				const finish = () => {
					inFlight -= 1;
					resolve(true);
				};
				if (autoRelease) finish();
				else pending.push(finish);
			});
		},
		releaseOne() {
			pending.shift()?.();
		},
		releaseAll() {
			autoRelease = true;
			while (pending.length > 0) pending.shift()?.();
		},
		pendingCount: () => pending.length,
	};
	return gate;
}

/** Let the microtask queue settle so the writer can pick up released work. */
async function settle(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

describe("herdr reporter is a single writer", () => {
	it("never has more than one write in flight across session, state, and release", async () => {
		const gate = createGatedTransport();
		const sessionManager = SessionManager.inMemory();
		const reporter = new HerdrReporter({ paneId: "pane-1", transport: gate.transport });

		// The session report is still in flight while state changes pile up. Before
		// the fix, the state report started concurrently and could reach Herdr
		// first, which silently drops the lower-sequence session report.
		await reporter.onSessionStart(sessionManager, false);
		await settle();
		assert.equal(gate.maxInFlight, 1, "session report must be alone in flight");

		reporter.onBlockOpened(1, "Approve?");
		reporter.onBlockReleased(0, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await settle();
		assert.equal(gate.maxInFlight, 1, "no state report may start beside the session report");
		assert.deepEqual(gate.started, ["pane.report_agent_session"]);

		gate.releaseAll();
		await reporter.drain();
		assert.equal(gate.maxInFlight, 1);

		const quit = reporter.onSessionShutdown("quit");
		await quit;
		assert.equal(gate.maxInFlight, 1, "the release must not run beside a state report");
		assert.equal(gate.started[0], "pane.report_agent_session", "identity is written first");
		assert.equal(gate.started.at(-1), "pane.release_agent", "release is the final write");
	});

	it("writes session, state, and release in enqueue order with increasing sequences", async () => {
		const gate = createGatedTransport();
		const sessionManager = SessionManager.inMemory();
		const seen: HerdrRequest[] = [];
		const reporter = new HerdrReporter({
			paneId: "pane-1",
			transport: (request) => {
				seen.push(request);
				return gate.transport(request);
			},
		});

		await reporter.onSessionStart(sessionManager, false);
		reporter.onBlockOpened(1, "Approve?");
		gate.releaseAll();
		await reporter.drain();
		reporter.onBlockReleased(0, undefined);
		await reporter.drain();
		await reporter.onSessionShutdown("quit");

		assert.deepEqual(
			seen.map((request) => request.method),
			[
				"pane.report_agent_session",
				// `working` and `blocked` were both queued behind the gated session
				// report, so they coalesced to the newest of the two.
				"pane.report_agent",
				"pane.report_agent",
				"pane.release_agent",
			],
		);
		assert.deepEqual(
			seen.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state),
			["blocked", "working"],
		);
		const sequences = seen.map((request) => Number(request.params.seq));
		for (let index = 1; index < sequences.length; index++) {
			assert.ok(
				sequences[index] > sequences[index - 1],
				`seq ${sequences[index]} at ${index} is not above ${sequences[index - 1]}`,
			);
		}
	});

	it("coalesces adjacent state entries but never across a session or release entry", async () => {
		const gate = createGatedTransport();
		const sessionManager = SessionManager.inMemory();
		const seen: HerdrRequest[] = [];
		const reporter = new HerdrReporter({
			paneId: "pane-1",
			transport: (request) => {
				seen.push(request);
				return gate.transport(request);
			},
		});

		// Session enqueued, then several state changes behind it while it is gated.
		await reporter.onSessionStart(sessionManager, false);
		reporter.onBlockOpened(1, "Approve?");
		reporter.onBlockReleased(0, undefined);
		reporter.onAgentSettled(sessionManager, true);
		await settle();

		gate.releaseAll();
		await reporter.drain();

		// The session report survived — coalescing must not reach across it.
		assert.equal(seen[0]?.method, "pane.report_agent_session");
		// The three queued state changes collapsed to the newest one.
		const stateReports = seen.filter((request) => request.method === "pane.report_agent");
		assert.equal(stateReports.length, 1, `expected one coalesced state report, saw ${stateReports.length}`);
		assert.equal(stateReports[0]?.params.state, "idle");
	});

	it("keeps the release last even when a lifecycle event arrives during the quit drain", async () => {
		const gate = createGatedTransport();
		const sessionManager = SessionManager.inMemory();
		const seen: HerdrRequest[] = [];
		const reporter = new HerdrReporter({
			paneId: "pane-1",
			transport: (request) => {
				seen.push(request);
				return gate.transport(request);
			},
		});

		await reporter.onSessionStart(sessionManager, false);
		gate.releaseAll();
		await reporter.drain();

		const quit = reporter.onSessionShutdown("quit");
		// A late block change races the quit; it must not land behind the release.
		reporter.onBlockOpened(1, "Too late");
		await quit;

		assert.equal(seen.at(-1)?.method, "pane.release_agent");
		assert.equal(
			seen.filter((request) => String(request.params.message ?? "") === "Too late").length,
			0,
			"a report enqueued during quit must not be written",
		);
	});

	it("drops queued work and writes nothing further after a non-quit shutdown", async () => {
		const gate = createGatedTransport();
		const sessionManager = SessionManager.inMemory();
		const seen: HerdrRequest[] = [];
		const reporter = new HerdrReporter({
			paneId: "pane-1",
			transport: (request) => {
				seen.push(request);
				return gate.transport(request);
			},
		});

		await reporter.onSessionStart(sessionManager, false);
		reporter.onBlockOpened(1, "Approve?");
		await settle();
		const startedBefore = seen.length;

		await reporter.onSessionShutdown("reload");
		gate.releaseAll();
		await reporter.drain();

		assert.equal(seen.length, startedBefore, "queued work is dropped, not flushed");
		assert.equal(
			seen.some((request) => request.method === "pane.release_agent"),
			false,
			"a non-quit shutdown never releases the pane",
		);
	});
});
