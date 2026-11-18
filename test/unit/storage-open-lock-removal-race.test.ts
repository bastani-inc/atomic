import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { makeTempDirectory, moduleDir, readStreamText, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";

const CHURNING_PROCESSES = 3;
const CHURN_MS = 4_000;
const CHURN_TEST_TIMEOUT_MS = 60_000;
const churnFixture = join(moduleDir(import.meta.url), "..", "fixtures", "open-lock-churn.mjs");

interface ChurnReport {
	readonly removals: number;
	readonly sharedLocks: number;
	readonly refusals: Record<string, number>;
}

test(
	"an open lock that other processes keep removing and recreating is never refused as a permission error (#5317)",
	async () => {
		const directory = makeTempDirectory("open-lock-removal-race-");
		try {
			const lockPath = join(directory, "shard.sqlite-open.lock");
			const children = Array.from({ length: CHURNING_PROCESSES }, () =>
				spawnProcess([process.execPath, churnFixture, lockPath, String(CHURN_MS)], {
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const reports = await Promise.all(
				children.map(async (child) => {
					const [stdout, stderr] = await Promise.all([readStreamText(child.stdout), readStreamText(child.stderr)]);
					assert.equal(await child.exited, 0, stderr);
					return JSON.parse(stdout) as ChurnReport;
				}),
			);
			for (const report of reports) {
				assert.ok(report.removals > 0 && report.sharedLocks > 0, JSON.stringify(report));
				assert.deepEqual(report.refusals, {}, JSON.stringify(report));
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
	CHURN_TEST_TIMEOUT_MS,
);
