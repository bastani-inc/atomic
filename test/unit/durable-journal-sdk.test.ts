import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RunJournal, RunOpts } from "@bastani/workflows";
import { test } from "vitest";
import type { RunJournal as KernelRunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
const journalIdentity: Equal<RunJournal, KernelRunJournal> = true;
const optionIdentity: Equal<
	NonNullable<RunOpts["journal"]>,
	{ path: string } | { database: DatabaseSync } | { memory: true } | RunJournal
> = true;
const SDK_PROCESS_TIMEOUT_MS = 120_000;

test("public journal types retain exact option and RunJournal identities", () => {
	assert.equal(journalIdentity, true);
	assert.equal(optionIdentity, true);
});

for (const runtime of ["node", "bun"] as const) {
	test(
		`public journal SDK executes selection, fencing, persistence and conformance under ${runtime}`,
		() => {
			const directory = makeTempDirectory(`journal-sdk-${runtime}-`);
			try {
				const executable = runtime === "bun" ? bunExecutable() : process.execPath;
				const result = spawnSyncCollect([
					executable,
					join(moduleDir(import.meta.url), "../fixtures/journal-configuration-sdk.mjs"),
					directory,
				]);
				assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
				assert.deepEqual(JSON.parse(result.stdout.toString()), {
					runtime,
					publicConformance: 10,
					status: "passed",
				});
			} finally {
				removeTempDirectory(directory);
			}
		},
		SDK_PROCESS_TIMEOUT_MS,
	);
}
