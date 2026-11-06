import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { fileExists, makeTempDirectory, readText, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";
import {
	allIds,
	assertEveryChildSeeded,
	assertReports,
	CHAOS_SCENARIO_TIMEOUT_MS,
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
	stopOutsideTransaction,
	waitForHandled,
} from "../helpers/workflow-subscription-chaos.js";

test.skipIf(process.platform === "win32")(
	"SIGSTOP the owner: a skewed clock cannot steal its lease; a takeover fences it with a typed error on SIGCONT (#4311)",
	async () => {
		const directory = makeTempDirectory("subscription-chaos-stop-");
		const runId = "4311c0de-0000-4000-8000-00000000000b";
		const owner = spawnProcess(
			[...COMMAND, "run", directory, runId, "owner", String(EVENTS), HANDLER_DELAY_MS, String(MAX_CONCURRENT)],
			{
				cwd: ROOT,
			},
		);
		const ownerStdout = new Response(owner.stdout).text();
		const ownerStderr = new Response(owner.stderr).text();
		try {
			await waitForHandled(directory, "owner", EVENTS / 4);
			await stopOutsideTransaction(owner, directory);
			const skewed = fixture(
				["run", directory, runId, "skewed", String(EVENTS), HANDLER_DELAY_MS, String(MAX_CONCURRENT)],
				{
					...process.env,
					NODE_OPTIONS:
						`${process.env.NODE_OPTIONS ?? ""} --import ${join(ROOT, "test/fixtures/clock-skew.mjs")}`.trim(),
					ATOMIC_TEST_CLOCK_SKEW_MS: String(6 * 60 * 60 * 1000),
				},
			);
			assert.notEqual(skewed.exitCode, 0, "a skewed clock took over a live lease");
			assert.equal((await handledByLabel(directory)).get("skewed"), undefined);

			const taken = fixture([
				"resume",
				directory,
				runId,
				"takeover",
				String(EVENTS),
				HANDLER_DELAY_MS,
				String(MAX_CONCURRENT),
			]);
			assert.equal(taken.exitCode, 0, taken.stdout.toString() + taken.stderr.toString());
			assert.deepEqual(lastJson(taken.stdout), { status: "completed" });
			owner.kill("SIGCONT");
			const ownerExit = await owner.exited;
			assert.notEqual(ownerExit, 0, `${await ownerStdout}${await ownerStderr}`);
			const failure = JSON.parse(await readText(join(directory, "failure-owner.json"))) as {
				code: string | null;
				chain: string[];
			};
			assert.ok(["handler-failed", "record-failed"].includes(failure.code ?? ""), JSON.stringify(failure));
			assert.ok(failure.chain.includes("JournalOwnershipError"), JSON.stringify(failure));

			const after = records(directory, runId);
			assert.deepEqual(after.processed, allIds);
			assert.equal(after.eventRecords, EVENTS * SUBSCRIPTIONS);
			assert.deepEqual(after.others, OTHER_SUBSCRIPTIONS_DONE);
			assert.equal(await fileExists(join(directory, "wrong-tree.txt")), false);
			await assertEveryChildSeeded(directory, ["owner", "takeover"]);
			await assertReports(directory, ["owner", "takeover"], after.watcherMessages, 1);
			assert.equal(integrity(directory), "ok");
		} finally {
			if (owner.exitCode === null) {
				owner.kill("SIGCONT");
				owner.kill("SIGKILL");
			}
			await owner.exited;
			removeTempDirectory(directory);
		}
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);
