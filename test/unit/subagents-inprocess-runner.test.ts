import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import {
	clearSubagentControls,
	findSubagentControl,
} from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import {
	interruptInProcessNestedAttempt,
	resumeInProcessNestedAttempt,
} from "../../packages/subagents/src/runs/inprocess/nested-routing.ts";
import {
	type ChildSpec,
	inProcessChildBuiltinPackagePaths,
	SubagentControlRuntime,
} from "../../packages/subagents/src/runs/inprocess/runner.ts";
import { MAX_SUBAGENT_NESTING_DEPTH } from "../../packages/subagents/src/shared/types.ts";
import { resultStatusLine } from "../../packages/subagents/src/tui/render-status-progress.js";
import { sleep } from "../helpers/runtime.ts";

const LIVE_CHILD_RESOURCE_RELOAD_TIMEOUT_MS = 120_000;

function sampleAgent(): AgentConfig {
	return {
		name: "analysis",
		description: "analysis agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/analysis.md",
	};
}

function sampleSpec(cwd: string): ChildSpec {
	return { taskName: "analysis", task: "inspect the fixture", agent: sampleAgent(), cwd };
}

test("a run's parent depth reaches admission and the door refuses the level past the maximum", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-depth-"));
	clearSubagentControls();
	try {
		const deepestAllowed = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "depth-parent-below-limit",
			sessionDir: join(root, "sessions", "below-limit"),
			parentDepth: MAX_SUBAGENT_NESTING_DEPTH - 1,
			testSession: { output: "deep result" },
		});

		assert.equal(deepestAllowed.status, "ok");
		const deepestControl = findSubagentControl("depth-parent-below-limit");
		assert.equal(
			deepestControl?.native.listChildren()[0]?.depth,
			MAX_SUBAGENT_NESTING_DEPTH,
			"a child of the deepest allowed parent is admitted at the maximum depth",
		);

		const beyondLimit = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "depth-parent-at-limit",
			sessionDir: join(root, "sessions", "at-limit"),
			parentDepth: MAX_SUBAGENT_NESTING_DEPTH,
			testSession: { output: "deep result" },
		});

		assert.equal(beyondLimit.status, "error");
		assert.equal(beyondLimit.error, `child depth exceeds maximum ${MAX_SUBAGENT_NESTING_DEPTH}`);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("in-process child loading includes bundled subagent resources", () => {
	const packagePath = (source: string | { source: string }): string =>
		typeof source === "string" ? source : source.source;
	const builtinPaths = inProcessChildBuiltinPackagePaths(undefined);
	const subagentsPath = builtinPaths.find((source) => basename(packagePath(source)) === "subagents");
	const workflowsPath = builtinPaths.find((source) => basename(packagePath(source)) === "workflows");

	assert.ok(subagentsPath, "in-process children must load the bundled subagents package");
	assert.ok(workflowsPath, "source checkout must expose the bundled workflows package");

	const stagePaths = inProcessChildBuiltinPackagePaths({
		kind: "workflow-stage",
		workflowRunId: "run",
		workflowStageId: "stage",
		workflowStageName: "Stage",
		constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
	});
	const stageWorkflowsPath = stagePaths.find((source) => basename(packagePath(source)) === "workflows");
	assert.deepEqual(stageWorkflowsPath, { source: packagePath(workflowsPath), extensions: [] });
});

test(
	"a live in-process child resolves qualified skills and reports missing selectors",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-skill-catalog-"));
		const agentDir = join(root, "agent");
		const userSkillDir = join(agentDir, "skills", "tdd");
		const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		mkdirSync(userSkillDir, { recursive: true });
		writeFileSync(
			join(userSkillDir, "SKILL.md"),
			"---\nname: tdd\ndescription: User TDD\n---\n\nUser-only TDD body\n",
			"utf-8",
		);
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		clearSubagentControls();
		try {
			const result = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
				cwd: root,
				runId: "live-qualified-skill",
				sessionDir: join(root, "sessions"),
				testSession: false,
				skills: ["tdd@builtin", "missing-skill"],
			});

			assert.deepEqual(result.skills, ["tdd@builtin"]);
			assert.equal(result.skillsWarning, "Skills not found: missing-skill");
		} finally {
			if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
			clearSubagentControls();
			rmSync(root, { recursive: true, force: true });
		}
	},
	LIVE_CHILD_RESOURCE_RELOAD_TIMEOUT_MS,
);

