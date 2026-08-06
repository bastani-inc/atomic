import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import { filterSpawnableModelCandidates } from "../../packages/subagents/src/runs/shared/model-candidate-filter.js";

function agentConfig(): AgentConfig {
	return {
		name: "fake-worker",
		description: "Fake worker",
		source: "project",
		filePath: "fake-worker.md",
		systemPrompt: "Work.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		model: "provider-a/stalled",
		fallbackModels: ["provider-b/working"],
	};
}

describe("subagent pre-spawn model candidate filtering", () => {
	test("pre-spawn filtering skips known keyless providers but keeps unknowns and current model", () => {
		const filtered = filterSpawnableModelCandidates({
			candidates: ["provider-a/missing", "custom/model", "provider-b/ready", "provider-a/current"],
			availableModels: [{ provider: "provider-b", id: "ready", fullId: "provider-b/ready" }],
			knownModelProviders: ["provider-a", "provider-b"],
			currentModel: "provider-a/current",
		});

		assert.deepEqual(filtered.candidates, ["custom/model", "provider-b/ready", "provider-a/current"]);
		assert.deepEqual(
			filtered.skippedAttempts.map((attempt) => attempt.model),
			["provider-a/missing"],
		);
		assert.match(filtered.skippedAttempts[0]?.error ?? "", /no configured API key\/auth/);

		const noAvailable = filterSpawnableModelCandidates({
			candidates: ["provider-a/missing", "custom/model"],
			availableModels: [],
			knownModelProviders: ["provider-a"],
		});
		assert.deepEqual(noAvailable.candidates, ["custom/model"]);
		assert.deepEqual(
			noAvailable.skippedAttempts.map((attempt) => attempt.model),
			["provider-a/missing"],
		);
	});

	test("does not start a child when every configured candidate is filtered", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-model-filter-"));
		try {
			const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
				cwd: dir,
				runId: "all-filtered",
				availableModels: [],
				knownModelProviders: ["provider-a", "provider-b"],
				testSession: { output: "should not run" },
			});

			assert.equal(result.status, "error");
			assert.match(result.error ?? "", /No spawnable subagent model candidates/);
			assert.equal(existsSync(join(dir, "spawned")), false);
			assert.deepEqual(
				result.modelAttempts?.map((attempt) => attempt.model),
				["provider-a/stalled", "provider-b/working"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("foreground parallel tasks pass known providers into runSync", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-parallel-known-"));
		try {
			const knownModelProviders = ["provider-a", "provider-b"];
			const captured: Array<{ knownModelProviders?: string[] }> = [];
			const input: Parameters<typeof runForegroundParallelTasks>[0] = {
				tasks: [{ agent: "fake-worker", task: "Do work" }],
				taskTexts: ["Do work"],
				agents: [agentConfig()],
				ctx: {
					cwd: dir,
					model: { provider: "provider-b", id: "working" },
				} as Parameters<typeof runForegroundParallelTasks>[0]["ctx"],
				intercomEvents: {} as Parameters<typeof runForegroundParallelTasks>[0]["intercomEvents"],
				signal: new AbortController().signal,
				runId: "parallel-known-providers",
				sessionDirForIndex: () => undefined,
				sessionFileForIndex: () => undefined,
				shareEnabled: false,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 0,
				},
				artifactsDir: dir,
				paramsCwd: dir,
				maxSubagentDepths: [0],
				availableModels: [{ provider: "provider-b", id: "working", fullId: "provider-b/working" }],
				knownModelProviders,
				modelOverrides: ["provider-a/stalled"],
				behaviors: [{ output: false, outputMode: "inline", reads: false, progress: false, skills: false }],
				firstProgressIndex: -1,
				controlConfig: {
					enabled: false,
					needsAttentionAfterMs: 1,
					activeNoticeAfterMs: 1,
					failedToolAttemptsBeforeAttention: 1,
					notifyOn: [],
					notifyChannels: [],
				},
				concurrencyLimit: 1,
				liveResults: [],
				liveProgress: [],
				runtime: {
					async runSync(_cwd, _agents, agentName, task, options) {
						captured.push({ knownModelProviders: options.knownModelProviders });
						return {
							agent: agentName,
							task,
							status: "ok",
							messages: [],
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							finalOutput: "ok",
						};
					},
				},
			};

			await runForegroundParallelTasks(input);
			assert.deepEqual(captured, [{ knownModelProviders }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
