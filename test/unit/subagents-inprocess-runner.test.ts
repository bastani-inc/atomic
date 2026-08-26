import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentSessionEvent } from "@bastani/atomic";
import { SubagentControl as NativeSubagentControl } from "@bastani/atomic-natives";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import {
	clearSubagentControls,
	findSubagentControl,
} from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import {
	type ChildSpec,
	inProcessChildBuiltinPackagePaths,
	SubagentControlRuntime,
} from "../../packages/subagents/src/runs/inprocess/runner.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../../packages/subagents/src/shared/types.ts";
import { resultStatusLine } from "../../packages/subagents/src/tui/render-status-progress.js";

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
			parentDepth: 0,
			testSession: { output: "deep result" },
		});

		assert.equal(deepestAllowed.status, "ok");
		const deepestControl = findSubagentControl("depth-parent-below-limit");
		assert.equal(
			deepestControl?.native.listChildren()[0]?.depth,
			1,
			"a top-level parent admits its child at the single permitted level",
		);

		const beyondLimit = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "depth-parent-at-limit",
			sessionDir: join(root, "sessions", "at-limit"),
			parentDepth: 1,
			testSession: { output: "deep result" },
		});

		assert.equal(beyondLimit.status, "error");
		assert.equal(beyondLimit.error, "child depth exceeds maximum 1");
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("in-process child loading keeps bundled resources but disables the workflow extension", () => {
	const packagePath = (source: string | { source: string }): string =>
		typeof source === "string" ? source : source.source;
	const builtinPaths = inProcessChildBuiltinPackagePaths(undefined);
	const subagentsPath = builtinPaths.find((source) => basename(packagePath(source)) === "subagents");
	const workflowsPath = builtinPaths.find((source) => basename(packagePath(source)) === "workflows");

	assert.ok(subagentsPath, "in-process children must load the bundled subagents package");
	assert.ok(workflowsPath, "source checkout must expose the bundled workflows package");
	assert.deepEqual(workflowsPath, { source: packagePath(workflowsPath), extensions: [] });

	const stagePaths = inProcessChildBuiltinPackagePaths({
		kind: "workflow-stage",
		workflowRunId: "run",
		workflowStageId: "stage",
		workflowStageName: "Stage",
		constraints: { disableWorkflowTool: true },
	});
	const stageWorkflowsPath = stagePaths.find((source) => basename(packagePath(source)) === "workflows");
	assert.deepEqual(stageWorkflowsPath, { source: packagePath(workflowsPath), extensions: [] });

	const otherPaths = inProcessChildBuiltinPackagePaths({ kind: "future-child-context" } as never);
	const otherWorkflowsPath = otherPaths.find((source) => basename(packagePath(source)) === "workflows");
	assert.deepEqual(otherWorkflowsPath, { source: packagePath(workflowsPath), extensions: [] });
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

test("admission refuses a child whose parent already sits at the single permitted level", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-depth-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 0 });
		assert.ok(admitted.admitted);
		assert.equal(admitted.admitted.policy.depth, 1);

		const result = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 1 });
		assert.equal(result.admitted, undefined);
		assert.equal(result.refusal?.kind, "depthExceeded");
		assert.equal(result.refusal?.maxDepth, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("native child identities stay terminal after ok, error, and interrupted attempts", async () => {
	for (const terminalStatus of ["ok", "error", "interrupted"] as const) {
		const native = new NativeSubagentControl(`parent-${terminalStatus}`);
		const admission = native.admitChildSession(
			{ taskName: "analysis", agentName: undefined, cwd: undefined },
			{ path: `parent-${terminalStatus}`, depth: 0 },
		);
		assert.ok(admission.child);
		const first = native.beginChildAttempt(admission.child.path);
		assert.ok(first.token);
		if (terminalStatus === "interrupted") {
			await native.terminateChildAttempt(first.token, "interrupt");
		} else {
			native.finishChildAttempt(first.token, terminalStatus);
		}

		const second = native.beginChildAttempt(admission.child.path);
		assert.equal(second.token, undefined);
		assert.equal(second.refusal?.kind, "terminalChild");
		native.publishChildStatus(admission.child.path, "running");
		assert.equal(native.listChildren()[0]?.status, terminalStatus);
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
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("in-process artifacts with omitted artifact config honor the default JSONL opt-out", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-jsonl-default-"));
	const artifactsDir = join(root, "artifacts");
	clearSubagentControls();
	try {
		assert.equal(DEFAULT_ARTIFACT_CONFIG.includeJsonl, false);
		const result = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "jsonl-default-parent",
			sessionDir: join(root, "sessions"),
			artifactsDir,
			testSession: { output: "jsonl default" },
		});

		assert.equal(result.status, "ok");
		assert.ok(result.artifactPaths);
		assert.equal(existsSync(result.artifactPaths.jsonlPath), false);
		assert.equal(existsSync(result.artifactPaths.outputPath), true);
		assert.equal(existsSync(result.artifactPaths.metadataPath), true);
		assert.deepEqual(
			readdirSync(artifactsDir).filter((name) => name.endsWith(".jsonl") && name !== "run-history.jsonl"),
			[],
		);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("in-process artifacts with includeJsonl false do not create a JSONL artifact", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-jsonl-disabled-"));
	const artifactsDir = join(root, "artifacts");
	clearSubagentControls();
	try {
		assert.equal(DEFAULT_ARTIFACT_CONFIG.includeJsonl, false);
		const result = await runSingleInProcess(root, sampleAgent(), "inspect fixture", {
			cwd: root,
			runId: "jsonl-disabled-parent",
			sessionDir: join(root, "sessions"),
			artifactsDir,
			artifactConfig: {
				...DEFAULT_ARTIFACT_CONFIG,
				includeJsonl: false,
			},
			testSession: { output: "jsonl disabled" },
		});

		assert.equal(result.status, "ok");
		assert.ok(result.artifactPaths);
		assert.equal(existsSync(result.artifactPaths.jsonlPath), false);
		assert.equal(existsSync(result.artifactPaths.outputPath), true);
		assert.equal(existsSync(result.artifactPaths.metadataPath), true);
		assert.deepEqual(
			readdirSync(artifactsDir).filter((name) => name.endsWith(".jsonl") && name !== "run-history.jsonl"),
			[],
		);
	} finally {
		clearSubagentControls();
		rmSync(root, { recursive: true, force: true });
	}
});

test("in-process enabled JSONL writing stays within 50 MiB while child events continue", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-jsonl-cap-"));
	const artifactsDir = join(root, "artifacts");
	const capBytes = 50 * 1024 * 1024;
	const payload = "x".repeat(1024 * 1024);
	const events: AgentSessionEvent[] = [
		...Array.from(
			{ length: 51 },
			(_, index): AgentSessionEvent => ({
				type: "bash_execution_update",
				id: `event-${index}`,
				channel: "stdout",
				delta: `event-${index}-${payload}`,
			}),
		),
		{
			type: "model_fallback_start",
			from: "provider/initial",
			to: "provider/fallback",
			reason: "post-cap event",
			attempt: 1,
		},
	];
	const serializedEvents = [{ type: "agent_start" } as AgentSessionEvent, ...events].map((event) =>
		JSON.stringify(event),
	);
	const expectedLines: string[] = [];
	let expectedBytes = 0;
	for (const line of serializedEvents) {
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
		if (expectedBytes + lineBytes <= capBytes) {
			expectedLines.push(line);
			expectedBytes += lineBytes;
		}
	}
	assert.equal(expectedLines.length, 51, "fixture should retain ordered events near the production cap");
	assert.ok(expectedBytes > capBytes - 2 * 1024 * 1024, "fixture should fill the production cap");
	assert.ok(
		serializedEvents.length > expectedLines.length,
		"the fixture must drive the writer beyond the production cap",
	);
	clearSubagentControls();
	try {
		const result = await runSingleInProcess(
			root,
			{ ...sampleAgent(), model: "provider/initial" },
			"inspect fixture",
			{
				cwd: root,
				runId: "jsonl-cap-parent",
				sessionDir: join(root, "sessions"),
				artifactsDir,
				artifactConfig: {
					...DEFAULT_ARTIFACT_CONFIG,
					includeJsonl: true,
				},
				testSession: { output: "child completed", events },
			},
		);

		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "child completed");
		assert.deepEqual(result.attemptedModels, ["provider/initial", "provider/fallback"]);
		assert.ok(result.artifactPaths);
		assert.equal(existsSync(result.artifactPaths.jsonlPath), true);
		const jsonlBytes = statSync(result.artifactPaths.jsonlPath).size;
		assert.equal(jsonlBytes, expectedBytes);
		const actualLines = readFileSync(result.artifactPaths.jsonlPath, "utf8").trimEnd().split("\n");
		assert.deepEqual(actualLines, expectedLines);
		assert.equal(
			actualLines.some((line) => line.includes('"id":"event-49"')),
			false,
		);
		assert.equal(
			actualLines.some((line) => line.includes('"id":"event-50"')),
			false,
		);
		assert.equal(actualLines.at(-1)?.includes('"type":"model_fallback_start"'), true);
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
