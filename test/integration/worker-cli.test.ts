import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const cli = fileURLToPath(new URL("../../packages/coding-agent/src/cli.ts", import.meta.url));
const CLI_STARTUP_TIMEOUT_MS = 60_000;

test(
	"atomic worker reports its removal instead of starting a host or treating worker as a prompt",
	() => {
		const root = makeTempDirectory("worker-cli-");
		try {
			const result = spawnSyncCollect([bunExecutable(), cli, "worker"], {
				cwd: root,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
					ATOMIC_OFFLINE: "1",
					ATOMIC_WORKFLOWS_JOURNAL: "",
					ATOMIC_WORKFLOW_JOURNAL_PATH: "",
					ATOMIC_WORKFLOW_ARTIFACT_DIR: "",
				},
				timeout: CLI_STARTUP_TIMEOUT_MS,
			});
			assert.equal(result.exitCode, 1, result.stderr.toString());
			assert.match(
				result.stderr.toString().trim(),
				/^Error: "atomic worker" was removed in 0\.10\.0 with workflows\.[^\n]*$/,
			);
			assert.equal(result.stdout.toString(), "");
		} finally {
			removeTempDirectory(root);
		}
	},
	CLI_STARTUP_TIMEOUT_MS,
);

test(
	"startup warns once about retired public workflow variables without printing their values",
	() => {
		const root = makeTempDirectory("removed-workflow-env-");
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			const removed = {
				ATOMIC_WORKFLOWS_JOURNAL: "private-journal-selection",
				ATOMIC_WORKFLOW_JOURNAL_PATH: "private-journal-path",
				ATOMIC_WORKFLOW_ARTIFACT_DIR: "private-artifact-path",
			};
			const run = () =>
				spawnSyncCollect([bunExecutable(), cli, "blueprint", "--help"], {
					cwd: root,
					env: { ...process.env, ...removed, ATOMIC_CODING_AGENT_DIR: agentDir, ATOMIC_OFFLINE: "1" },
					timeout: CLI_STARTUP_TIMEOUT_MS,
				});
			const first = run();
			assert.equal(first.exitCode, 0, first.stderr.toString());
			const warning = first.stderr.toString().trim();
			assert.match(warning, /^[^\n]*removed in 0\.10\.0[^\n]*$/i);
			for (const [name, value] of Object.entries(removed)) {
				assert.ok(warning.includes(name), warning);
				assert.ok(!warning.includes(value), "the warning must not expose the old selection or path");
			}
			const again = run();
			assert.equal(again.exitCode, 0, again.stderr.toString());
			assert.equal(again.stderr.toString(), "");
			assert.equal(again.stdout.toString(), first.stdout.toString());
		} finally {
			removeTempDirectory(root);
		}
	},
	2 * CLI_STARTUP_TIMEOUT_MS,
);
