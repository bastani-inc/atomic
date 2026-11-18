import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { runCliProcess } from "./cli-test-helpers.js";

/** A real CLI process transpiles the CLI graph before it reads any settings. */
const REAL_CLI_PROCESS_TIMEOUT_MS = 120_000;

describe("atomic -p with an ignored legacy routerModel", () => {
	it(
		"names it on the first start only, without rewriting settings.json",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-ignored-router-model-cli-"));
			try {
				const agentDir = join(root, "agent");
				const cwd = join(root, "project");
				mkdirSync(agentDir, { recursive: true });
				mkdirSync(cwd, { recursive: true });
				const saved = JSON.stringify({ decisionModel: "auto", routerModel: "openai/gpt-6.1-sol" });
				writeFileSync(join(agentDir, "settings.json"), saved);
				const start = async () => {
					const result = await runCliProcess(["-p", "hi", "--no-session", "--no-extensions", "--no-skills"], {
						cwd,
						timeoutMs: REAL_CLI_PROCESS_TIMEOUT_MS,
						env: {
							...process.env,
							[ENV_AGENT_DIR]: agentDir,
							ATOMIC_OFFLINE: "1",
							ATOMIC_SKIP_VERSION_CHECK: "1",
							ATOMIC_INTERACTIVE_ENGINE_CHILD: undefined,
							ATOMIC_INTERCOM_GROUP: undefined,
							PI_INTERCOM_GROUP: undefined,
							NO_COLOR: "1",
						},
					});
					assert.equal(result.timedOut, false, result.stderr);
					return result.stderr.split("\n").filter((line) => line.includes('"routerModel"'));
				};

				const first = await start();
				assert.equal(first.length, 1, first.join("\n"));
				assert.match(first[0]!, /Ignored legacy "routerModel" because "decisionModel" is already set/);
				assert.deepEqual(await start(), [], "the next start says nothing");
				assert.equal(readFileSync(join(agentDir, "settings.json"), "utf-8"), saved);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		REAL_CLI_PROCESS_TIMEOUT_MS * 2,
	);
});
