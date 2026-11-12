import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { fileExists, makeTempDirectory, readText, spawnProcess } from "../helpers/runtime.js";
import {
	allIds,
	assertEveryChildSeeded,
	assertReports,
	COMMAND,
	EVENTS,
	fixture,
	HANDLER_DELAY_MS,
	handledByLabel,
	integrity,
	lastJson,
	MAX_CONCURRENT,
	OTHER_SUBSCRIPTIONS_DONE,
	ROOT,
	records,
	SUBSCRIPTIONS,
	waitForHandled,
} from "../helpers/workflow-subscription-chaos.js";

/** Structural: each scenario starts, faults and restarts real Node processes on a SQLite journal. */
const CHAOS_SCENARIO_TIMEOUT_MS = 240_000;

test(
	"SIGKILL mid-subscription, then resume: recorded events are never handled again and none are lost (#4311)",
	async () => {
		const directory = makeTempDirectory("subscription-chaos-kill-");
		const runId = "4311c0de-0000-4000-8000-00000000000a";
		const first = spawnProcess(
			[...COMMAND, "run", directory, runId, "first", String(EVENTS), HANDLER_DELAY_MS, String(MAX_CONCURRENT)],
			{
				cwd: ROOT,
			},
		);
		try {
			await waitForHandled(directory, "first", EVENTS / 3);
			first.kill("SIGKILL");
			await first.exited;
			assert.equal(integrity(directory), "ok");
			const beforeResume = records(directory, runId);
			assert.ok(beforeResume.processed.length > 0 && beforeResume.processed.length < EVENTS);

			const resumed = fixture([
				"resume",
				directory,
				runId,
				"second",
				String(EVENTS),
				HANDLER_DELAY_MS,
				String(MAX_CONCURRENT),
			]);
			assert.equal(resumed.exitCode, 0, resumed.stdout.toString() + resumed.stderr.toString());
			assert.deepEqual(lastJson(resumed.stdout), { status: "completed" });

			const handled = await handledByLabel(directory);
			const second = new Set(handled.get("second") ?? []);
			const firstHandled = new Set(handled.get("first") ?? []);
			assert.deepEqual(
				beforeResume.processed.filter((id) => second.has(id)),
				[],
				"an event recorded before the kill was handled again",
			);
			assert.deepEqual(
				allIds.filter((id) => !second.has(id) && !firstHandled.has(id)),
				[],
				"an event was lost",
			);
			const redone = [...second].filter((id) => firstHandled.has(id));
			assert.ok(redone.length <= MAX_CONCURRENT, `only in-flight events run again, got ${redone.length}`);
			const after = records(directory, runId);
			assert.deepEqual(after.processed, allIds);
			assert.equal(after.eventRecords, EVENTS * SUBSCRIPTIONS);
			assert.deepEqual(after.others, OTHER_SUBSCRIPTIONS_DONE);
			assert.equal(await fileExists(join(directory, "wrong-tree.txt")), false);
			await assertEveryChildSeeded(directory, ["first", "second"]);
			await assertReports(directory, ["first", "second"], after.watcherMessages, 1);
			assert.equal(integrity(directory), "ok");
			assert.deepEqual(
				(await readText(join(directory, "anchor.txt"))).trim().split("\n"),
				[`first ${runId}`],
				"the resumed run replays its completed anchor stage instead of running it again",
			);
		} finally {
			if (first.exitCode === null) first.kill("SIGKILL");
			await first.exited;
			await removeTempRootReleasingBroker(directory);
		}
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);
