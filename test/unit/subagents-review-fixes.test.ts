import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { describe, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { INTERCOM_BRIDGE_MARKER } from "../../packages/subagents/src/intercom/intercom-bridge.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, Usage } from "../../packages/subagents/src/shared/types.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
};

function agent(name: string, systemPrompt: string): AgentConfig {
	return {
		name,
		description: `${name} test agent`,
		source: "project",
		filePath: `/tmp/${name}.md`,
		systemPrompt,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

function retainedResult(agentName: string): SingleResult {
	return {
		agent: agentName,
		task: "initial task",
		status: "continued",
		usage,
		finalOutput: "initial output",
		detached: true,
	};
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: { custom: async <T>() => undefined as T },
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		scopedModels: [],
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "parent-session",
			getLeafId: () => null,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: new AbortController().signal,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function stateFor(cwd: string, runs: Array<{ runId: string; agent: AgentConfig }>): ExecutorDeps["state"] {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		foregroundRuns: new Map(
			runs.map(({ runId, agent: childAgent }) => [
				runId,
				{
					runId,
					mode: "single",
					cwd,
					updatedAt: Date.now(),
					children: [
						{
							agent: childAgent.name,
							index: 0,
							status: "detached",
							result: retainedResult(childAgent.name),
						},
					],
				},
			]),
		),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

describe("subagent async-removal regressions", () => {
	test("resuming a retained child preserves the intercom detach option from its agent prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-regression-"));
		try {
			const bridged = agent("bridged", `${INTERCOM_BRIDGE_MARKER}\nCoordinate with the supervisor.`);
			const plain = agent("plain", "Work independently.");
			const options: Array<Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]> = [];
			const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (
				_parentCwd,
				_agents,
				agentName,
				task,
				runOptions,
			) => {
				options.push(runOptions);
				return {
					agent: agentName,
					task,
					status: "ok",
					usage,
					finalOutput: "resumed output",
				};
			};
			const state = stateFor(cwd, [
				{ runId: "run-bridged", agent: bridged },
				{ runId: "run-plain", agent: plain },
			]);
			const deps: ExecutorDeps = {
				pi: {
					events: { on: () => () => {}, emit: () => {} },
					getSessionName: () => "parent-session",
				} as unknown as ExecutorDeps["pi"],
				state,
				config: { parallel: { concurrency: 2, maxTasks: 10 } },
				tempArtifactsDir: join(cwd, "artifacts"),
				getSubagentSessionRoot: () => join(cwd, "sessions"),
				expandTilde: (value) => value,
				discoverAgents: () => ({ agents: [bridged, plain] }),
				runtime: { runSync },
			};
			const executor = createSubagentExecutor(deps);
			const ctx = context(cwd);

			await executor.execute(
				"resume-bridged",
				{ action: "resume", id: "run-bridged", message: "Continue through Intercom." },
				ctx.signal!,
				undefined,
				ctx,
			);
			await executor.execute(
				"resume-plain",
				{ action: "resume", id: "run-plain", message: "Continue normally." },
				ctx.signal!,
				undefined,
				ctx,
			);

			assert.equal(options.length, 2);
			assert.equal(options[0]?.allowIntercomDetach, true);
			assert.equal(options[1]?.allowIntercomDetach, false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
