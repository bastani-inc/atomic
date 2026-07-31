/**
 * P4 gate for the `actions/cache` 4.3.0 -> 6.1.0 bump (design D1).
 *
 * Two majors in one step: v5 moved the action to the Node 24 runner runtime and
 * v6 rebuilt it as ESM. Neither renames an input, so the failure mode this gate
 * guards is not a syntax error — it is a two-major jump silently perturbing the
 * check contexts and per-job timeout budgets that
 * `test/ci/test-workflow-topology.test.ts` asserts, or the two cache users
 * drifting apart so a warmed entry can never be read back.
 *
 * The strongest available statement about the required contexts is structural:
 * every asserted context and budget is produced by `test.yml`, and `test.yml`
 * does not use `actions/cache` at all. The rest of the file pins the bump where
 * it does land.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { jobBlocks, jobSteps, namedStep, readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowsDir = join(root, ".github/workflows");

/** The reviewed pin: one commit, one version comment, everywhere it is used. */
const CACHE_PIN = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0";

/** Workflows that legitimately restore the MSVC CRT / Windows SDK cache. */
const CACHE_USERS = ["publish.yml", "warm-toolchain-cache.yml"] as const;

/** The step both of them own, by name. */
const RESTORE_STEP = "Restore MSVC CRT and Windows SDK";

function cacheUses(workflow: string): string[] {
	return [...workflow.matchAll(/actions\/cache@\S+(?: # \S+)?/gu)].map(([use]) => use);
}

test("every actions/cache use is the one reviewed 6.1.0 pin", async () => {
	for (const file of CACHE_USERS) {
		const workflow = await readText(join(workflowsDir, file));
		const uses = cacheUses(workflow);
		assert.equal(uses.length, 1, `${file} must use actions/cache exactly once`);
		assert.equal(uses[0], CACHE_PIN, `${file} drifted off the reviewed pin`);
	}
});

test("the workflow carrying every asserted check context does not use actions/cache", async () => {
	const workflow = await readText(join(workflowsDir, "test.yml"));
	// test/ci/test-workflow-topology.test.ts asserts both required contexts and
	// every per-job timeout budget against this file. A cache action absent from
	// it cannot move either, whatever the major version does.
	assert.deepEqual(cacheUses(workflow), []);
	assert.match(workflow, /^[ \t]+timeout-minutes:/mu, "the topology suite's budgets must still live here");
});

test("both cache users restore the same entry with only inputs this major still accepts", async () => {
	const restores = new Map<string, Record<string, string>>();
	for (const file of CACHE_USERS) {
		const workflow = await readText(join(workflowsDir, file));
		const owning = jobBlocks(workflow).filter(([, block]) => block.includes("actions/cache@"));
		assert.equal(owning.length, 1, `${file} must confine actions/cache to one job`);
		const [jobName, block] = owning[0] as [string, string];

		// A two-major jump must not outlive its hang detector: the job that pays
		// the restore cost still declares its own wall-clock cap.
		assert.match(
			block,
			/^[ \t]+timeout-minutes: (?:\d+|\$\{\{ matrix\.timeout_minutes \}\})$/mu,
			`${file}:${jobName} lost its per-job timeout budget`,
		);

		const step = namedStep(jobSteps(block), RESTORE_STEP);
		assert.ok(step.includes(CACHE_PIN), `${file}:${jobName} restores through something other than the pin`);
		const inputs = Object.fromEntries(
			[
				...step.matchAll(
					/^[ \t]+(path|key|restore-keys|save-always|lookup-only|fail-on-cache-miss|enableCrossOsArchive): (.+)$/gmu,
				),
			].map(([, name, value]) => [name as string, (value as string).trim()]),
		);
		// v5 dropped `save-always`; keeping the reviewed pair means the bump cannot
		// have quietly carried a retired input into a major that ignores it.
		assert.deepEqual(
			Object.keys(inputs).sort(),
			["key", "path"],
			`${file} passes an input beyond the two this pin was reviewed with`,
		);
		restores.set(file, inputs);
	}

	// The warming workflow exists only to fill the entry the publishing workflow
	// reads. A key or path that disagrees warms a cache nothing ever hits.
	assert.deepEqual(
		restores.get("publish.yml"),
		restores.get("warm-toolchain-cache.yml"),
		"the warming job and the publishing job restore different entries",
	);
});
