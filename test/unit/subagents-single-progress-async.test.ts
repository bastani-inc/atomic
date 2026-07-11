import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("executeAsyncSingle initializes progress in isolated async storage", () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-async-parent-"));
	const childCwd = join(parentCwd, "child");
	mkdirSync(childCwd);
	const cwdProgressPath = join(childCwd, "progress.md");
	writeFileSync(cwdProgressPath, "project sentinel");
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

		const progressPath = join(ASYNC_DIR, runId, "progress", "progress.md");
		assert.equal(result.isError, undefined);
		assert.equal(existsSync(join(parentCwd, "progress.md")), false, "parent cwd must not receive progress");
		assert.equal(readFileSync(cwdProgressPath, "utf8"), "project sentinel");
		assert.equal(existsSync(progressPath), true);
		assert.match(readFileSync(progressPath, "utf8"), /# Progress/);
		assert.equal(captured?.steps[0]?.cwd, childCwd);
		assert.ok((captured?.steps[0]?.task ?? "").includes(`Create and maintain progress at: ${progressPath}`));
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(parentCwd, { recursive: true, force: true });
	}
});

test("executeAsyncSingle prefers run-scoped artifact storage", () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-async-artifacts-"));
	const artifactsDir = join(parentCwd, "artifacts");
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
			artifactsDir,
			artifactConfig: { ...artifactConfig, enabled: true },
			shareEnabled: false,
			progress: true,
			maxSubagentDepth: 1,
			spawnRunner: (config) => {
				captured = config as CapturedRunnerConfig;
				return { pid: 1234 };
			},
		});

		const progressPath = join(artifactsDir, "progress", runId, "progress.md");
		assert.equal(result.isError, undefined);
		assert.equal(existsSync(progressPath), true);
		assert.ok((captured?.steps[0]?.task ?? "").includes(`Create and maintain progress at: ${progressPath}`));
		assert.equal(existsSync(join(parentCwd, "progress.md")), false);
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(parentCwd, { recursive: true, force: true });
	}
});
