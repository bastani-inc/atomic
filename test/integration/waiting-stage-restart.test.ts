import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { test } from "vitest";
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
const FIXTURE = join(ROOT, "test/fixtures/waiting-stage-restart.ts");
const STAGES = 20;
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
const STAGE_NAMES = Array.from({ length: STAGES }, (_, index) => `stage-${index}`);

/** How often each stage logged `<entry> <stage> [<detail>]`, in stage order; `detail` narrows to one kind of entry. */
function perStage(effects: string, entry: string, detail?: string): number[] {
	const counts = new Map<string, number>();
	for (const line of effects.split("\n")) {
		const [kind, stage, lineDetail] = line.split(" ");
		if (kind !== entry || stage === undefined || (detail !== undefined && lineDetail !== detail)) continue;
		counts.set(stage, (counts.get(stage) ?? 0) + 1);
	}
	return STAGE_NAMES.map((stage) => counts.get(stage) ?? 0);
}

function everyStage(count: number): number[] {
	return STAGE_NAMES.map(() => count);
}

interface KilledRun {
	readonly effects: string;
	/** Every stage's status in the resumed run's result. */
	readonly statuses: readonly string[];
	/** What each stage's call returned to the resumed workflow, by stage name. */
	readonly results: Readonly<Record<string, string>>;
}

type Scenario = "tool" | "release" | "idle" | "finished";

/**
 * Start the fixture in `mode`, SIGKILL it once it writes `ready`, resume the same run in a new process, and hand back
 * what both processes did.
 */
