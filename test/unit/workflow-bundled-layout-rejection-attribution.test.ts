import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	readText,
	removeTempDirectory,
	spawnSyncCollect,
	symlinkSync,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const ENTRY = join(ROOT, "test/fixtures/workflow-bundled-layout-entry.ts");
const BUILD = join(ROOT, "test/fixtures/workflow-bundled-layout-build.ts");
const RUNNER = join(ROOT, "test/fixtures/workflow-bundled-layout-runner.ts");
const REAL_CHILD_TIMEOUT_MS = 120_000;

interface Runtime {
	readonly name: string;
	readonly command: () => string[];
}

interface Layout {
	readonly name: string;
	readonly bundle: string;
}

const RUNTIMES: readonly Runtime[] = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
];

const RELOCATED: Layout = { name: "relocated bundle", bundle: "relocated/workflows.mjs" };
const PACKAGED: Layout = {
	name: "packaged layout",
	bundle: "packaged/dist/builtin/workflows/src/extension/index.bundle.mjs",
};

interface Outcome {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface Summary {
	readonly status: string;
	readonly error?: string;
}

let workspace = "";

beforeAll(async () => {
	workspace = makeTempDirectory("workflow-bundled-layout-");
	symlinkSync(join(ROOT, "node_modules"), join(workspace, "node_modules"), "junction");
	const built = join(workspace, "built", "bundle.mjs");
	const result = spawnSyncCollect([bunExecutable(), BUILD, ENTRY, built], {
		cwd: ROOT,
		timeout: REAL_CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, `${result.stdout.toString()}\n${result.stderr.toString()}`);
	const text = await readText(built);
	for (const layout of [RELOCATED, PACKAGED]) await writeFileEnsuringDir(join(workspace, layout.bundle), text);
}, REAL_CHILD_TIMEOUT_MS);

afterAll(() => {
	if (workspace !== "") removeTempDirectory(workspace);
});

function runScenario(
	runtime: Runtime,
	layout: Layout,
	scenario: string,
	runtimeFlags: readonly string[] = [],
): Outcome {
	const [executable, ...preload] = runtime.command();
	const result = spawnSyncCollect(
		[executable as string, ...runtimeFlags, ...preload, RUNNER, join(workspace, layout.bundle), scenario],
		{ cwd: ROOT, timeout: REAL_CHILD_TIMEOUT_MS },
	);
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function reported<T>(outcome: Outcome): T {
	return JSON.parse(outcome.stdout.trim().split("\n").at(-1) ?? "") as T;
}

function describeOutcome(outcome: Outcome): string {
	return `${outcome.stdout}\n${outcome.stderr}`;
}

for (const runtime of RUNTIMES) {
	for (const layout of [RELOCATED, PACKAGED]) {
		describe(`workflow rejection attribution through a ${layout.name} on ${runtime.name}`, () => {
			test(
				"an error the author throws in a user workflow fails its run while another workflow's run completes (#3846)",
				() => {
					const outcome = runScenario(runtime, layout, "author-pool");
					assert.equal(outcome.exitCode, 0, describeOutcome(outcome));
					const { pool, healthy } = reported<{ pool: Summary; healthy: Summary }>(outcome);
					assert.equal(pool.status, "failed");
					assert.match(pool.error ?? "", /author error after child/);
					assert.equal(healthy.status, "completed");
				},
				REAL_CHILD_TIMEOUT_MS,
			);

			test(
				"a rejection raised inside the bundle after the runs completed still ends the process (#3846)",
				() => {
					const outcome = runScenario(runtime, layout, "host-rejection-after-runs");
					assert.equal(outcome.exitCode, 1, describeOutcome(outcome));
					assert.equal(reported<{ healthy: Summary }>(outcome).healthy.status, "completed");
					assert.match(outcome.stderr, /createRegistry/);
				},
				REAL_CHILD_TIMEOUT_MS,
			);

			test(
				"a workflow without a name takes the name of the user file that defines it (#3846)",
				() => {
					const outcome = runScenario(runtime, layout, "unnamed");
					assert.equal(outcome.exitCode, 0, describeOutcome(outcome));
					const { name, source } = reported<{ name: string; source?: string }>(outcome);
					assert.equal(name, "workflow-bundled-user-unnamed");
					assert.equal(basename(source ?? ""), "workflow-bundled-user-unnamed.ts");
				},
				REAL_CHILD_TIMEOUT_MS,
			);
		});
	}

	describe(`workflow rejection attribution for host-side rejections through a bundle on ${runtime.name}`, () => {
		test(
			"a rejection raised inside the bundle while a run is live ends the process as before (#3846)",
			() => {
				const outcome = runScenario(runtime, RELOCATED, "host-rejection-live");
				assert.equal(outcome.exitCode, 1, describeOutcome(outcome));
				assert.match(outcome.stderr, /createRegistry/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a rejection raised inside the bundle does not fail a healthy run that is live (#3846)",
			() => {
				const outcome = runScenario(runtime, RELOCATED, "host-rejection-live", ["--unhandled-rejections=warn"]);
				assert.equal(outcome.exitCode, 0, describeOutcome(outcome));
				assert.deepEqual(reported<{ healthy: Summary }>(outcome).healthy, { status: "completed" });
				assert.match(outcome.stderr, /createRegistry/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a rejection raised inside the bundle ends the process when no run was ever started (#3846)",
			() => {
				const outcome = runScenario(runtime, RELOCATED, "host-rejection-no-run");
				assert.equal(outcome.exitCode, 1, describeOutcome(outcome));
				assert.match(outcome.stderr, /createRegistry/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
