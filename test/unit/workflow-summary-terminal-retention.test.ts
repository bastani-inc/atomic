import assert from "node:assert/strict";
import { test } from "vitest";
import { trackTerminalWorkflowSummary } from "../../packages/coding-agent/src/core/workflow-summary-lifecycle.js";
import { type CollectionCount, collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";

/** Summarizes one finished run for `owner`, the way a session summarizes a run that ended, and returns the summary. */
async function summarizeEndedRun(tracked: CollectionCount, requestSignal: AbortSignal): Promise<string | undefined> {
	const owner = { name: "the summarizing session" };
	const runLog = { text: `Objective: ship the release\n${"stage output\n".repeat(10_000)}` };
	tracked.track(owner);
	tracked.track(runLog);
	return trackTerminalWorkflowSummary(owner, requestSignal, async () => `${owner.name}: ${runLog.text.slice(11, 27)}`);
}

test("a finished terminal workflow summary keeps neither its session nor the run it summarized (#5487)", async () => {
	const tracked = trackCollection();
	// The run's signal outlives the summary: it is only aborted when the run is stopped, and a finished run never is.
	const run = new AbortController();
	const summaries: Array<string | undefined> = [];
	for (let index = 0; index < 3; index++) summaries.push(await summarizeEndedRun(tracked, run.signal));
	assert.deepEqual(summaries, Array(3).fill("the summarizing session: ship the release"));

	await collectEverythingTracked(tracked, 100);

	assert.deepEqual(tracked.uncollected(), [], "a finished summary must release its session and run log");
	assert.equal(run.signal.aborted, false);
});
