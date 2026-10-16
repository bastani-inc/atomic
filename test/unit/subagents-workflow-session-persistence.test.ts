import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionHeader } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";

const workflow = { runId: "run-1", stageId: "stage-1", stageName: "build" };

function agentConfig(): AgentConfig {
	return {
		name: "fake-worker",
		description: "Fake worker",
		source: "project",
		filePath: "fake-worker.md",
		systemPrompt: "Finish immediately.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

function readHeader(path: string): SessionHeader {
	return JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as SessionHeader;
}

describe("workflow subagent persisted session classification", () => {
	test("foreground fresh child persists classification through the real executor handoff", async () => {
		const root = mkdtempSync(join(tmpdir(), "workflow-subagent-persist-"));
		try {
			const result = await runSingleInProcess(root, agentConfig(), "fresh child", {
				cwd: root,
				runId: "foreground-fresh",
				sessionDir: join(root, "custom-sessions"),
				workflowStageSubagentGuard: true,
				workflowSessionMetadata: workflow,
				testSession: { output: "done" },
			});
			assert.equal(result.status, "ok");
			assert.ok(result.sessionFile);
			assert.deepEqual(readHeader(result.sessionFile).workflow, workflow);
			assert.equal(readHeader(result.sessionFile).internal, true);
			assert.deepEqual(await SessionManager.list(root, dirname(result.sessionFile)), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("same-cwd fork child stays classified through fork resolver and foreground executor", async () => {
		const root = mkdtempSync(join(tmpdir(), "workflow-subagent-fork-"));
		try {
			const sessionDir = join(root, "fork-sessions");
			const parent = await SessionManager.create(root, sessionDir, { internal: true, workflow });
			const leafId = await parent.appendMessage({ role: "user", content: "parent task", timestamp: Date.now() });
			assert.ok(parent.getSessionFile());
			assert.equal(parent.getLeafId(), leafId);
			const fork = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			assert.ok(fork);
			const result = await runSingleInProcess(root, agentConfig(), "Continue fork", {
				cwd: root,
				runId: "foreground-fork",
				sessionManager: fork,
				workflowStageSubagentGuard: true,
				testSession: { output: "done" },
			});
			assert.equal(result.status, "ok");
			assert.ok(result.stats);
			assert.equal(result.stats.sessionId, fork.getSessionId());
			assert.ok(result.sessionFile);
			assert.equal(readHeader(result.sessionFile).internal, true);
			assert.deepEqual(readHeader(result.sessionFile).workflow, workflow);
			assert.deepEqual(await SessionManager.list(root, sessionDir), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
