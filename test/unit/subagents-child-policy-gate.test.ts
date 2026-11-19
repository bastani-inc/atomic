/**
 * Regression coverage for the #2205 child-policy gate.
 *
 * The fanout gate used to run before the management branch, so a child with
 * `fanoutAuthorized: false` was refused every `subagent` action — `list`
 * included — with a message about fanout.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry, SubagentChildPolicy } from "@bastani/atomic";
import { beforeEach, describe, test, vi } from "vitest";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import { SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE } from "../../packages/subagents/src/shared/types.js";

const FANOUT_MESSAGE = "Subagent fanout is not authorized for this child.";

interface MinimalAgentConfig {
	name: string;
	description: string;
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
	filePath: string;
}

type ExecutorForTest = ReturnType<typeof createSubagentExecutor>;
type ExecutorDepsForTest = Parameters<typeof createSubagentExecutor>[0];
type ExecutorContextForTest = Parameters<ExecutorForTest["execute"]>[4];
type ExecutorResultForTest = Awaited<ReturnType<ExecutorForTest["execute"]>>;

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const runSyncCalls: string[] = [];
const runSyncParentDepths: (number | undefined)[] = [];
const executorPolicies = new WeakMap<ExecutorForTest, SubagentChildPolicy>();

const runSyncMock = vi.fn(
	async (
		_cwd: string,
		_agents: MinimalAgentConfig[],
		agentName: string,
		task: string,
		options: { parentDepth?: number },
	) => {
		runSyncCalls.push(agentName);
		runSyncParentDepths.push(options.parentDepth);
		return {
			agent: agentName,
			task,
			status: "ok" as const,
			messages: [],
			usage: emptyUsage,
			finalOutput: `${agentName} output`,
		};
	},
);

function makeAgent(name: string): MinimalAgentConfig {
	return {
		name,
		description: `${name} test agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "You are a test agent.",
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

function makeState() {
	return {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function makeContext(cwd: string, subagentPolicy?: SubagentChildPolicy): ExecutorContextForTest {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		hasHumanInput: false,
		ui: { custom: async <T>() => undefined as T } as unknown as ExecutorContextForTest["ui"],
		model: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] } as unknown as ExecutorContextForTest["modelRegistry"],
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "parent-session",
			getLeafId: () => null,
			getLastSeq: () => 0,
			hasFullHistory: () => true,
			getEntries: (): SessionEntry[] => [],
		} as ExecutorContextForTest["sessionManager"],
		orchestrationContext: undefined,
		...(subagentPolicy === undefined ? {} : { subagentPolicy }),
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		sessionSignal: new AbortController().signal,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getDecisionModel: () => "",
	} satisfies ExecutorContextForTest;
}

function makeExecutor(policy: SubagentChildPolicy): ExecutorForTest {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-child-policy-"));
	const deps = {
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent-session-name",
		} as unknown as ExecutorDepsForTest["pi"],
		state: makeState(),
		config: { parallel: { concurrency: 4, maxTasks: 50 } },
		tempArtifactsDir: path.join(tempRoot, "artifacts"),
		getSubagentSessionRoot: () => path.join(tempRoot, "sessions"),
		expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents: [makeAgent("alpha")] }),
		childPolicy: policy,
		allowMutatingManagementActions: policy.managementActions === "full",
		runtime: {
			runSync: runSyncMock,
		},
	} satisfies ExecutorDepsForTest;
	const executor = createSubagentExecutor(deps);
	executorPolicies.set(executor, policy);
	return executor;
}

function policyFor(overrides: Partial<SubagentChildPolicy>): SubagentChildPolicy {
	return {
		managementActions: "restricted",
		fanoutAuthorized: false,
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

function resultText(result: ExecutorResultForTest): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function runAction(
	executor: ExecutorForTest,
	params: Parameters<ExecutorForTest["execute"]>[1],
): Promise<ExecutorResultForTest> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-child-policy-cwd-"));
	return executor.execute(
		"subagent",
		params,
		new AbortController().signal,
		undefined,
		makeContext(cwd, executorPolicies.get(executor)),
	);
}

beforeEach(() => {
	runSyncCalls.length = 0;
	runSyncParentDepths.length = 0;
	runSyncMock.mockClear();
});

describe("subagent child policy gates fanout, not management", () => {
	test("a child without fanout authorization can still run the observing management actions", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: false, managementActions: "full" }));

		for (const action of ["list", "get", "status"] as const) {
			const result = await runAction(executor, { action });
			assert.notEqual(
				resultText(result),
				FANOUT_MESSAGE,
				`observing management action '${action}' must not be refused as fanout`,
			);
			assert.equal(result.details.mode, "management");
		}
	});

	test("a child without fanout authorization is refused run control", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: false, managementActions: "full" }));

		// Run control is privileged control over a child, not observation.
		for (const action of ["pause", "resume", "quit"] as const) {
			const result = await runAction(executor, {
				action,
				id: "victim-run/victim_1",
			});
			assert.equal(result.isError, true, `'${action}' must be refused for a fanout-denied child`);
			assert.equal(resultText(result), FANOUT_MESSAGE);
			assert.equal(result.details.mode, "management");
		}

		assert.deepEqual(runSyncCalls, []);
	});

	test("a fanout-authorized child still reaches run control", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: true, managementActions: "full" }));

		for (const action of ["pause", "resume", "quit"] as const) {
			const result = await runAction(executor, {
				action,
				id: "missing-run/missing_1",
			});
			// No such child exists, so the handler's own "not found" answer proves the
			// request passed the gate rather than being refused as fanout.
			assert.notEqual(resultText(result), FANOUT_MESSAGE);
			assert.match(resultText(result), /Unknown subagent 'missing-run\/missing_1'/);
		}
	});

	test("'list' succeeds for a child without fanout authorization", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: false, managementActions: "full" }));

		const result = await runAction(executor, { action: "list" });

		assert.notEqual(result.isError, true);
		assert.ok(!resultText(result).includes(FANOUT_MESSAGE));
	});

	test("a management-restricted child is still refused create/update/delete", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: false, managementActions: "restricted" }));

		for (const action of ["create", "update", "delete"] as const) {
			const result = await runAction(executor, { action, agent: "alpha" });
			assert.equal(result.isError, true);
			assert.equal(resultText(result), `Action '${action}' is not available from child-safe subagent fanout mode.`);
			assert.equal(result.details.mode, "management");
		}
	});

	test("a child without fanout authorization is still refused actual delegation", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: false, managementActions: "full" }));

		const single = await runAction(executor, { agent: "alpha", task: "do work" });
		assert.equal(single.isError, true);
		assert.equal(resultText(single), FANOUT_MESSAGE);
		assert.equal(single.details.mode, "single");

		const parallel = await runAction(executor, { tasks: [{ agent: "alpha", task: "do work" }] });
		assert.equal(parallel.isError, true);
		assert.equal(resultText(parallel), FANOUT_MESSAGE);
		assert.equal(parallel.details.mode, "parallel");

		assert.deepEqual(runSyncCalls, []);
	});

	test("a fanout-authorized child reaches the delegation path", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: true, managementActions: "full" }));

		const result = await runAction(executor, { agent: "alpha", task: "do work" });

		assert.equal(result.isError, undefined);
		assert.deepEqual(runSyncCalls, ["alpha"]);
	});

	test("an admitted child is refused every subagent execution action", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: true, managementActions: "full", depth: 1 }));

		const executionActions: Parameters<ExecutorForTest["execute"]>[1][] = [
			{ agent: "alpha", task: "do work" },
			{ tasks: [{ agent: "alpha", task: "do work" }] },
			{ action: "pause", id: "run-1" },
			{ action: "resume", id: "run-1" },
			{ action: "quit", id: "run-1" },
		];

		for (const params of executionActions) {
			const result = await runAction(executor, params);
			assert.equal(result.isError, true, `expected refusal for ${JSON.stringify(params)}`);
			assert.equal(resultText(result), SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE);
		}
		assert.deepEqual(runSyncCalls, []);
	});

	test("an admitted child keeps the observing management actions", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: true, managementActions: "full", depth: 1 }));

		for (const action of ["list", "get", "status"] as const) {
			const result = await runAction(executor, { action });
			assert.notEqual(resultText(result), SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE);
			assert.equal(result.details.mode, "management");
		}
		assert.deepEqual(runSyncCalls, []);
	});

	test("a child admitted deeper than the single permitted level is refused too", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: true, managementActions: "full", depth: 3 }));

		const result = await runAction(executor, { agent: "alpha", task: "do work" });

		assert.equal(result.isError, true);
		assert.equal(resultText(result), SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE);
		assert.deepEqual(runSyncCalls, []);
	});

	test("a top-level session delegates from depth zero", async () => {
		const executor = makeExecutor(policyFor({ fanoutAuthorized: true, managementActions: "full" }));

		const result = await runAction(executor, { agent: "alpha", task: "do work" });

		assert.equal(result.isError, undefined);
		assert.deepEqual(runSyncParentDepths, [0]);
	});
});
