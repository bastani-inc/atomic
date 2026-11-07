import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SESSIONS_STORAGE_ENV } from "../src/core/storage/process-selection.js";
import { runCliProcess } from "./cli-test-helpers.ts";

useTemporaryAgentDir();

/** A real CLI child process: startup loads the whole application before the preflight runs. */
const REAL_CLI_PREFLIGHT_TIMEOUT_MS = 120_000;

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-resume-preflight-"));
	mkdirSync(join(root, "project"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test(
	"a resume on a node whose shared storage is not set up fails at startup naming every missing piece (#4329)",
	async () => {
		const selection = {
			adapter: "@acme/atomic-storage-not-installed",
			options: { url: "http://127.0.0.1:9" },
			secrets: { authToken: { file: join(root, "missing-token") } },
		};
		const result = await runCliProcess(["--session", "recorded-on-node-a", "--no-extensions", "-p", "unused"], {
			cwd: join(root, "project"),
			env: {
				...process.env,
				[ENV_AGENT_DIR]: join(root, "agent"),
				[SESSIONS_STORAGE_ENV]: JSON.stringify(selection),
				FORCE_COLOR: "0",
			},
			timeoutMs: REAL_CLI_PREFLIGHT_TIMEOUT_MS,
		});
		assert.equal(result.timedOut, false);
		assert.equal(result.code, 1);
		const stderr = result.stderr.trim();
		assert.match(
			stderr,
			/^Error: Cannot resume here: storage adapter @acme\/atomic-storage-not-installed \(adapter-not-installed\)/,
		);
		assert.ok(stderr.includes(`token file ${join(root, "missing-token")} (credential-missing)`), stderr);
		assert.match(
			stderr,
			/\(preconditions-unmet\)\. Install it with `atomic install npm:@acme\/atomic-storage-not-installed`\./,
		);
		assert.match(stderr, /atomic team join <url> --token-file <path>/);
		assert.doesNotMatch(stderr, /127\.0\.0\.1:9/);
	},
	REAL_CLI_PREFLIGHT_TIMEOUT_MS,
);
