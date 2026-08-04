import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createStructuredOutputRuntime } from "../../packages/subagents/src/runs/shared/structured-output.js";

function agentConfig(): AgentConfig {
	return {
		name: "fake-reviewer",
		description: "Fake reviewer",
		source: "project",
		filePath: "fake-reviewer.md",
		systemPrompt: "Return structured output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-retry-"));
	return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const schema = {
	type: "object",
	required: ["answer"],
	properties: {
		answer: { type: "string" },
	},
	additionalProperties: false,
};

function promptCount(promptLogPath: string): number {
	if (!existsSync(promptLogPath)) return 0;
	return readFileSync(promptLogPath, "utf8")
		.split("---PROMPT---")
		.filter((entry) => entry.trim()).length;
}

describe("foreground subagent structured_output retry", () => {
	test("re-runs with a corrective prompt after missing structured_output and can succeed", async () => {
		await withTempDir(async (dir) => {
			const runtime = createStructuredOutputRuntime(schema, dir);
			const promptLogPath = join(dir, "prompts.log");
			const updateStatuses: string[] = [];
			const updateErrors: string[] = [];
			const result = await runSync(dir, [agentConfig()], "fake-reviewer", "Return the answer", {
				cwd: dir,
				runId: "structured-retry-success",
				structuredOutput: runtime,
				// The stub session withholds structured output on the first prompt, so the
				// runner must issue exactly one corrective prompt before succeeding.
				testSession: { structuredOutputAfterPrompt: 2, promptLogPath },
				onUpdate(update) {
					const progress = update.details?.progress?.[0];
					if (progress?.status) updateStatuses.push(progress.status);
					if (progress?.error) updateErrors.push(progress.error);
				},
			});

			assert.equal(result.status, "ok");
			assert.equal(result.error, undefined);
			assert.deepEqual(result.structuredOutput, { answer: "ok" });
			assert.equal(promptCount(promptLogPath), 2);
			const prompts = readFileSync(promptLogPath, "utf8");
			assert.match(prompts, /Return the answer/);
			assert.match(prompts, /Corrective attempt 1\/3/);
			assert.match(prompts, /Missing structured_output call/);
			assert.equal(updateStatuses.includes("failed"), false);
			assert.deepEqual(updateErrors, []);
		});
	});

	test("fails after three corrective prompts when structured_output remains missing", async () => {
		await withTempDir(async (dir) => {
			const runtime = createStructuredOutputRuntime(schema, dir);
			const promptLogPath = join(dir, "prompts.log");
			const failedUpdates: string[] = [];
			const result = await runSync(dir, [agentConfig()], "fake-reviewer", "Return the answer", {
				cwd: dir,
				runId: "structured-retry-failure",
				structuredOutput: runtime,
				// The stub session never writes structured output, so the runner exhausts
				// its three corrective prompts and reports a typed error.
				testSession: { promptLogPath },
				onUpdate(update) {
					const progress = update.details?.progress?.[0];
					if (progress?.status === "failed" && progress.error) failedUpdates.push(progress.error);
				},
			});

			assert.equal(result.status, "error");
			assert.match(result.error ?? "", /Missing structured_output call/);
			assert.equal(promptCount(promptLogPath), 4);
			assert.equal(result.structuredOutput, undefined);
			assert.equal(failedUpdates.length, 1);
			assert.match(failedUpdates[0] ?? "", /Missing structured_output call/);
		});
	});
});
