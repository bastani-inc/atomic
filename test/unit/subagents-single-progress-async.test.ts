import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/background/async-execution-single.js";
import { ASYNC_DIR } from "../../packages/subagents/src/shared/types.js";

interface CapturedRunnerConfig {
	steps: Array<{ task: string; cwd: string }>;
}

const artifactConfig = {
	enabled: false,
	includeInput: false,
	includeOutput: false,
	includeJsonl: false,
	includeMetadata: false,
	cleanupDays: 0,
};

function makeAgent(): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Test agent",
		source: "project",
		filePath: "/tmp/worker.md",
	};
}

test("executeAsyncSingle initializes progress in effective cwd and injects its instruction", () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-async-parent-"));
	const childCwd = join(parentCwd, "child");
	mkdirSync(childCwd);
	const runId = `progress-${crypto.randomUUID()}`;
	let captured: CapturedRunnerConfig | undefined;
	try {
		const result = executeAsyncSingle(runId, {
			agent: "worker",
			task: "implement the fix",
			agentConfig: makeAgent(),
			ctx: {
				pi: { events: { emit: () => {} } } as unknown as ExtensionAPI,
				cwd: parentCwd,
				currentSessionId: "parent",
			},
			cwd: "child",
			artifactConfig,
			shareEnabled: false,
			progress: true,
			maxSubagentDepth: 1,
			spawnRunner: (config) => {
				captured = config as CapturedRunnerConfig;
				return { pid: 1234 };
			},
		});

		assert.equal(result.isError, undefined);
		assert.equal(existsSync(join(parentCwd, "progress.md")), false, "parent cwd must not receive progress");
		assert.equal(existsSync(join(childCwd, "progress.md")), true);
		assert.match(readFileSync(join(childCwd, "progress.md"), "utf8"), /# Progress/);
		assert.equal(captured?.steps[0]?.cwd, childCwd);
		assert.match(captured?.steps[0]?.task ?? "", new RegExp(`Create and maintain progress at: ${join(childCwd, "progress.md")}`));
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(parentCwd, { recursive: true, force: true });
	}
});
