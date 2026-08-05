import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	type AttemptOutcome,
	type ChildSpec,
	continue_in_background,
	type RunningAttempt,
	SubagentControlRuntime,
} from "../../packages/subagents/src/runs/inprocess/runner.ts";
import { resultStatusLine } from "../../packages/subagents/src/tui/render-status-progress.js";
import { sleep } from "../helpers/runtime.ts";

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
		assert.equal(result.admitted.policy.fanoutAuthorized, true);
		const noFanout = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 0 });
		assert.ok(noFanout.admitted);
		assert.equal(noFanout.admitted.policy.managementActions, "restricted");
		assert.equal(noFanout.admitted.policy.fanoutAuthorized, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function emptyOutcome(): AttemptOutcome {
	return {
		status: "error",
		cause: "fixture",
		stats: {
			sessionFile: undefined,
			sessionId: "fixture",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
		path: "parent/analysis_1",
		envelope: "fixture",
	};
}

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

test("background continuation rejects an attempt that is no longer running", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-continue-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 0 }).admitted;
		assert.ok(admitted);
		const running: RunningAttempt = {
			id: 1,
			child: admitted,
			candidate: {},
			startedAt: Date.now(),
			status: "ok",
			promise: Promise.resolve(emptyOutcome()),
		};
		assert.throws(() => continue_in_background(control, running, "async-requested"), /requires a running attempt/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("background continuation returns the child identity before the in-process session finishes", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-background-"));
	const gate = Promise.withResolvers<void>();
	const terminal = Promise.withResolvers<Awaited<ReturnType<typeof runSingleInProcess>>>();
	try {
		const result = await runSingleInProcess(root, sampleAgent(), "continue this task", {
			cwd: root,
			runId: "background-run",
			sessionDir: join(root, "sessions"),
			backgroundContinuation: true,
			testSession: { promptGate: gate.promise },
			onDetachedExit: (completed) => terminal.resolve(completed),
		});
		assert.equal(result.status, "continued");
		assert.equal(result.detached, true);
		assert.equal(result.detachedReason, "async-requested");
		assert.match(result.path ?? "", /^background-run\//);

		gate.resolve();
		const completed = await terminal.promise;
		assert.equal(completed.status, "ok");
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
