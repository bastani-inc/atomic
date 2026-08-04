import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/inprocess/background-single.js";
import { ASYNC_DIR } from "../../packages/subagents/src/shared/types.js";

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

function testPi(): ExtensionAPI {
	return { events: { emit: () => {} } } as unknown as ExtensionAPI;
}

test("executeAsyncSingle initializes progress in isolated async storage", async () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-async-parent-"));
	const childCwd = join(parentCwd, "child");
	const artifactsDir = join(parentCwd, "disabled-artifacts");
	mkdirSync(childCwd);
	const cwdProgressPath = join(childCwd, "progress.md");
	writeFileSync(cwdProgressPath, "project sentinel");
	const runId = `progress-${crypto.randomUUID()}`;
	try {
		const result = await executeAsyncSingle(runId, {
			agent: "worker",
			task: "implement the fix",
			agentConfig: makeAgent(),
			ctx: {
				pi: testPi(),
				cwd: parentCwd,
				currentSessionId: "parent",
				workflowSessionMetadata: { runId: "run-1", stageId: "stage-1", stageName: "build" },
			},
			cwd: "child",
			artifactsDir,
			artifactConfig,
			shareEnabled: false,
			progress: true,
			maxSubagentDepth: 1,
		});

		const progressPath = join(ASYNC_DIR, runId, "progress", "progress.md");
		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0]?.status, "continued");
		assert.match(result.details.results[0]?.path ?? "", new RegExp(`^${runId}/`));
		assert.equal(existsSync(join(parentCwd, "progress.md")), false, "parent cwd must not receive progress");
		assert.equal(readFileSync(cwdProgressPath, "utf8"), "project sentinel");
		assert.equal(existsSync(progressPath), true);
		assert.equal(existsSync(join(artifactsDir, "progress", runId, "progress.md")), false);
		assert.match(readFileSync(progressPath, "utf8"), /# Progress/);
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(parentCwd, { recursive: true, force: true });
	}
});

test("executeAsyncSingle prefers run-scoped artifact storage", async () => {
	const parentCwd = mkdtempSync(join(tmpdir(), "atomic-subagent-async-artifacts-"));
	const artifactsDir = join(parentCwd, "artifacts");
	const runId = `progress-${crypto.randomUUID()}`;
	try {
		const result = await executeAsyncSingle(runId, {
			agent: "worker",
			task: "implement the fix",
			agentConfig: makeAgent(),
			ctx: {
				pi: testPi(),
				cwd: parentCwd,
				currentSessionId: "parent",
			},
			artifactsDir,
			artifactConfig: { ...artifactConfig, enabled: true },
			shareEnabled: false,
			progress: true,
			maxSubagentDepth: 1,
		});

		const progressPath = join(artifactsDir, "progress", runId, "progress.md");
		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0]?.status, "continued");
		assert.equal(existsSync(progressPath), true);
		assert.equal(existsSync(join(parentCwd, "progress.md")), false);
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
		rmSync(parentCwd, { recursive: true, force: true });
	}
});
