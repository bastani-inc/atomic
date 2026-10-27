import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { KEEP_PROVIDER_CREDENTIALS_ENV, PROVIDER_CREDENTIAL_ENV_VARS } from "../helpers/provider-credential-env.js";

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

test("credential-sensitive suites pass when the shell exports every provider credential and endpoint variable", () => {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env[KEEP_PROVIDER_CREDENTIALS_ENV];
	for (const name of PROVIDER_CREDENTIAL_ENV_VARS) env[name] = `fake-${name.toLowerCase()}`;
	const run = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)),
			"--run",
			"--project",
			"unit",
			...CREDENTIAL_SENSITIVE_SUITES,
		],
		{ cwd: root, env, encoding: "utf8", timeout: 540_000 },
	);
	const output = `${run.stdout}\n${run.stderr}`;
	assert.equal(run.status, 0, output.slice(-6000));
}, 600_000);