test("admission resolves restricted child management and explicit fanout policy", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-policy-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const result = control.admitChildSession(
			{ ...sampleSpec(root), tools: ["subagent"] },
			{ path: "parent", depth: 0 },
		);
		assert.ok(result.admitted);
		assert.equal(result.admitted.policy.managementActions, "restricted");
		assert.equal(result.admitted.policy.depth, 1);
		assert.equal(result.admitted.policy.fanoutAuthorized, true);
		const noFanout = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 0 });
		assert.ok(noFanout.admitted);
		assert.equal(noFanout.admitted.policy.managementActions, "restricted");
		assert.equal(noFanout.admitted.policy.fanoutAuthorized, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("admission carries the effective per-agent maximum into the child policy", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-max-depth-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);

		const capped = control.admitChildSession(
			{ ...sampleSpec(root), maxSubagentDepth: 1 },
			{ path: "parent", depth: 0 },
		);
		assert.ok(capped.admitted);
		assert.equal(capped.admitted.policy.depth, 1);
		assert.equal(capped.admitted.policy.maxSubagentDepth, 1);

		const uncapped = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 0 });
		assert.ok(uncapped.admitted);
		assert.equal(uncapped.admitted.policy.maxSubagentDepth, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("direct admission falls back to the agent's own declared maximum", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-agent-max-depth-"));
	try {
		const cappedAgent: AgentConfig = { ...sampleAgent(), maxSubagentDepth: 1 };
		const control = new SubagentControlRuntime({ path: "agent-max-parent", depth: 0 }, root);
		control.registerAgents([cappedAgent]);

		// The spec omits maxSubagentDepth, as a caller admitting a child directly does.
		const admitted = control.admitChildSession(
			{ taskName: cappedAgent.name, task: "inspect the fixture", agent: cappedAgent, cwd: root },
			{ path: "agent-max-parent", depth: 0 },
		);

		assert.ok(admitted.admitted);
		assert.equal(admitted.admitted.policy.depth, 1);
		assert.equal(admitted.admitted.policy.maxSubagentDepth, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an explicitly narrowed spec maximum wins over the agent's declared one", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-narrowed-max-depth-"));
	try {
		const cappedAgent: AgentConfig = { ...sampleAgent(), maxSubagentDepth: 3 };
		const control = new SubagentControlRuntime({ path: "narrowed-parent", depth: 0 }, root);
		control.registerAgents([cappedAgent]);

		const admitted = control.admitChildSession(
			{
				taskName: cappedAgent.name,
				task: "inspect the fixture",
				agent: cappedAgent,
				cwd: root,
				maxSubagentDepth: 1,
			},
			{ path: "narrowed-parent", depth: 0 },
		);

		assert.ok(admitted.admitted);
		assert.equal(admitted.admitted.policy.maxSubagentDepth, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a retained spec keeps the effective maximum across a cold reload", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-max-depth-reload-"));
	try {
		const control = new SubagentControlRuntime({ path: "reload-parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(
			{ ...sampleSpec(root), maxSubagentDepth: 1 },
			{ path: "reload-parent", depth: 0 },
		);
		assert.ok(admitted.admitted);
		mkdirSync(admitted.admitted.sessionDir, { recursive: true });
		writeFileSync(join(admitted.admitted.sessionDir, "session.jsonl"), "", "utf8");

		const reloaded = control.reloadColdChild(admitted.admitted.identity.path, "follow up");

		assert.ok(reloaded.admitted, reloaded.refusal?.reason);
		assert.equal(reloaded.admitted.policy.maxSubagentDepth, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a run's effective maximum reaches the admitted child policy", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-max-depth-run-"));
	clearSubagentControls();
	try {
		const result = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "max-depth-parent",
			sessionDir: join(root, "sessions"),
			maxSubagentDepth: 1,
			testSession: { output: "capped result" },
		});
		assert.equal(result.status, "ok");

		const control = findSubagentControl("max-depth-parent");
		assert.ok(control);
		const childPath = result.path ?? "";
		const reloaded = control.reloadColdChild(childPath, "follow up");

		assert.ok(reloaded.admitted, reloaded.refusal?.reason);
		assert.equal(reloaded.admitted.policy.maxSubagentDepth, 1);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("admission refuses a child whose parent is already at depth five", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-depth-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const result = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 5 });
		assert.equal(result.admitted, undefined);
		assert.equal(result.refusal?.kind, "depthExceeded");
		assert.equal(result.refusal?.maxDepth, 5);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cold reload refuses a path outside the trusted session root", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-cold-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		const result = control.reloadColdChild("../escape", "resume");
		assert.equal(result.admitted, undefined);
		assert.equal(result.refusal?.kind, "invalidCwd");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("launch metadata uses the session's effective thinking level", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-thinking-metadata-"));
	const gate = Promise.withResolvers<void>();
	try {
		const control = new SubagentControlRuntime({ path: "thinking-parent", depth: 0 }, join(root, "sessions"));
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(
			{
				...sampleSpec(root),
				testSession: {
					promptGate: gate.promise,
					sessionModel: "anthropic/non-reasoning-fixture",
					sessionThinkingLevel: "off",
				},
			},
			{ path: "thinking-parent", depth: 0 },
		).admitted;
		assert.ok(admitted);
		const neverAbort = new AbortController().signal;
		const running = control.startAttempt(
			admitted,
			{ modelId: "anthropic/non-reasoning-fixture", thinkingLevel: "xhigh" },
			{ abort: neverAbort, interrupt: neverAbort },
			{ fastModeForModel: () => false },
		);

		assert.equal(running.currentModel, "anthropic/non-reasoning-fixture");
		assert.equal(running.currentThinking, "off");
		assert.equal(running.currentFastMode, false);
		assert.deepEqual(control.getChildMetadata(admitted.identity.path), {
			model: "anthropic/non-reasoning-fixture",
			thinking: "off",
			fastMode: false,
		});

		gate.resolve();
		assert.equal((await running.promise).status, "ok");
	} finally {
		gate.resolve();
		rmSync(root, { recursive: true, force: true });
	}
});

test("launch metadata does not invent a default thinking level", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-thinking-default-"));
	const gate = Promise.withResolvers<void>();
	try {
		const control = new SubagentControlRuntime({ path: "thinking-default-parent", depth: 0 }, join(root, "sessions"));
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(
			{ ...sampleSpec(root), testSession: { promptGate: gate.promise } },
			{ path: "thinking-default-parent", depth: 0 },
		).admitted;
		assert.ok(admitted);
		const neverAbort = new AbortController().signal;
		const running = control.startAttempt(
			admitted,
			{ modelId: "anthropic/non-reasoning-fixture" },
			{ abort: neverAbort, interrupt: neverAbort },
			{ fastModeForModel: () => false },
		);

		assert.equal(running.currentThinking, undefined);
		assert.equal(control.getChildMetadata(admitted.identity.path)?.thinking, undefined);
		gate.resolve();
		assert.equal((await running.promise).status, "ok");
	} finally {
		gate.resolve();
		rmSync(root, { recursive: true, force: true });
	}
});

test("launch metadata preserves configured thinking without a model", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-thinking-config-"));
	const gate = Promise.withResolvers<void>();
	try {
		const control = new SubagentControlRuntime({ path: "thinking-config-parent", depth: 0 }, join(root, "sessions"));
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(
			{
				...sampleSpec(root),
				agent: { ...sampleAgent(), thinking: "high" },
				testSession: { promptGate: gate.promise },
			},
			{ path: "thinking-config-parent", depth: 0 },
		).admitted;
		assert.ok(admitted);
		const neverAbort = new AbortController().signal;
		const running = control.startAttempt(
			admitted,
			{},
			{ abort: neverAbort, interrupt: neverAbort },
			{ fastModeForModel: () => false },
		);

		assert.equal(running.currentModel, undefined);
		assert.equal(running.currentThinking, "high");
		assert.equal(control.getChildMetadata(admitted.identity.path)?.thinking, "high");
		gate.resolve();
		assert.equal((await running.promise).status, "ok");
	} finally {
		gate.resolve();
		rmSync(root, { recursive: true, force: true });
	}
});

test("parallel siblings share one control plane and persist distinct terminal artifacts", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-parallel-"));
	const artifactsDir = join(root, "artifacts");
	const sessionRoot = join(root, "sessions");
	clearSubagentControls();
	try {
		const results = await Promise.all(
			[0, 1, 2].map((index) =>
				runSingleInProcess(root, sampleAgent(), `inspect fixture ${index}`, {
					cwd: root,
					runId: "parallel-parent",
					index,
					sessionDir: join(sessionRoot, `run-${index}`),
					sessionFile: join(sessionRoot, `run-${index}`, "session.jsonl"),
					artifactsDir,
					artifactConfig: {
						enabled: true,
						includeInput: true,
						includeOutput: true,
						includeJsonl: true,
						includeMetadata: true,
						cleanupDays: 7,
					},
					testSession: { output: `result ${index}` },
				}),
			),
		);

		assert.deepEqual(
			results.map((result) => result.path),
			["parallel-parent/analysis_1", "parallel-parent/analysis_2", "parallel-parent/analysis_3"],
		);
		assert.deepEqual(
			results.map((result) => result.status),
			["ok", "ok", "ok"],
		);
		for (const [index, result] of results.entries()) {
			assert.ok(result.artifactPaths);
			assert.equal(readFileSync(result.artifactPaths.outputPath, "utf8"), `result ${index}`);
			assert.equal(existsSync(result.artifactPaths.metadataPath), true);
		}
		const history = readFileSync(join(artifactsDir, "run-history.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { path: string });
		assert.deepEqual(history.map((entry) => entry.path).sort(), [
			"parallel-parent/analysis_1",
			"parallel-parent/analysis_2",
			"parallel-parent/analysis_3",
		]);
		const thirdPath = results[2]?.path;
		assert.ok(thirdPath);
		const control = findSubagentControl(thirdPath);
		assert.ok(control);
		const resumed = await control.resumeChild(thirdPath, "inspect one more fixture", {});
		assert.equal(resumed.status, "ok", resumed.status === "error" ? resumed.cause : undefined);
		assert.equal(resumed.path, thirdPath);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("terminal artifacts use the configured prefix exactly once", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-artifact-prefix-"));
	const artifactsDir = join(root, "artifacts");
	clearSubagentControls();
	try {
		const result = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "prefix-parent",
			index: 1,
			sessionDir: join(root, "sessions", "run-1"),
			sessionFile: join(root, "sessions", "run-1", "session.jsonl"),
			artifactsDir,
			artifactConfig: {
				enabled: true,
				includeInput: true,
				includeOutput: true,
				includeJsonl: true,
				includeMetadata: true,
				cleanupDays: 7,
			},
			testSession: { output: "terminal result" },
		});

		assert.equal(result.status, "ok");
		assert.deepEqual(
			readdirSync(artifactsDir)
				.filter((name) => name.endsWith("_output.md") || name.endsWith("_meta.json"))
				.sort(),
			["prefix-parent_analysis_1_meta.json", "prefix-parent_analysis_1_output.md"],
		);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});
test("typed status is the sole result outcome discriminator", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-status-"));
	try {
		const result = await runSingleInProcess(root, sampleAgent(), "return a typed result", {
			cwd: root,
			runId: "typed-status-parent",
			testSession: { output: "typed result" },
		});
		assert.equal(result.status, "ok");
		assert.equal("exitCode" in result, false);
		assert.equal(resultStatusLine({ ...result, status: "skipped" }, ""), "Skipped");
		assert.equal(resultStatusLine({ ...result, status: "continued" }, ""), "Continued");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nested interrupt flushes JSONL and resume reloads the same in-process child", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-nested-control-"));
	const gate = Promise.withResolvers<void>();
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, join(root, "sessions"));
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(
			{ ...sampleSpec(root), testSession: { output: "resumed", promptGate: gate.promise } },
			{ path: "parent", depth: 0 },
		).admitted;
		assert.ok(admitted);
		const neverAbort = new AbortController().signal;
		const running = control.startAttempt(admitted, {}, { abort: neverAbort, interrupt: neverAbort });
		control.registerNestedAttempt("nested-run", running, {});
		await sleep(50);

		const interrupt = await interruptInProcessNestedAttempt("nested-run");
		assert.equal(interrupt?.ok, true);
		const interrupted = await running.promise;
		assert.equal(interrupted.status, "interrupted");
		assert.ok(interrupted.sessionFile);
		const interruptedLines = readFileSync(interrupted.sessionFile!, "utf8").trim().split("\n");
		assert.ok(interruptedLines.length > 0);
		for (const line of interruptedLines) assert.doesNotThrow(() => JSON.parse(line));

		gate.resolve();
		const resumed = await resumeInProcessNestedAttempt("nested-run", "continue with the saved context");
		assert.equal(resumed?.ok, true);
		assert.equal(resumed?.outcome?.status, "ok");
		assert.equal(resumed?.outcome?.path, interrupted.path);
	} finally {
		gate.resolve();
		rmSync(root, { recursive: true, force: true });
	}
});