async function killThenResume(
	runtime: "node" | "bun",
	mode: "wait" | "answer",
	ready: string,
	scenario: Scenario,
): Promise<KilledRun> {
	const directory = makeTempDirectory("waiting-stage-restart-");
	// Real run ids are UUIDs, which Intercom requires to route a run's stages; each test runs its own.
	const runId = randomUUID();
	const command = runtime === "node" ? [process.execPath, "--import", "jiti/register"] : [bunExecutable()];
	const environment = { ...process.env, ATOMIC_AGENT_DIR: join(directory, "agent") };
	const child = spawnProcess([...command, FIXTURE, mode, directory, String(STAGES), runId, scenario], {
		cwd: ROOT,
		env: environment,
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	try {
		const deadline = Date.now() + WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
		while (!(await fileExists(join(directory, ready)))) {
			assert.equal(child.exitCode, null, `${mode} process exited early: ${await stderr}`);
			assert.ok(Date.now() < deadline, `the stages did not all reach ${ready}`);
			await sleep(20);
		}
		child.kill("SIGKILL");
		await child.exited;

		const resumed = spawnSyncCollect([...command, FIXTURE, "resume", directory, String(STAGES), runId, scenario], {
			cwd: ROOT,
			env: environment,
			timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
		});
		assert.equal(resumed.exitCode, 0, resumed.stdout.toString() + resumed.stderr.toString());
		return {
			effects: await readText(join(directory, "effects.txt")),
			statuses: JSON.parse(await readText(join(directory, "resumed-stages.json"))) as string[],
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

/** Where the first process is killed, and how often each stage dispatched its call and continued its turn in all. */
const KILL_POINTS = {
	/** Every stage waits released on its call: the resume dispatches each pending call again. */
	wait: { ready: "waiting-ready", dispatches: 2, continued: 1 },
	/** Every call's result was recorded and the model was asked: the resume continues the turn with no call. */
	answer: { ready: "answered-ready", dispatches: 1, continued: 2 },
} as const;

async function killAndResume(runtime: "node" | "bun", killPoint: keyof typeof KILL_POINTS): Promise<void> {
	const expected = KILL_POINTS[killPoint];
	const { effects, statuses } = await killThenResume(runtime, killPoint, expected.ready, "tool");
	// Each stage was prompted once, before the kill: the resume sent no prompt, not even a continuation.
	assert.deepEqual(perStage(effects, "prompt"), everyStage(1));
	// A pending call runs again on resume with the same id (at least once); an answered one never does.
	assert.deepEqual(perStage(effects, "dispatch"), everyStage(expected.dispatches));
	assert.deepEqual(perStage(effects, "continue"), everyStage(expected.continued));
	assert.deepEqual(
		statuses,
		STAGE_NAMES.map(() => "completed"),
	);
}

/**
 * Every stage prompted once, then waited between turns with its session released (`release`: after `stage.release()`;
 * `idle`: held unused until the run's idle scan released it) when the root was killed. The resume answers the
 * finished prompt from the run's record: nothing is prompted again, not even a "continue" prompt. A released stage's
 * next message is the only prompt after the kill, and it reaches the session reopened with the earlier turn in it.
 */
async function killAndResumeBetweenTurns(runtime: "node" | "bun", scenario: "release" | "idle"): Promise<void> {
	const { effects, statuses } = await killThenResume(runtime, "wait", "waiting-ready", scenario);
	const sendsReport = scenario === "release" ? 1 : 0;
	assert.deepEqual(perStage(effects, "prompt", "plan"), everyStage(1));
	assert.deepEqual(perStage(effects, "prompt", "report"), everyStage(sendsReport));
	assert.deepEqual(perStage(effects, "prompt"), everyStage(1 + sendsReport));
	// Before the kill each stage opened a new session; after it, only a stage with a live call reopens its own, which
	// already holds the planning turn (2 messages).
	assert.deepEqual(perStage(effects, "open", "0"), everyStage(1));
	assert.deepEqual(perStage(effects, "open", "2"), everyStage(sendsReport));
	assert.deepEqual(
		statuses,
		STAGE_NAMES.map(() => "completed"),
	);
}

/**
 * Every stage (half of them tasks) got the model's final answer, and the root was killed before any stage recorded
 * its completion. The resume reopens each stage's session, which already holds the answered turn, and finishes the
 * stage from it: no stage is prompted again, not even with a "continue" prompt, and each returns that turn's answer.
 */
async function killAndResumeFinishedTurns(runtime: "node" | "bun"): Promise<void> {
	const { effects, statuses, results } = await killThenResume(runtime, "wait", "finished-ready", "finished");
	assert.deepEqual(perStage(effects, "prompt", "plan"), everyStage(1));
	assert.deepEqual(perStage(effects, "prompt"), everyStage(1));
	assert.deepEqual(perStage(effects, "open", "0"), everyStage(1));
	assert.deepEqual(perStage(effects, "open", "2"), everyStage(1));
	assert.deepEqual(
		STAGE_NAMES.map((stage) => results[stage]),
		STAGE_NAMES.map((_, index) => `answered plan ${index}`),
	);
	assert.deepEqual(
		statuses,
		STAGE_NAMES.map(() => "completed"),
	);
}

for (const runtime of ["node", "bun"] as const) {
	test(
		`${runtime}: killing the root while ${STAGES} stages wait released and resuming continues every stage without prompting again (#4309)`,
		() => killAndResume(runtime, "wait"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
	test(
		`${runtime}: killing the root while ${STAGES} stages wait after stage.release() resumes them without prompting again, and their next message reopens the saved session (#4309)`,
		() => killAndResumeBetweenTurns(runtime, "release"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
	test(
		`${runtime}: killing the root while ${STAGES} held stages wait released by the idle scan resumes them without sending any prompt (#4309)`,
		() => killAndResumeBetweenTurns(runtime, "idle"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
	test(
		`${runtime}: killing the root after ${STAGES} stages got the model's final answer but before they recorded their completion finishes every stage from its transcript without another model call (#4375)`,
		() => killAndResumeFinishedTurns(runtime),
		PROCESS_RESTART_TIMEOUT_MS,
	);
}

test(
	`node: killing the root after ${STAGES} stages recorded their results but before the model answered continues every turn without prompting or dispatching again (#4309)`,
	() => killAndResume("node", "answer"),
	PROCESS_RESTART_TIMEOUT_MS,
);
