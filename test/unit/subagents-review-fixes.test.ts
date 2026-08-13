import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { getArtifactsDir } from "../../packages/subagents/src/shared/artifacts.js";
import type {
	SingleResult,
	SubagentResultStatus,
	SubagentToolResult,
	Usage,
} from "../../packages/subagents/src/shared/types.js";

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

function retainedResult(agentName: string, status: SubagentResultStatus = "detached"): SingleResult {
	if (status === "detached") {
		return {
			agent: agentName,
			task: "initial task",
			status: "continued",
			usage,
			finalOutput: "initial output",
			detached: true,
		};
	}
	if (status === "paused") {
		return {
			agent: agentName,
			task: "initial task",
			status: "interrupted",
			usage,
			finalOutput: "initial output",
			interrupted: true,
		};
	}
	if (status === "completed") {
		return {
			agent: agentName,
			task: "initial task",
			status: "ok",
			usage,
			finalOutput: "initial output",
		};
	}
	return {
		agent: agentName,
		task: "initial task",
		status: "error",
		usage,
		finalOutput: "initial output",
		error: "initial error",
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

function stateFor(
	cwd: string,
	runs: Array<{ runId: string; agent: AgentConfig; status?: SubagentResultStatus }>,
): ExecutorDeps["state"] {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		foregroundRuns: new Map(
			runs.map(({ runId, agent: childAgent, status = "detached" }) => [
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
							status,
							result: retainedResult(childAgent.name, status),
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

	test("resuming a detached child wires completion delivery and progress cleanup", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-detach-regression-"));
		const runId = "run-detached-completion";
		const emittedEvents: string[] = [];
		try {
			const bridged = agent("bridged", `${INTERCOM_BRIDGE_MARKER}\nCoordinate with the supervisor.`);
			const options: Array<Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]> = [];
			const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (
				_parentCwd,
				_agents,
				agentName,
				_task,
				runOptions,
			) => {
				options.push(runOptions);
				return retainedResult(agentName);
			};
			const state = stateFor(cwd, [{ runId, agent: bridged }]);
			const deps: ExecutorDeps = {
				pi: {
					events: {
						on: () => () => {},
						emit: (event: string) => {
							emittedEvents.push(event);
						},
					},
					getSessionName: () => "parent-session",
				} as unknown as ExecutorDeps["pi"],
				state,
				config: { parallel: { concurrency: 2, maxTasks: 10 } },
				tempArtifactsDir: join(cwd, "artifacts"),
				getSubagentSessionRoot: () => join(cwd, "sessions"),
				expandTilde: (value) => value,
				discoverAgents: () => ({ agents: [bridged] }),
				runtime: { runSync },
			};
			const executor = createSubagentExecutor(deps);
			const ctx = context(cwd);

			await executor.execute(
				"resume-detached",
				{ action: "resume", id: runId, message: "Continue through Intercom.", artifacts: false, progress: true },
				ctx.signal!,
				undefined,
				ctx,
			);

			const progressDir = join(getArtifactsDir(null), "progress", runId);
			assert.equal(typeof options[0]?.onDetachedExit, "function");
			assert.equal(existsSync(progressDir), true, "detached children retain progress storage until completion");

			const completed: SingleResult = {
				agent: "bridged",
				task: "resumed task",
				status: "ok",
				usage,
				finalOutput: "completed output",
			};
			options[0]?.onDetachedExit?.(completed);

			const child = state.foregroundRuns?.get(runId)?.children[0];
			assert.equal(child?.result?.status, "ok");
			assert.equal(child?.result?.finalOutput, "completed output");
			assert.equal(existsSync(progressDir), false, "completion callback cleans detached progress storage");
			assert.ok(emittedEvents.includes("subagent:complete"));
		} finally {
			rmSync(join(getArtifactsDir(null), "progress", runId), { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("resuming gates the artifact directory by the artifact setting", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-artifacts-regression-"));
		try {
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
				return { agent: agentName, task, status: "ok", usage, finalOutput: "resumed output" };
			};
			const state = stateFor(cwd, [
				{ runId: "run-artifacts-disabled", agent: plain },
				{ runId: "run-artifacts-enabled", agent: plain },
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
				discoverAgents: () => ({ agents: [plain] }),
				runtime: { runSync },
			};
			const executor = createSubagentExecutor(deps);
			const ctx = context(cwd);

			await executor.execute(
				"resume-artifacts-disabled",
				{
					action: "resume",
					id: "run-artifacts-disabled",
					message: "Continue without artifacts.",
					artifacts: false,
				},
				ctx.signal!,
				undefined,
				ctx,
			);
			await executor.execute(
				"resume-artifacts-enabled",
				{ action: "resume", id: "run-artifacts-enabled", message: "Continue with artifacts.", artifacts: true },
				ctx.signal!,
				undefined,
				ctx,
			);

			assert.equal(options.length, 2);
			assert.equal(options[0]?.artifactsDir, undefined);
			assert.equal(options[1]?.artifactsDir, getArtifactsDir(null));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("resuming forwards live progress updates through the tool callback", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-updates-regression-"));
		const runId = "run-progress-update";
		try {
			const plain = agent("plain", "Work independently.");
			const options: Array<Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]> = [];
			const forwarded: SubagentToolResult[] = [];
			const progressUpdate: SubagentToolResult = {
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "single",
					runId,
					results: [],
					progress: [
						{
							index: 0,
							agent: "plain",
							status: "running",
							task: "resumed task",
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							tokens: 2,
							durationMs: 3,
						},
					],
				},
			};
			const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (
				_parentCwd,
				_agents,
				agentName,
				task,
				runOptions,
			) => {
				options.push(runOptions);
				runOptions.onUpdate?.(progressUpdate);
				return { agent: agentName, task, status: "ok", usage, finalOutput: "resumed output" };
			};
			const state = stateFor(cwd, [{ runId, agent: plain }]);
			state.foregroundControls.set(runId, {
				runId,
				mode: "single",
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
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
				discoverAgents: () => ({ agents: [plain] }),
				runtime: { runSync },
			};
			const executor = createSubagentExecutor(deps);
			const ctx = context(cwd);
			const onUpdate = (update: SubagentToolResult): void => {
				forwarded.push(update);
			};

			await executor.execute(
				"resume-progress-update",
				{ action: "resume", id: runId, message: "Continue with progress." },
				ctx.signal!,
				onUpdate,
				ctx,
			);

			assert.equal(typeof options[0]?.onUpdate, "function");
			assert.equal(forwarded.length, 1);
			assert.strictEqual(forwarded[0], progressUpdate);
			const control = state.foregroundControls.get(runId);
			assert.equal(control?.currentAgent, "plain");
			assert.equal(control?.currentIndex, 0);
			assert.equal(control?.tokens, 2);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("resuming retained children refreshes non-detached records without weakening late detach protection", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-resume-retained-record-regression-"));
		try {
			const plain = agent("plain", "Work independently.");
			const fixtures = [
				{ runId: "run-paused", status: "paused" as const },
				{ runId: "run-completed", status: "completed" as const },
				{ runId: "run-detached", status: "detached" as const },
			];
			const options: Array<Parameters<SubagentExecutorRuntimeDeps["runSync"]>[4]> = [];
			const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (
				_parentCwd,
				_agents,
				agentName,
				task,
				runOptions,
			) => {
				options.push(runOptions);
				const detached = runOptions.runId === "run-detached";
				return {
					agent: agentName,
					task,
					status: detached ? "continued" : "ok",
					usage,
					finalOutput: `fresh output for ${runOptions.runId}`,
					...(detached ? { detached: true } : {}),
				};
			};
			const state = stateFor(
				cwd,
				fixtures.map((fixture) => ({ ...fixture, agent: plain })),
			);
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
				discoverAgents: () => ({ agents: [plain] }),
				runtime: { runSync },
			};
			const executor = createSubagentExecutor(deps);
			const ctx = context(cwd);

			for (const [index, fixture] of fixtures.entries()) {
				await executor.execute(
					`resume-${fixture.runId}`,
					{ action: "resume", id: fixture.runId, message: "Continue with fresh output." },
					ctx.signal!,
					undefined,
					ctx,
				);

				const expectedStatus = fixture.status === "detached" ? "detached" : "completed";
				const child = state.foregroundRuns?.get(fixture.runId)?.children[0];
				assert.equal(child?.status, expectedStatus);
				assert.equal(child?.result?.finalOutput, `fresh output for ${fixture.runId}`);

				const status = await executor.execute(
					`status-${fixture.runId}`,
					{ action: "status", id: fixture.runId },
					ctx.signal!,
					undefined,
					ctx,
				);
				const statusText = status.content[0]?.type === "text" ? status.content[0].text : "";
				assert.match(statusText, new RegExp(`State: ${expectedStatus}`));
				assert.match(statusText, new RegExp(`fresh output for ${fixture.runId}`));
				assert.doesNotMatch(statusText, /initial output/);

				if (fixture.status !== "detached") {
					assert.equal(typeof options[index]?.onDetachedExit, "function");
					options[index]?.onDetachedExit?.({
						agent: "plain",
						task: "late detached exit",
						status: "continued",
						usage,
						finalOutput: "late detached overwrite",
						detached: true,
					});
					const settledChild = state.foregroundRuns?.get(fixture.runId)?.children[0];
					assert.equal(settledChild?.status, "completed");
					assert.equal(settledChild?.result?.finalOutput, `fresh output for ${fixture.runId}`);
				}
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
