import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { bunExecutable } from "../helpers/runtime.js";

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
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
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

/**
 * Run the foreground executor inside a Bun child and return its exit status.
 *
 * `resolvePiCliScript` accepts a `.ts` entry only when the runtime is Bun, so
 * under vitest's Node worker the stub CLI below is rejected and the executor
 * falls through to the real installed `atomic` -- which then makes a live
 * provider call. Running the executor in a Bun child keeps the stub in play and
 * the suite hermetic, which is what the background case in this file already
 * does.
 */
function runForegroundInBun(root: string, options: Record<string, unknown>, agent: AgentConfig, task: string): void {
	const driverPath = join(root, "foreground-driver.ts");
	const executionPath = join(process.cwd(), "packages/subagents/src/runs/foreground/execution.ts");
	writeFileSync(
		driverPath,
		`
		import { runSync } from ${JSON.stringify(executionPath)};
		const [agent, task, options] = JSON.parse(process.argv[2]);
		const result = await runSync(${JSON.stringify(root)}, [agent], task, options.taskText ?? task, options);
		if (result.status !== "ok") {
			console.error(result.error ?? "foreground executor failed");
			process.exit(1);
		}
		`,
		"utf8",
	);
	const proc = spawnSync(bunExecutable(), [driverPath, JSON.stringify([agent, task, options])], {
		cwd: root,
		encoding: "utf8",
		env: process.env,
	});
	assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
}

function readHeader(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as Record<string, unknown>;
}

describe("workflow subagent persisted session classification", () => {
	test("foreground fresh child persists classification through the real executor handoff", async () => {
		await withChildCli(async (root, scriptPath) => {
			const sessionDir = join(root, "custom-sessions");
			const sessionFile = join(sessionDir, "fresh.jsonl");
			runForegroundInBun(
				root,
				{
					cwd: root,
					runId: "foreground-fresh",
					sessionDir,
					sessionFile,
					piArgv1: scriptPath,
					workflowStageSubagentGuard: true,
					workflowSessionMetadata: workflow,
				},
				agentConfig(),
				"fake-worker",
			);

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

			runForegroundInBun(
				root,
				{
					cwd: root,
					runId: "foreground-fork",
					sessionFile: forkFile,
					piArgv1: scriptPath,
					workflowStageSubagentGuard: true,
					taskText: "Continue fork",
				},
				agentConfig(),
				"fake-worker",
			);

			assert.equal(readHeader(forkFile).internal, true);
			assert.deepEqual(readHeader(forkFile).workflow, workflow);
			assert.deepEqual(await SessionManager.list(root, sessionDir), []);
		});
	});
});
