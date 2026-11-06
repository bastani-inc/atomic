import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/shared/resume-continuation.js";
import {
	bunExecutable,
	fileExists,
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	sleep,
	spawnProcess,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/finished-turn-restart.ts");
const STAGES = 4;
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
const STAGE_INDEXES = Array.from({ length: STAGES }, (_, index) => index);

interface KilledRun {
	/** The requests the model received before the kill, as `model <first line of the prompt>`, in arrival order. */
	readonly requestsBeforeKill: readonly string[];
	/** The requests the model received after the kill. */
	readonly requestsAfterKill: readonly string[];
	/** What each stage's call returned to the resumed workflow, by stage name. */
	readonly results: Readonly<Record<string, string>>;
}

/** Start the fixture's `scenario`, SIGKILL it once it is ready, resume the same run in a new process, and report. */
async function killThenResume(runtime: "node" | "bun", scenario: "finished" | "fork"): Promise<KilledRun> {
	const directory = makeTempDirectory("finished-turn-restart-");
	const runId = randomUUID();
	const command = runtime === "node" ? [process.execPath, "--import", "jiti/register"] : [bunExecutable()];
	const environment = { ...process.env, ATOMIC_AGENT_DIR: join(directory, "agent") };
	const child = spawnProcess([...command, FIXTURE, "wait", directory, String(STAGES), runId, scenario], {
		cwd: ROOT,
		env: environment,
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	try {
		const deadline = Date.now() + WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
		while (!(await fileExists(join(directory, `${scenario}-ready`)))) {
			assert.equal(child.exitCode, null, `wait process exited early: ${await stderr}`);
			assert.ok(Date.now() < deadline, `the run did not reach ${scenario}-ready`);
			await sleep(20);
		}
		child.kill("SIGKILL");
		await child.exited;
		const requestsBeforeKill = (await readText(join(directory, "effects.txt"))).split("\n").filter(Boolean);

		const resumed = spawnSyncCollect([...command, FIXTURE, "resume", directory, String(STAGES), runId, scenario], {
			cwd: ROOT,
			env: environment,
			timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
		});
		assert.equal(resumed.exitCode, 0, resumed.stdout.toString() + resumed.stderr.toString());
		const requests = (await readText(join(directory, "effects.txt"))).split("\n").filter(Boolean);
		assert.deepEqual(requests.slice(0, requestsBeforeKill.length), requestsBeforeKill);
		return {
			requestsBeforeKill,
			requestsAfterKill: requests.slice(requestsBeforeKill.length),
			results: JSON.parse(await readText(join(directory, "resumed-results.json"))) as Record<string, string>,
		};
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await stdout;
		await stderr;
		removeTempDirectory(directory);
	}
}

/**
 * Stages backed by real SDK sessions got the model's final answer (half of them tasks), and the root was killed before
 * any stage recorded its completion. The resumed run reopens each stage's saved session and finishes the stage from
 * it: the model receives no request after the kill, and each stage returns the answer its turn ended on.
 */
async function killAfterFinishedTurnsThenResume(runtime: "node" | "bun"): Promise<void> {
	const { requestsBeforeKill, requestsAfterKill, results } = await killThenResume(runtime, "finished");
	assert.deepEqual(
		[...requestsBeforeKill].sort(),
		STAGE_INDEXES.map((index) => `model plan ${index}`),
	);
	assert.deepEqual(requestsAfterKill, [], "the model received no request after the kill");
	assert.deepEqual(
		STAGE_INDEXES.map((index) => results[`stage-${index}`]),
		STAGE_INDEXES.map((index) => `answered plan ${index}`),
	);
}

/**
 * A stage forked from a finished stage's session was killed after its session was recorded and before its own prompt
 * reached it, so its saved conversation ends on the source's answer. The resumed stage does not take that answer as
 * its own: it continues its turn with one request, and the source stage, replayed from its checkpoint, sends none.
 */
async function killForkedStageBeforeItsPromptThenResume(runtime: "node" | "bun"): Promise<void> {
	const { requestsBeforeKill, requestsAfterKill, results } = await killThenResume(runtime, "fork");
	assert.deepEqual(requestsBeforeKill, ["model source task"]);
	assert.deepEqual(requestsAfterKill, [`model ${RESUME_CONTINUATION_PROMPT.split("\n")[0]}`]);
	assert.equal(results.source, "answered source task");
	assert.equal(results.forked, `answered ${RESUME_CONTINUATION_PROMPT}`);
}

for (const runtime of ["node", "bun"] as const) {
	test(
		`${runtime}: real SDK sessions that got the model's final answer before the root was killed finish on resume without another model request (#4375)`,
		() => killAfterFinishedTurnsThenResume(runtime),
		PROCESS_RESTART_TIMEOUT_MS,
	);
	test(
		`${runtime}: a forked stage killed before its own prompt reached its session continues its turn on resume instead of returning the source stage's answer (#4375)`,
		() => killForkedStageBeforeItsPromptThenResume(runtime),
		PROCESS_RESTART_TIMEOUT_MS,
	);
}
