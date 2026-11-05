import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { SessionStartConfigError } from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { loadConfig } from "../../packages/subagents/src/extension/config.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { ExtensionConfig, RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { decisionChatModel, registeredDecisionRuntime } from "../helpers/structured-output.js";

const AGENT_DIR_ENV = "ATOMIC_CODING_AGENT_DIR";
const savedAgentDir = process.env[AGENT_DIR_ENV];
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	if (savedAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = savedAgentDir;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function useSubagentConfig(config: object): string {
	const agentDir = tempRoot("subagent-start-config-agent-");
	process.env[AGENT_DIR_ENV] = agentDir;
	const path = join(agentDir, "extensions", "subagent", "config.json");
	mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
	return path;
}

test("loadConfig keeps a valid sessionStartTimeoutMs without reporting (#4319)", () => {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	useSubagentConfig({ sessionStartTimeoutMs: 600_000, parallel: { maxTasks: 7 } });
	assert.deepEqual(loadConfig(), { sessionStartTimeoutMs: 600_000, parallel: { maxTasks: 7 } });
	assert.deepEqual(errors.mock.calls, []);
});

test("loadConfig reports an invalid sessionStartTimeoutMs once, by its typed error, and ignores only that setting (#4319)", () => {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const cases: readonly [unknown, SessionStartConfigError][] = [
		["5m", new SessionStartConfigError("settings", "sessionStartTimeoutMs", "not-a-positive-integer", '"5m"')],
		[0, new SessionStartConfigError("settings", "sessionStartTimeoutMs", "not-a-positive-integer", "0")],
		[
			3_000_000_000,
			new SessionStartConfigError("settings", "sessionStartTimeoutMs", "exceeds-maximum", "3000000000"),
		],
	];
	for (const [value, expected] of cases) {
		errors.mockClear();
		const path = useSubagentConfig({ sessionStartTimeoutMs: value, resumeInFlight: "ask" });
		assert.deepEqual(loadConfig(), { resumeInFlight: "ask" });
		assert.deepEqual(errors.mock.calls, [[`Invalid subagent config '${path}': ${expected.message}`]]);
	}
});

async function executorFixture(config: ExtensionConfig) {
	const cwd = tempRoot("subagent-start-config-cwd-");
	const agent: AgentConfig = {
		name: "worker",
		description: "start budget fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: join(cwd, "worker.md"),
	};
	const runSync = vi.fn(
		async (
			_cwd: string,
			_agents: AgentConfig[],
			_name: string,
			task: string,
			_options: RunSyncOptions,
		): Promise<SingleResult> => ({
			agent: "worker",
			task,
			status: "ok",
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			finalOutput: "done",
		}),
	);
	const { registry } = await registeredDecisionRuntime(() => assert.fail("no model is asked"));
	const ctx = {
		cwd,
		model: decisionChatModel,
		thinkingLevel: "low",
		modelRegistry: registry,
		sessionManager: {
			getSessionFile: () => join(cwd, "session.jsonl"),
			getSessionId: () => "parent",
			getLeafId: () => null,
		},
		isProjectTrusted: () => true,
		hasUI: false,
	} as unknown as ExtensionContext;
	const executor = createSubagentExecutor({
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: "",
			currentSessionId: null,
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: { intercomBridge: { mode: "off" }, ...config },
		tempArtifactsDir: join(cwd, "artifacts"),
		getSubagentSessionRoot: () => join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent] }),
		runtime: { runSync },
	});
	return {
		runSync,
		call: (params: Parameters<typeof executor.execute>[1]) =>
			executor.execute("start-config", params, new AbortController().signal, undefined, ctx),
	};
}

test("the configured sessionStartTimeoutMs reaches every child a single or parallel launch starts (#4319)", async () => {
	for (const config of [{ sessionStartTimeoutMs: 45_000 }, {}] as const) {
		const fixture = await executorFixture(config);
		for (const params of [
			{ agent: "worker", task: "one" },
			{
				tasks: [
					{ agent: "worker", task: "two" },
					{ agent: "worker", task: "three" },
				],
			},
		]) {
			const result = await fixture.call(params);
			assert.notEqual(result.isError, true, JSON.stringify(result.content));
		}
		const budgets = fixture.runSync.mock.calls.map((call) => call[4].sessionStartTimeoutMs);
		const expected = "sessionStartTimeoutMs" in config ? config.sessionStartTimeoutMs : undefined;
		assert.deepEqual(budgets, [expected, expected, expected]);
	}
});
