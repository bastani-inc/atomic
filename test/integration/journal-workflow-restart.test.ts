import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { useBundledNodeFixture } from "../helpers/bundled-node-fixture.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import {
	bunExecutable,
	fileExists,
	makeTempDirectory,
	moduleDir,
	readText,
	sleep,
	spawnProcess,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/journal-workflow-restart.ts");
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;

const bundledNodeFixture = useBundledNodeFixture(FIXTURE);

for (const runtime of ["node", "bun"] as const) {
	test(
		`${runtime} resumes a killed workflow from its journal without rerunning the tool callback`,
		async () => {
			const fixture = runtime === "node" ? await bundledNodeFixture() : FIXTURE;
			const directory = makeTempDirectory("journal-workflow-restart-");
			const command = runtime === "node" ? [process.execPath] : [bunExecutable()];
			const environment = { ...process.env, ATOMIC_CODING_AGENT_DIR: join(directory, "agent") };
			const child = spawnProcess([...command, fixture, "start", directory], { cwd: ROOT, env: environment });
			const stdout = new Response(child.stdout).text();
			const stderr = new Response(child.stderr).text();
			try {
				const deadline = Date.now() + WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;
				while (!(await fileExists(join(directory, "checkpoint-ready")))) {
					assert.equal(child.exitCode, null, "producer exited before checkpoint readiness");
					assert.ok(Date.now() < deadline, "producer did not persist its checkpoint");
					await sleep(20);
				}
				const live = spawnSyncCollect([...command, fixture, "live", directory], {
					cwd: ROOT,
					env: environment,
					timeout: WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS,
				});
				assert.equal(live.exitCode, 0, live.stdout.toString() + live.stderr.toString());
				child.kill("SIGKILL");
				await child.exited;
				const resumed = spawnSyncCollect([...command, fixture, "resume", directory], {
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
				await removeTempRootReleasingBroker(directory);
			}
		},
		PROCESS_RESTART_TIMEOUT_MS,
	);
}
