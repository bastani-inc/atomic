import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { useBundledNodeFixture } from "../helpers/bundled-node-fixture.js";
import {
	fileExists,
	makeTempDirectory,
	removeTempDirectory,
	spawnProcess,
	spawnSyncCollect,
} from "../helpers/runtime.js";
import {
	allIds,
	assertEveryChildSeeded,
	assertReports,
	EVENTS,
	FIXTURE,
	handledByLabel,
	integrity,
	OTHER_SUBSCRIPTIONS_DONE,
	PROCESS_PHASE_TIMEOUT_MS,
	ROOT,
	records,
	SUBSCRIPTIONS,
} from "../helpers/workflow-subscription-chaos.js";

/** Structural: each scenario starts, faults and restarts real Node processes on a SQLite journal. */
const CHAOS_SCENARIO_TIMEOUT_MS = 240_000;
const bundledWriterFixture = useBundledNodeFixture(FIXTURE);

test(
	"concurrent writer processes on one journal each record every event exactly once (#4311)",
	async () => {
		const writerFixture = await bundledWriterFixture();
		const command = [process.execPath, writerFixture];
		const environment = { ...process.env, ATOMIC_PACKAGE_DIR: join(ROOT, "packages/coding-agent") };
		const directory = makeTempDirectory("subscription-chaos-writers-");
		const writers = Array.from({ length: 4 }, (_, index) => ({
			runId: `4311c0de-0000-4000-8000-00000000010${index}`,
			label: `writer${index}`,
		}));
		const children = writers.map((writer) =>
			spawnProcess([...command, "run", directory, writer.runId, writer.label, String(EVENTS), "1", "8"], {
				cwd: ROOT,
				env: environment,
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		try {
			const outputs = children.map((child) =>
				Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
			);
			const codes = await Promise.all(children.map((child) => child.exited));
			for (const [index, code] of codes.entries()) {
				const [stdout, stderr] = await outputs[index]!;
				assert.equal(code, 0, stdout + stderr);
			}
			const handled = await handledByLabel(directory);
			for (const writer of writers) {
				assert.deepEqual([...(handled.get(writer.label) ?? [])].sort(), [...allIds].sort());
				const written = records(directory, writer.runId, (args) =>
					spawnSyncCollect([...command, ...args], {
						cwd: ROOT,
						env: environment,
						timeout: PROCESS_PHASE_TIMEOUT_MS,
					}),
				);
				assert.deepEqual(written.processed, allIds);
				assert.equal(written.eventRecords, EVENTS * SUBSCRIPTIONS);
				assert.deepEqual(written.others, OTHER_SUBSCRIPTIONS_DONE);
				await assertEveryChildSeeded(directory, [writer.label]);
				await assertReports(directory, [writer.label], written.watcherMessages, 0);
			}
			assert.equal(await fileExists(join(directory, "wrong-tree.txt")), false);
			assert.equal(integrity(directory), "ok");
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
			removeTempDirectory(directory);
		}
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);
