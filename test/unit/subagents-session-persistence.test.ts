import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";

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

describe("persisted subagent sessions", () => {
	test("a fresh child can be looked up in its own session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "internal-subagent-persist-"));
		try {
			const result = await runSingleInProcess(root, agentConfig(), "fresh child", {
				cwd: root,
				runId: "foreground-fresh",
				sessionDir: join(root, "custom-sessions"),
				testSession: { output: "done" },
			});
			assert.equal(result.status, "ok");
			assert.ok(result.sessionFile);
			assert.deepEqual(
				(await SessionManager.list(root, dirname(result.sessionFile))).map((session) => session.id),
				[result.stats?.sessionId],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a forked child can be looked up alongside its parent under its own session id", async () => {
		const root = mkdtempSync(join(tmpdir(), "internal-subagent-fork-"));
		try {
			const sessionDir = join(root, "fork-sessions");
			const parent = await SessionManager.create(root, sessionDir);
			const leafId = await parent.appendMessage({ role: "user", content: "parent task", timestamp: Date.now() });
			assert.ok(parent.getSessionFile());
			assert.equal(parent.getLeafId(), leafId);
			const fork = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			assert.ok(fork);
			const result = await runSingleInProcess(root, agentConfig(), "Continue fork", {
				cwd: root,
				runId: "foreground-fork",
				sessionManager: fork,
				testSession: { output: "done" },
			});
			assert.equal(result.status, "ok");
			assert.ok(result.stats);
			assert.equal(result.stats.sessionId, fork.getSessionId());
			assert.ok(result.sessionFile);
			assert.deepEqual(
				(await SessionManager.list(root, sessionDir)).map((session) => session.id).sort(),
				[parent.getSessionId(), fork.getSessionId()].sort(),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
