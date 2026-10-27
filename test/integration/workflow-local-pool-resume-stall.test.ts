import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, readJson, removeTempDirectory } from "../helpers/runtime.js";

/** Root stalls longer than the work lease, over a root process's local pool (#3888). */

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

interface ResumeOutcome {
	readonly status: string;
	readonly error: string | null;
	readonly children: readonly { readonly status: string; readonly firstPid: number; readonly finalPid: number }[];
	readonly workerPids: readonly number[];
}

const LEASE_STALL = testBudget(ROOT_PROCESS_COLD_STARTS);
const STALL_TEST_LEASE_MS = 2_000;
const ROOT_STALL_MS = 3 * STALL_TEST_LEASE_MS;
const stallFixture = fileURLToPath(new URL("../fixtures/pool-lease-stall-root.mjs", import.meta.url));

test.skipIf(process.platform === "win32")(
	"a root stall longer than the work lease does not fence a live worker (#3888)",
	async () => {
		const directory = makeTempDirectory("pool-lease-stall-");
		try {
			const root = spawnWithinBudget(
				[process.execPath, stallFixture, directory, String(STALL_TEST_LEASE_MS), String(ROOT_STALL_MS)],
				{ cwd: directory, stdout: "ignore" },
				Date.now() + LEASE_STALL.waitMs,
			);
			const stderr = await expectExitedCleanly(root);
			assert.doesNotMatch(stderr, /Stale work lease/);
			const outcome = await readJson<ResumeOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			const [child] = outcome.children;
			assert.equal(child?.status, "completed");
			assert.equal(child.finalPid, child.firstPid, "the live worker kept its child through the stall");
			assert.deepEqual(outcome.workerPids, [child.firstPid]);
		} finally {
			removeTempDirectory(directory);
		}
	},
	LEASE_STALL.timeoutMs,
);

const REPEATED_ROOT_STALL_MS = 600;

/** The stopped worker's replacement is one more worker cold start in the root process's pool. */
const REPLACED_WORKER = testBudget(ROOT_PROCESS_COLD_STARTS + 1);

test.skipIf(process.platform === "win32")(
	"repeated root stalls do not keep a stopped worker's child from being replaced (#3888)",
	async () => {
		const directory = makeTempDirectory("pool-lease-repeated-stall-");
		try {
			const root = spawnWithinBudget(
				[
					process.execPath,
					stallFixture,
					directory,
					String(STALL_TEST_LEASE_MS),
					String(REPEATED_ROOT_STALL_MS),
					"stopped",
				],
				{ cwd: directory, stdout: "ignore" },
				Date.now() + REPLACED_WORKER.waitMs,
			);
			await expectExitedCleanly(root);
			const outcome = await readJson<ResumeOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			const [child] = outcome.children;
			assert.equal(child?.status, "completed");
			assert.notEqual(child.finalPid, child.firstPid, "a replacement worker finished the stopped worker's child");
		} finally {
			removeTempDirectory(directory);
		}
	},
	REPLACED_WORKER.timeoutMs,
);
