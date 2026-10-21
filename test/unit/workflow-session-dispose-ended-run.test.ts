import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	ENDED_RUN_SETTLEMENT_TIMEOUT_MS,
	settleEndedRuns,
} from "../../packages/workflows/src/runs/background/ended-run-settlement.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	isCompletedStatusAppend,
	journalEventTypes,
	journalInterceptingAppend,
	journalWithAppendLatency,
	workflowHostOverJournal,
} from "../helpers/workflow-ended-run-host.js";

const JOURNAL_ROUND_TRIP_MS = 50;
const REMOTE_STORE_UNAVAILABLE = "remote store unavailable";

afterEach(() => {
	setDurableBackend(undefined);
	vi.useRealTimers();
});

async function startRun(host: ReturnType<typeof workflowHostOverJournal>) {
	const ended = host.reportsEnded();
	const accepted = await host.runtime.dispatch({ action: "run", workflow: "quick" });
	assert.ok("runId" in accepted && accepted.runId, JSON.stringify(accepted));
	const job = host.runState.jobs.get(accepted.runId);
	assert.ok(job, "the run must be tracked while it executes");
	return { runId: accepted.runId, ended, job };
}

describe("disposing a session as its run reports it ended", () => {
	test("records the run's terminal status in the journal and releases its lease (#3811)", async () => {
		const memory = new MemoryRunJournal();
		const host = workflowHostOverJournal(journalWithAppendLatency(memory, JOURNAL_ROUND_TRIP_MS));
		const { runId, ended } = await startRun(host);
		assert.equal(await ended, runId);
		assert.equal(host.store.runs().find((run) => run.id === runId)?.status, "completed");

		await host.shutdown();

		assert.equal((await memory.getRun(runId))?.status, "completed");
		const events = await journalEventTypes(memory, runId);
		assert.ok(events.includes("StatusChanged"), events.join(", "));
		assert.equal((await memory.leaseState(runId))?.holderId ?? null, null);
	});

	test("records a failed run's terminal status too (#3811)", async () => {
		const memory = new MemoryRunJournal();
		const failing = workflow({
			name: "quick",
			description: "Fails at once.",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("step", {}, async () => {
					throw new Error("step exploded");
				});
				return {};
			},
		});
		const host = workflowHostOverJournal(journalWithAppendLatency(memory, JOURNAL_ROUND_TRIP_MS), [failing]);
		const ended = host.reportsEnded("failed");
		const accepted = await host.runtime.dispatch({ action: "run", workflow: "quick" });
		assert.ok("runId" in accepted && accepted.runId, JSON.stringify(accepted));
		assert.equal(await ended, accepted.runId);

		await host.shutdown();

		assert.equal((await memory.getRun(accepted.runId))?.status, "failed");
		assert.equal((await memory.leaseState(accepted.runId))?.holderId ?? null, null);
	});

	test("records the ending after the journal rejects its first write of it (#3811)", async () => {
		const memory = new MemoryRunJournal();
		let rejected = 0;
		const host = workflowHostOverJournal(
			journalInterceptingAppend(memory, async (event) => {
				if (!isCompletedStatusAppend(event) || rejected > 0) return;
				rejected++;
				throw new Error(REMOTE_STORE_UNAVAILABLE);
			}),
		);
		const { runId, ended, job } = await startRun(host);
		await ended;

		await host.shutdown();
		await job.promise;

		assert.equal(rejected, 1);
		assert.equal((await memory.getRun(runId))?.status, "completed");
		assert.equal((await memory.leaseState(runId))?.holderId ?? null, null);
	});

	test("reports an ending the journal never accepted instead of leaving it unrecorded in silence (#3811)", async () => {
		const memory = new MemoryRunJournal();
		const host = workflowHostOverJournal(
			journalInterceptingAppend(memory, async (event) => {
				if (isCompletedStatusAppend(event)) throw new Error(REMOTE_STORE_UNAVAILABLE);
			}),
		);
		const { runId, ended, job } = await startRun(host);
		await ended;

		await assert.rejects(host.shutdown(), (error: Error) => {
			assert.match(error.message, new RegExp(`${runId}: ended but its ending was not recorded`));
			assert.match(error.message, new RegExp(REMOTE_STORE_UNAVAILABLE));
			return true;
		});

		assert.ok(job.outcome, "a detached run reports how its executor ended");
		await assert.rejects(job.outcome, (error: Error) => {
			assert.equal((error.cause as Error | undefined)?.message, REMOTE_STORE_UNAVAILABLE);
			return true;
		});
		const notice = host.store.notices().find((candidate) => candidate.runId === runId);
		assert.equal(notice?.level, "error");
		assert.match(notice?.message ?? "", new RegExp(REMOTE_STORE_UNAVAILABLE));
		assert.equal((await memory.leaseState(runId))?.holderId ?? null, null);
	});

	test("stops waiting for an ending that never finishes and says so (#3811)", async () => {
		const memory = new MemoryRunJournal();
		const stalled = Promise.withResolvers<void>();
		const host = workflowHostOverJournal(
			journalInterceptingAppend(memory, async (event) => {
				if (isCompletedStatusAppend(event)) await stalled.promise;
			}),
		);
		const { runId, ended } = await startRun(host);
		await ended;

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const shutdown = host.shutdown();
		const outcome = assert.rejects(shutdown, (error: Error) => {
			assert.match(
				error.message,
				new RegExp(
					`${runId}: ended but its ending was not recorded \\(still recording its ending after ${ENDED_RUN_SETTLEMENT_TIMEOUT_MS} ms\\)`,
				),
			);
			return true;
		});
		await vi.advanceTimersByTimeAsync(ENDED_RUN_SETTLEMENT_TIMEOUT_MS);
		stalled.resolve();
		await outcome;
	});
});

