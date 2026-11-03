import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/workflow-retired-rejection-same-id.ts");
const REAL_CHILD_TIMEOUT_MS = 120_000;

interface Runtime {
	readonly name: string;
	readonly command: () => string[];
}

const RUNTIMES: readonly Runtime[] = [
	{ name: "Node", command: () => [process.execPath, "--import", "jiti/register"] },
	{ name: "Bun", command: () => [bunExecutable()] },
];

interface RunReport {
	readonly status: string;
	readonly error?: string;
}

interface Report {
	readonly first: RunReport;
	readonly replacement: RunReport;
}

for (const runtime of RUNTIMES) {
	describe(`retired execution rejection on ${runtime.name}`, () => {
		test(
			"a retired execution's late rejection never fails its replacement with the same durable run ID (#4192)",
			() => {
				const [executable, ...preload] = runtime.command();
				const result = spawnSyncCollect(
					[executable as string, "--unhandled-rejections=warn", ...preload, FIXTURE],
					{ cwd: ROOT, env: process.env, timeout: REAL_CHILD_TIMEOUT_MS },
				);
				const stdout = result.stdout.toString();
				assert.equal(result.exitCode, 0, `${stdout}\n${result.stderr.toString()}`);
				const reported = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Report;
				assert.equal(reported.first.status, "completed");
				assert.deepEqual(reported.replacement, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
