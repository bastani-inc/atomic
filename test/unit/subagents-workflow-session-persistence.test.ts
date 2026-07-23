import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "bun:test";
import { WORKFLOW_SESSION_METADATA_ENV } from "../../packages/coding-agent/src/core/session-manager-classification.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";

const workflow = { runId: "run-1", stageId: "stage-1", stageName: "build" };

function agentConfig(): AgentConfig {
	return {
		name: "fake-worker",
		description: "Fake worker",
		source: "project",
		filePath: "fake-worker.md",
		systemPrompt: "Finish immediately.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-responses" as const,
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function childCliSource(): string {
	const managerPath = join(process.cwd(), "packages/coding-agent/src/core/session-manager.ts");
	const mainSessionPath = join(process.cwd(), "packages/coding-agent/src/main-session.ts");
	return `
		import { SessionManager } from ${JSON.stringify(managerPath)};
		import { applyInheritedWorkflowSessionClassification } from ${JSON.stringify(mainSessionPath)};
		const args = process.argv.slice(2);
		const valueAfter = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
		const sessionFile = valueAfter("--session");
		const sessionDir = valueAfter("--session-dir");
		const manager = sessionFile
			? SessionManager.open(sessionFile, undefined, process.cwd())
			: SessionManager.create(process.cwd(), sessionDir);
		applyInheritedWorkflowSessionClassification(manager);
		manager.appendMessage({ role: "user", content: "child task", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant", content: [{ type: "text", text: "done" }],
			api: "openai-responses", provider: "openai", model: "gpt-5.4",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		});
		console.log(JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop",
				usage: { input: 1, output: 1 }, timestamp: Date.now() },
		}));
	`;
}

async function withChildCli(fn: (root: string, scriptPath: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "atomic-workflow-subagent-persist-"));
	const scriptPath = join(root, "child-cli.ts");
	writeFileSync(scriptPath, childCliSource());
	try {
		await fn(root, scriptPath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function readHeader(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as Record<string, unknown>;
}

describe("workflow subagent persisted session classification", () => {
	test("foreground fresh child persists classification through the real executor handoff", async () => {
		await withChildCli(async (root, scriptPath) => {
			const sessionDir = join(root, "custom-sessions");
			const sessionFile = join(sessionDir, "fresh.jsonl");
			const result = await runSync(root, [agentConfig()], "fake-worker", "Do work", {
				cwd: root,
				runId: "foreground-fresh",
				sessionDir,
				sessionFile,
				piArgv1: scriptPath,
				workflowStageSubagentGuard: true,
				workflowSessionMetadata: workflow,
			});

			assert.equal(result.exitCode, 0, result.error);
			assert.deepEqual(readHeader(sessionFile).workflow, workflow);
			assert.equal(readHeader(sessionFile).internal, true);
			assert.deepEqual(await SessionManager.list(root, sessionDir), []);
		});
	});

	test("same-cwd fork child stays classified through fork resolver and foreground executor", async () => {
		await withChildCli(async (root, scriptPath) => {
			const sessionDir = join(root, "fork-sessions");
			const parent = SessionManager.create(root, sessionDir, { internal: true, workflow });
			parent.appendMessage({ role: "user", content: "parent task", timestamp: Date.now() });
			const leafId = parent.appendMessage(assistantMessage("parent done"));
			assert.ok(parent.getSessionFile());
			assert.equal(parent.getLeafId(), leafId);
			const forkFile = createForkContextResolver(parent, "fork").sessionFileForIndex(0);
			assert.ok(forkFile);

			const result = await runSync(root, [agentConfig()], "fake-worker", "Continue fork", {
				cwd: root,
				runId: "foreground-fork",
				sessionFile: forkFile,
				piArgv1: scriptPath,
				workflowStageSubagentGuard: true,
				workflowSessionMetadata: workflow,
			});

			assert.equal(result.exitCode, 0, result.error);
			assert.equal(readHeader(forkFile).internal, true);
			assert.deepEqual(readHeader(forkFile).workflow, workflow);
			assert.deepEqual(await SessionManager.list(root, sessionDir), []);
		});
	});

	test("background runner persists a fresh classified child session", async () => {
		await withChildCli(async (root, scriptPath) => {
			const asyncDir = join(root, "async");
			const sessionDir = join(root, "background-sessions");
			const resultPath = join(root, "result.json");
			const configPath = join(root, "runner-config.json");
			writeFileSync(configPath, JSON.stringify({
				id: "background-workflow-child",
				steps: [{
					agent: "fake-worker", task: "Do work", cwd: root,
					systemPrompt: "Finish immediately.", systemPromptMode: "replace",
					inheritProjectContext: false, inheritSkills: false,
				}],
				resultPath, cwd: root, placeholder: "{previous}", asyncDir, sessionDir,
				piArgv1: scriptPath, resultMode: "single", workflowStageSubagentGuard: true,
			}), "utf8");
			const runnerPath = join(process.cwd(), "packages/subagents/src/runs/background/subagent-runner.ts");
			const proc = spawnSync(process.execPath, [runnerPath, configPath], {
				cwd: process.cwd(),
				encoding: "utf8",
				env: { ...process.env, [WORKFLOW_SESSION_METADATA_ENV]: JSON.stringify(workflow) },
			});

			assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
			const sessionFiles = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
			assert.equal(sessionFiles.length, 1);
			const sessionFile = join(sessionDir, sessionFiles[0]!);
			assert.equal(readHeader(sessionFile).internal, true);
			assert.deepEqual(readHeader(sessionFile).workflow, workflow);
			assert.deepEqual(await SessionManager.list(root, sessionDir), []);
		});
	}, 20_000);
});