describe("settleEndedRuns", () => {
	function endedRun(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
		return {
			id,
			name: "quick",
			inputs: {},
			status: "completed",
			startedAt: 1,
			endedAt: 2,
			toolNodes: [],
			stages: [],
			...overrides,
		} as RunSnapshot;
	}

	function jobFor(runId: string, promise: Promise<void>) {
		return { runId, controller: new AbortController(), promise };
	}

	test("does not wait for runs that have not ended or that a parent owns (#3811)", async () => {
		const jobs = createJobTracker();
		const hung = new Promise<void>(() => {});
		jobs.register(jobFor("active", hung));
		jobs.register(jobFor("child", hung));
		const store = {
			runs: () => [
				endedRun("active", { status: "running", endedAt: undefined }),
				endedRun("child", { parentRunId: "root" }),
			],
		};

		assert.deepEqual(await settleEndedRuns({ store, jobs }), []);
	});

	test("reports a run that is still settling when the wait runs out (#3811)", async () => {
		const jobs = createJobTracker();
		jobs.register(jobFor("settling", new Promise<void>(() => {})));
		const store = { runs: () => [endedRun("settling")] };

		const failures = await settleEndedRuns({ store, jobs, timeoutMs: 10 });

		assert.deepEqual(failures, [
			{ runId: "settling", reason: "timed_out", message: "still recording its ending after 10 ms" },
		]);
	});

	test("holds back until an ended run's executor has retired (#3811)", async () => {
		const jobs = createJobTracker();
		const retired = Promise.withResolvers<void>();
		jobs.register(jobFor("settling", retired.promise));
		const store = { runs: () => [endedRun("settling")] };
		let returned = false;
		const waiting = settleEndedRuns({ store, jobs }).then((failures) => {
			returned = true;
			return failures;
		});

		await delay(JOURNAL_ROUND_TRIP_MS);
		assert.equal(returned, false);
		retired.resolve();

		assert.deepEqual(await waiting, []);
	});
});
