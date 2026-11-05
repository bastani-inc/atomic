import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/waiting-stage-session-gc.ts");
/** A child process that loads the SDK from source and runs real stages against a scripted model. */
const SDK_CHILD_PROCESS_TIMEOUT_MS = 120_000;
/**
 * JavaScriptCore scans the stack conservatively, so the most recently used session can stay pinned by a stale stack
 * slot. A leak keeps one session per waiting stage; this bound does not grow with the number of stages.
 */
const CONSERVATIVELY_PINNED_SESSIONS = 1;

const commands = {
	node: [process.execPath, "--expose-gc", "--import", "jiti/register"],
	bun: [bunExecutable()],
} as const;

for (const runtime of ["node", "bun"] as const) {
	for (const mode of ["detached", "release"] as const) {
		test(
			`${runtime}: sessions released by stages waiting ${mode === "detached" ? "on a detachable tool" : "after stage.release()"} can be collected while the stages wait (#4309)`,
			() => {
				const child = spawnSyncCollect([...commands[runtime], FIXTURE, mode], {
					cwd: ROOT,
					timeout: SDK_CHILD_PROCESS_TIMEOUT_MS,
				});
				const output = child.stdout.toString();
				assert.equal(child.exitCode, 0, output + child.stderr.toString());
				const report = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
					readonly stages: number;
					readonly created: number;
					readonly collected: number;
					readonly status: string;
				};
				assert.equal(report.status, "completed");
				assert.equal(report.created, report.stages);
				assert.ok(
					report.created - report.collected <= CONSERVATIVELY_PINNED_SESSIONS,
					`${report.created - report.collected} of ${report.created} released sessions stayed reachable while their stages waited`,
				);
			},
			SDK_CHILD_PROCESS_TIMEOUT_MS,
		);
	}
}
