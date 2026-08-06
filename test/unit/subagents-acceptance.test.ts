import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { serializeAgent } from "../../packages/subagents/src/agents/agent-serializer.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";

function agentConfig(): AgentConfig {
	return {
		name: "fake-worker",
		description: "Fake worker",
		source: "project",
		filePath: "fake-worker.md",
		systemPrompt: "Return the requested output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

async function withTempRoot<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-acceptance-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("subagent acceptance removal", () => {
	test("foreground runs do not inject, evaluate, or strip acceptance reports", async () => {
		const reportOutput = ["done", "```acceptance-report", "{not-valid-json}", "```"].join("\n");
		await withTempRoot(async (dir) => {
			const promptLogPath = join(dir, "prompt.log");
			const result = await runSync(dir, [agentConfig()], "fake-worker", "Preserve reports", {
				cwd: dir,
				runId: "no-acceptance-gates",
				artifactsDir: dir,
				testSession: { output: reportOutput, promptLogPath },
			});

			assert.equal(result.status, "ok");
			assert.equal(result.error, undefined);
			assert.equal("acceptance" in result, false);
			assert.match(result.finalOutput ?? "", /```acceptance-report/);
			assert.match(result.finalOutput ?? "", /\{not-valid-json\}/);

			const prompt = readFileSync(promptLogPath, "utf8");
			assert.match(prompt, /Preserve reports/);
			assert.doesNotMatch(prompt, /Acceptance Contract|Acceptance level|acceptance-report/);

			const artifactInput = result.artifactPaths?.inputPath
				? readFileSync(result.artifactPaths.inputPath, "utf8")
				: "";
			assert.match(artifactInput, /Preserve reports/);
			assert.doesNotMatch(artifactInput, /Acceptance Contract|Acceptance level|acceptance-report/);
		});
	});

	test("foreground reports missing cwd as a cwd problem before admission", async () => {
		await withTempRoot(async (dir) => {
			const missing = join(dir, "missing-cwd");
			const result = await runSync(dir, [agentConfig()], "fake-worker", "Do not spawn", {
				cwd: missing,
				runId: "missing-cwd-foreground",
				artifactsDir: dir,
			});

			assert.equal(result.status, "error");
			assert.equal(result.error, `cwd does not exist: ${missing}`);
			assert.doesNotMatch(result.error ?? "", /spawn .*ENOENT/i);
		});
	});

	test("foreground investigation/debugger runs can complete successfully without edits", async () => {
		await withTempRoot(async (dir) => {
			const debuggerAgent: AgentConfig = {
				...agentConfig(),
				name: "debugger",
				description: "Investigates issues",
				filePath: "debugger.md",
				systemPrompt: "Investigate and report findings.",
				tools: ["bash"],
			};
			const result = await runSync(
				dir,
				[debuggerAgent],
				"debugger",
				"Investigate the likely fix for the cache race",
				{
					cwd: dir,
					runId: "no-edit-investigation",
					artifactsDir: dir,
					testSession: { output: "Likely fix: make cache writes atomic." },
				},
			);

			assert.equal(result.status, "ok");
			assert.equal(result.error, undefined);
			assert.match(result.finalOutput ?? "", /Likely fix/);
			assert.equal(result.progress?.status, "completed");
			assert.doesNotMatch(JSON.stringify(result.controlEvents ?? []), /completion_guard/);
		});
	});

	test("subagent tool schema no longer exposes acceptance fields", () => {
		const serialized = JSON.stringify(SubagentParams);
		const removedNoMutationField = `completion${"Guard"}`;
		const removedNoMutationPattern = new RegExp(`${removedNoMutationField}|completion_guard|completion guard`, "i");

		assert.doesNotMatch(serialized, /"acceptance"/);
		assert.doesNotMatch(serialized, /AcceptanceOverride|Acceptance level|acceptance policy/);
		assert.doesNotMatch(serialized, removedNoMutationPattern);

		const serializedLegacyAgent = serializeAgent({
			...agentConfig(),
			extraFields: { [removedNoMutationField]: "false" },
		});
		assert.doesNotMatch(serializedLegacyAgent, removedNoMutationPattern);
	});
});
