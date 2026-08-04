import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import type {
	AttemptOutcome,
	ChildSpec,
	RunningAttempt,
	TerminationCauseName,
} from "../../packages/subagents/src/runs/inprocess/runner.ts";
import { SubagentControlRuntime, terminate_child_attempt } from "../../packages/subagents/src/runs/inprocess/runner.ts";

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					onTimeout();
					reject(new Error(`timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

test("terminate_child_attempt prefers the live terminator over the raw token path", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-terminate-"));
	try {
		const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
		control.registerAgents([sampleAgent()]);
		const admitted = control.admitChildSession(sampleSpec(root), { path: "parent", depth: 0 }).admitted;
		assert.ok(admitted);

		let release!: () => void;
		const pending = new Promise<AttemptOutcome>((resolve) => {
			release = () => resolve(emptyOutcome());
		});
		let causeSeen: string | undefined;
		const privateControl = control as unknown as {
			attemptTokens: Map<string, number>;
			attemptTerminators: Map<string, (cause: TerminationCauseName) => Promise<void>>;
			terminateRunningAttempt: (running: RunningAttempt, cause: TerminationCauseName) => Promise<void>;
		};
		privateControl.attemptTokens.set(admitted.identity.path, 999_999);
		privateControl.attemptTerminators.set(admitted.identity.path, async (cause) => {
			causeSeen = cause;
			release();
		});
		const running: RunningAttempt = {
			id: 1,
			child: admitted,
			candidate: {},
			startedAt: Date.now(),
			status: "running",
			promise: pending,
			terminate: (cause) => privateControl.terminateRunningAttempt(running, cause),
		};

		await withTimeout(terminate_child_attempt(control, running, "abort"), 100, release);
		assert.equal(causeSeen, "abort");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
