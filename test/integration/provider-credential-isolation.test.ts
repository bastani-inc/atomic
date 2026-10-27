import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { KEEP_PROVIDER_CREDENTIALS_ENV, PROVIDER_CREDENTIAL_ENV_VARS } from "../helpers/provider-credential-env.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Suites that broke when a developer's shell exported a provider credential:
 * `COPILOT_GITHUB_TOKEN` alone made the whole `github-copilot` catalog available,
 * so `auto` routing chose Copilot models and a live child tried to reach Copilot.
 */
const CREDENTIAL_SENSITIVE_SUITES = [
	"test/unit/subagent-model-router.test.ts",
	"test/unit/subagent-model-router-execution.test.ts",
	"test/unit/subagents-inprocess-runner.test.ts",
	"test/unit/workflow-stage-auto.test.ts",
];

/**
 * Budget for a real vitest child run of the four suites above. Its cost is structural: a fresh vitest
 * process with its global setups, and live in-process children whose own tests allow two minutes for a
 * resource reload. It takes about 15 s on an idle machine; the headroom absorbs full-suite parallel load.
 */
const REAL_VITEST_CREDENTIAL_SUITES_TIMEOUT_MS = 600_000;
/** Kill the child before the test's own budget ends, so a stall still reports the child's output. */
const CHILD_KILL_MARGIN_MS = 60_000;

test(
	"credential-sensitive suites pass when the shell exports every provider credential and endpoint variable",
	() => {
		const env: Record<string, string | undefined> = { ...process.env };
		delete env[KEEP_PROVIDER_CREDENTIALS_ENV];
		for (const name of PROVIDER_CREDENTIAL_ENV_VARS) env[name] = `fake-${name.toLowerCase()}`;
		const run = spawnSyncCollect(
			[
				process.execPath,
				fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)),
				"--run",
				"--project",
				"unit",
				...CREDENTIAL_SENSITIVE_SUITES,
			],
			{ cwd: root, env, timeout: REAL_VITEST_CREDENTIAL_SUITES_TIMEOUT_MS - CHILD_KILL_MARGIN_MS },
		);
		const output = `${run.stdout.toString()}\n${run.stderr.toString()}`;
		assert.equal(run.exitCode, 0, output.slice(-6000));
	},
	REAL_VITEST_CREDENTIAL_SUITES_TIMEOUT_MS,
);
