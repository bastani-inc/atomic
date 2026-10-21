import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import {
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
const FIXTURE = join(ROOT, "test/fixtures/workflow-concurrent-children-crash.ts");
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;

interface Inspection {
	readonly kind: string;
	readonly status?: string;
	readonly childRuns?: number;
}

test(
	"a run killed with concurrent child workflows in flight stays inspectable and resumes (#3846)",
	async () => {
		const directory = makeTempDirectory("workflow-concurrent-children-crash-");
		const command = [process.execPath, "--import", "jiti/register"];
		const environment = { ...process.env, ATOMIC_AGENT_DIR: join(directory, "agent") };
		const child = spawnProcess([...command, FIXTURE, "start", directory], { cwd: ROOT, env: environment });
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		try {
			const deadline = Date.now() + WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
			while (!(await fileExists(join(directory, "ready")))) {
				assert.equal(child.exitCode, null, "producer exited before its children were in flight");
				assert.ok(Date.now() < deadline, "producer did not start its children");
				await sleep(20);
			}
			child.kill("SIGKILL");
			await child.exited;

			const inspect = spawnSyncCollect([...command, FIXTURE, "inspect", directory], {
				cwd: ROOT,
				env: environment,
				timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
			});
			assert.equal(inspect.exitCode, 0, inspect.stdout.toString() + inspect.stderr.toString());
			const live = JSON.parse(inspect.stdout.toString().trim().split("\n").at(-1)!) as { inspected: Inspection };
			assert.deepEqual(live.inspected, { kind: "found", status: "running", childRuns: 5 });

			const resumed = spawnSyncCollect([...command, FIXTURE, "resume", directory], {
				cwd: ROOT,
				env: environment,
				timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
			});
			assert.equal(resumed.exitCode, 0, resumed.stdout.toString() + resumed.stderr.toString());
			const outcome = JSON.parse(resumed.stdout.toString().trim().split("\n").at(-1)!) as {
				inspected: Inspection;
				resumed: string;
			};
			assert.deepEqual(outcome.inspected, { kind: "found", status: "crashed", childRuns: 5 });
			assert.equal(outcome.resumed, "completed");
			const saves = (await readText(join(directory, "saves.txt"))).trim().split("\n").sort();
			assert.deepEqual(saves, ["0", "1", "2", "3", "4"]);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
			await stdout;
			await stderr;
			removeTempDirectory(directory);
		}
	},
	PROCESS_RESTART_TIMEOUT_MS,
);
