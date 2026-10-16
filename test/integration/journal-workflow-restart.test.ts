import assert from "node:assert/strict";
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
const FIXTURE = join(ROOT, "test/fixtures/journal-workflow-restart.ts");
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;

for (const runtime of ["node", "bun"] as const) {
	test(
		`${runtime} resumes a killed workflow from its journal without rerunning the tool callback`,
		async () => {
			const directory = makeTempDirectory("journal-workflow-restart-");
			const command = runtime === "node" ? [process.execPath, "--import", "jiti/register"] : [bunExecutable()];
			const environment = { ...process.env, ATOMIC_AGENT_DIR: join(directory, "agent") };
			const child = spawnProcess([...command, FIXTURE, "start", directory], { cwd: ROOT, env: environment });
			const stdout = new Response(child.stdout).text();
			const stderr = new Response(child.stderr).text();
			try {
				const deadline = Date.now() + WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
				while (!(await fileExists(join(directory, "checkpoint-ready")))) {
					assert.equal(child.exitCode, null, "producer exited before checkpoint readiness");
					assert.ok(Date.now() < deadline, "producer did not persist its checkpoint");
					await sleep(20);
				}
				const live = spawnSyncCollect([...command, FIXTURE, "live", directory], {
					cwd: ROOT,
					env: environment,
					timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
				});
				assert.equal(live.exitCode, 0, live.stdout.toString() + live.stderr.toString());
				child.kill("SIGKILL");
				await child.exited;
				const resumed = spawnSyncCollect([...command, FIXTURE, "resume", directory], {
					cwd: ROOT,
					env: environment,
					timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
				});
				assert.equal(resumed.exitCode, 0, resumed.stdout.toString() + resumed.stderr.toString());
				assert.equal(await readText(join(directory, "effects.txt")), "effect\n");
				assert.equal(await readText(join(directory, "stages.txt")), "stage\n");
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
	test(
		`${runtime} commits cached-stage metadata before the next tool and retains it after SIGKILL`,
		async () => {
			const directory = makeTempDirectory("journal-cached-stage-");
			const fixture = join(ROOT, "test/fixtures/journal-cached-stage-restart.ts");
			const command = runtime === "node" ? [process.execPath, "--import", "jiti/register"] : [bunExecutable()];
			const environment = { ...process.env, ATOMIC_AGENT_DIR: join(directory, "agent") };
			const seeded = spawnSyncCollect([...command, fixture, "seed", directory], {
				cwd: ROOT,
				env: environment,
				timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
			});
			assert.equal(seeded.exitCode, 0, seeded.stdout.toString() + seeded.stderr.toString());
			const child = spawnProcess([...command, fixture, "cached", directory], { cwd: ROOT, env: environment });
			const stdout = new Response(child.stdout).text();
			const stderr = new Response(child.stderr).text();
			try {
				const deadline = Date.now() + WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
				while (!(await fileExists(join(directory, "cached-ready")))) {
					assert.equal(child.exitCode, null, "cached-stage process exited before its metadata barrier");
					assert.ok(Date.now() < deadline, "cached-stage metadata barrier did not settle");
					await sleep(20);
				}
				child.kill("SIGKILL");
				await child.exited;
				const resumed = spawnSyncCollect([...command, fixture, "resume", directory], {
					cwd: ROOT,
					env: environment,
					timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
				});
				assert.equal(resumed.exitCode, 0, resumed.stdout.toString() + resumed.stderr.toString());
				assert.equal(await readText(join(directory, "effects.txt")), "once\nbarrier\n");
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
	test(
		`${runtime} resumes a user-origin paused workflow immediately after normal process exit`,
		async () => {
			const directory = makeTempDirectory("journal-workflow-exit-");
			const command = runtime === "node" ? [process.execPath, "--import", "jiti/register"] : [bunExecutable()];
			try {
				for (const mode of ["pause-exit", "resume-user"]) {
					const result = spawnSyncCollect([...command, FIXTURE, mode, directory], {
						cwd: ROOT,
						timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
					});
					assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
				}
				assert.equal(await readText(join(directory, "effects.txt")), "effect\n");
				assert.equal(await readText(join(directory, "stages.txt")), "stage\n");
			} finally {
				removeTempDirectory(directory);
			}
		},
		PROCESS_RESTART_TIMEOUT_MS,
	);
}
