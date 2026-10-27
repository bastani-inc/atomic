import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * The most any one test in this file may take. An integration shard job is cancelled after 15 minutes, and in that
 * time it also installs, builds, runs the shard's other files and reports; a test allowed longer would be cancelled with the
 * job instead of failing with its own timeout and message.
 */
const TEST_BUDGET_CAP_MS = 600_000;

/**
 * A test's budget for the cold starts it makes: one per root process (the root loads the workflow runtime through
 * jiti itself) and three per pool it starts (its coordinator, its worker, and the child's own work and teardown),
 * capped at {@link TEST_BUDGET_CAP_MS}. Every process and run of the test shares one deadline, so a slow cold start
 * leaves less for the rest instead of each getting its own bound.
 */
function testBudget(coldStarts: number): { readonly waitMs: number; readonly timeoutMs: number } {
	const waitMs = Math.min(poolTestBudgetMs(coldStarts).waitMs, TEST_BUDGET_CAP_MS - POOL_CLEANUP_HEADROOM_MS);
	return { waitMs, timeoutMs: waitMs + POOL_CLEANUP_HEADROOM_MS };
}

/** A root process over one pool. */
const ROOT_PROCESS_COLD_STARTS = 4;
const CHILDREN = 3;
const rootFixture = fileURLToPath(new URL("../fixtures/pool-resume-root.mjs", import.meta.url));

interface ResumeOutcome {
	readonly status: string;
	readonly error: string | null;
	readonly children: readonly { readonly status: string; readonly firstPid: number; readonly finalPid: number }[];
	readonly workerPids: readonly number[];
}

function startedWorkers(directory: string): number[] {
	return readdirSync(directory)
		.filter((name) => name.startsWith("started-"))
		.map((name) => Number(name.split("-")[2]));
}

/** The crashed root and its resumed incarnation each run in their own process, one after the other. */
const CRASHED_ROOT_RESUME = testBudget(2 * ROOT_PROCESS_COLD_STARTS);

test.skipIf(process.platform === "win32")(
	"resuming a crashed pooled root replays children leased by the dead incarnation (#3890)",
	async () => {
		const deadline = Date.now() + CRASHED_ROOT_RESUME.waitMs;
		const directory = makeTempDirectory("pool-crashed-root-resume-");
		try {
			const crashed = spawnWithinBudget(
				[process.execPath, rootFixture, "start", directory, String(CHILDREN)],
				{ cwd: directory, stdout: "ignore" },
				deadline,
			);
			// The process's budget bounds this wait; a process that ends first, or is killed by it, fails it at once.
			while (startedWorkers(directory).length < CHILDREN) {
				if (crashed.process.exitCode !== null)
					assert.fail(
						`the crashed root ended before its children started:\n${await expectExitedCleanly(crashed)}`,
					);
				await sleep(50);
			}
			const deadWorkers = startedWorkers(directory);
			crashed.process.kill("SIGKILL");
			await crashed.process.exited;

			const resumed = spawnWithinBudget(
				[process.execPath, rootFixture, "resume", directory, String(CHILDREN)],
				{ cwd: directory, stdout: "ignore" },
				deadline,
			);
			const stderr = await expectExitedCleanly(resumed);
			assert.doesNotMatch(stderr, /Stale work lease|cleanup was not confirmed/);
			const outcome = await readJson<ResumeOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.equal(outcome.children.length, CHILDREN);
			for (const child of outcome.children) {
				assert.equal(child.status, "completed");
				assert.ok(deadWorkers.includes(child.firstPid), "the committed checkpoint is replayed, not repeated");
				assert.ok(outcome.workerPids.includes(child.finalPid), "a worker of the resumed root finished the child");
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
	CRASHED_ROOT_RESUME.timeoutMs,
);
