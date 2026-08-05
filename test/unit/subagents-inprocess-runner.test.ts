import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import {
	type AttemptOutcome,
	type ChildSpec,
	continue_in_background,
	type RunningAttempt,
	SubagentControlRuntime,
} from "../../packages/subagents/src/runs/inprocess/runner.ts";

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
