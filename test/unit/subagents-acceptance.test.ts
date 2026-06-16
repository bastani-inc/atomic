import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "bun:test";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { SubagentParams } from "../../packages/subagents/src/extension/schemas.js";
import { serializeAgent } from "../../packages/subagents/src/agents/agent-serializer.js";
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

function withFakeCli<T>(script: string, fn: (dir: string, scriptPath: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-no-acceptance-"));
	const scriptPath = join(dir, "fake-pi.js");
	const previousArgv1 = process.argv[1];
	writeFileSync(scriptPath, script, { mode: 0o700 });
	process.argv[1] = scriptPath;
	return fn(dir, scriptPath).finally(() => {
		process.argv[1] = previousArgv1;
		rmSync(dir, { recursive: true, force: true });
	});
}

describe("subagent acceptance removal", () => {
	test("foreground runs do not inject, evaluate, or strip acceptance reports", async () => {
		await withFakeCli(`
			const fs = require("node:fs");
			const path = require("node:path");
			const prompt = process.argv[process.argv.length - 1] || "";
			fs.writeFileSync(path.join(process.cwd(), "prompt.log"), prompt, "utf8");
			const text = [
				"done",
				"\`\`\`acceptance-report",
				"{not-valid-json}",
				"\`\`\`"
			].join("\\n");
			console.log(JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					stopReason: "stop",
					usage: { input: 1, output: 1 },
					timestamp: Date.now()
				}
			}));
		`, async (dir) => {
			const result = await runSync(dir, [agentConfig()], "fake-worker", "Preserve reports", {
				cwd: dir,
				runId: "no-acceptance-gates",
				artifactsDir: dir,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.error, undefined);
			assert.equal("acceptance" in result, false);
			assert.match(result.finalOutput ?? "", /```acceptance-report/);
			assert.match(result.finalOutput ?? "", /\{not-valid-json\}/);

			const prompt = readFileSync(join(dir, "prompt.log"), "utf8");
			assert.match(prompt, /Task: Preserve reports/);
			assert.doesNotMatch(prompt, /Acceptance Contract|Acceptance level|acceptance-report/);

			const artifactInput = result.artifactPaths?.inputPath ? readFileSync(result.artifactPaths.inputPath, "utf8") : "";
			assert.match(artifactInput, /Preserve reports/);
			assert.doesNotMatch(artifactInput, /Acceptance Contract|Acceptance level|acceptance-report/);
		});
	});


	test("foreground investigation/debugger runs can complete successfully without edits", async () => {
		await withFakeCli(`
			console.log(JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Likely fix: make cache writes atomic." }],
					stopReason: "stop",
					usage: { input: 1, output: 1 },
					timestamp: Date.now()
				}
			}));
		`, async (dir) => {
			const debuggerAgent: AgentConfig = {
				...agentConfig(),
				name: "debugger",
				description: "Investigates issues",
				filePath: "debugger.md",
				systemPrompt: "Investigate and report findings.",
				tools: ["bash"],
			};
			const result = await runSync(dir, [debuggerAgent], "debugger", "Investigate the likely fix for the cache race", {
				cwd: dir,
				runId: "no-edit-investigation",
				artifactsDir: dir,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.error, undefined);
			assert.match(result.finalOutput ?? "", /Likely fix/);
			assert.equal(result.progress?.status, "completed");
			assert.doesNotMatch(JSON.stringify(result.controlEvents ?? []), /completion_guard/);
		});
	});

	test("background investigation/debugger runner can complete successfully without edits", async () => {
		await withFakeCli(`
			console.log(JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Background finding: guard should not fail investigations." }],
					stopReason: "stop",
					usage: { input: 1, output: 1 },
					timestamp: Date.now()
				}
			}));
		`, async (dir, scriptPath) => {
			const asyncDir = join(dir, "async");
			mkdirSync(asyncDir, { recursive: true });
			const resultPath = join(dir, "result.json");
			const configPath = join(dir, "runner-config.json");
			writeFileSync(configPath, JSON.stringify({
				id: "background-no-edit-investigation",
				steps: [{
					agent: "debugger",
					task: "Investigate the likely fix for the cache race",
					cwd: dir,
					tools: ["bash"],
					systemPrompt: "Investigate and report findings.",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
				}],
				resultPath,
				cwd: dir,
				placeholder: "{previous}",
				asyncDir,
				piArgv1: scriptPath,
				resultMode: "single",
			}), "utf8");

			const runnerPath = join(process.cwd(), "packages/subagents/src/runs/background/subagent-runner.ts");
			const proc = spawnSync(process.execPath, [runnerPath, configPath], { cwd: process.cwd(), encoding: "utf8" });
			assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
			const result = JSON.parse(readFileSync(resultPath, "utf8")) as { exitCode?: number; state?: string; success?: boolean; summary?: string };
			assert.equal(result.exitCode, 0);
			assert.equal(result.state, "complete");
			assert.equal(result.success, true);
			assert.match(result.summary ?? "", /Background finding/);

			const status = readFileSync(join(asyncDir, "status.json"), "utf8");
			const events = readFileSync(join(asyncDir, "events.jsonl"), "utf8");
			assert.doesNotMatch(`${status}\n${events}`, /completion_guard/);
		});
	});

	test("subagent tool schema no longer exposes acceptance fields", () => {
		const serialized = JSON.stringify(SubagentParams);

		assert.doesNotMatch(serialized, /\"acceptance\"/);
		assert.doesNotMatch(serialized, /AcceptanceOverride|Acceptance level|acceptance policy/);
		assert.doesNotMatch(serialized, /completionGuard|completion_guard|completion guard/i);

		const serializedAgent = serializeAgent({ ...agentConfig(), completionGuard: false } as AgentConfig);
		assert.doesNotMatch(serializedAgent, /completionGuard|completion guard/i);

		const serializedLegacyAgent = serializeAgent({ ...agentConfig(), extraFields: { completionGuard: "false" } });
		assert.doesNotMatch(serializedLegacyAgent, /completionGuard|completion guard/i);
	});
});
