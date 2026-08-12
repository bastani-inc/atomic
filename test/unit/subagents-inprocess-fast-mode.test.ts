import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_CODEX_FAST_MODE, getEnvNames } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { executeAsyncSingle } from "../../packages/subagents/src/runs/inprocess/background-single.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import {
	ASYNC_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
} from "../../packages/subagents/src/shared/types.ts";

const fastModeEnvNames = getEnvNames(ENV_CODEX_FAST_MODE);
let previousFastModeEnv: Record<string, string | undefined> = {};

const tempRoots: string[] = [];
const CODEX_MODEL = "openai/gpt-5.1-codex";

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "fast-mode fixture worker",
		systemPrompt: "Return the fixture output.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/fast-mode-worker.md",
	};
}

function setupRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-fast-mode-"));
	tempRoots.push(root);
	mkdirSync(join(root, ".atomic"), { recursive: true });
	writeFileSync(
		join(root, ".atomic", "settings.json"),
		JSON.stringify({ codexFastMode: { chat: false, workflow: true } }),
		"utf8",
	);
	return root;
}

beforeEach(() => {
	previousFastModeEnv = Object.fromEntries(fastModeEnvNames.map((name) => [name, process.env[name]]));
	for (const name of fastModeEnvNames) delete process.env[name];
});

afterEach(() => {
	clearSubagentControls();
	for (const name of fastModeEnvNames) {
		if (previousFastModeEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousFastModeEnv[name];
	}
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("in-process child results use the workflow fast-mode setting for workflow stages", async () => {
	const root = setupRoot();
	const workflowResult = await runSingleInProcess(root, agent(), "workflow task", {
		cwd: root,
		runId: "workflow-fast-mode",
		modelOverride: CODEX_MODEL,
		workflowStageSubagentGuard: true,
		workflowSessionMetadata: {
			runId: "workflow-run",
			stageId: "stage-1",
			stageName: "Stage 1",
		},
		testSession: { output: "workflow result" },
	});
	const chatResult = await runSingleInProcess(root, agent(), "chat task", {
		cwd: root,
		runId: "chat-fast-mode",
		modelOverride: CODEX_MODEL,
		testSession: { output: "chat result" },
	});

	assert.equal(workflowResult.model, CODEX_MODEL);
	assert.equal(workflowResult.fastMode, true);
	assert.equal(chatResult.model, CODEX_MODEL);
	assert.equal(chatResult.fastMode, undefined);
});

test("async workflow child launch and completion retain the scoped fast marker", async () => {
	const root = setupRoot();
	const runId = `workflow-fast-mode-async-${crypto.randomUUID()}`;
	const started = Promise.withResolvers<unknown>();
	const completed = Promise.withResolvers<unknown>();
	const events = {
		emit(event: string, payload: unknown): void {
			if (event === SUBAGENT_ASYNC_STARTED_EVENT) started.resolve(payload);
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) completed.resolve(payload);
		},
	};

	try {
		const launched = await executeAsyncSingle(runId, {
			agent: "worker",
			task: "async workflow task",
			agentConfig: agent(),
			ctx: {
				pi: { events } as never,
				cwd: root,
				currentSessionId: "parent-session",
				workflowSessionMetadata: { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" },
			},
			cwd: root,
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 0,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			testSession: { output: "async workflow result" },
		});

		assert.equal(launched.details.results[0]?.model, CODEX_MODEL);
		assert.equal(launched.details.results[0]?.fastMode, true);
		const startedEvent = (await started.promise) as { model?: string; fastMode?: boolean };
		assert.equal(startedEvent.model, CODEX_MODEL);
		assert.equal(startedEvent.fastMode, true);
		const completionEvent = (await completed.promise) as { result?: { model?: string; fastMode?: boolean } };
		assert.equal(completionEvent.result?.model, CODEX_MODEL);
		assert.equal(completionEvent.result?.fastMode, true);
	} finally {
		rmSync(join(ASYNC_DIR, runId), { recursive: true, force: true });
	}
});
