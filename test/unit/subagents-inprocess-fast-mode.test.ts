import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_CODEX_FAST_MODE, getEnvNames } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.ts";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";

const fastModeEnvNames = getEnvNames(ENV_CODEX_FAST_MODE);
const agentDirEnvNames = getEnvNames(ENV_AGENT_DIR);
let previousFastModeEnv: Record<string, string | undefined> = {};
let previousAgentDirEnv: Record<string, string | undefined> = {};

const tempRoots: string[] = [];
const CODEX_MODEL = "openai/gpt-5.1-codex";
// Structural cost (AGENTS.md per-test timeout policy): the real-session test
// below (`testSession: false`) bootstraps a full builtin-package loader load
// for the in-process child. On Windows CI the child's cwd differs from the
// cached loader cwd, forcing a transformed re-import of the whole builtin
// extension graph (~15 ms/file x ~620 files, measured ~58 s cold). That cost
// is the loader's documented correctness cost, not a slow test nobody fixed.
const REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS = 180_000;

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
async function requestBody(init: RequestInit | undefined): Promise<Record<string, unknown> | undefined> {
	const text = await new Response(init?.body).text();
	return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

function completedOpenAIResponse(): Response {
	const message = {
		id: "msg_subagent_fast_mode",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
		phase: "final_answer",
	};
	const events = [
		{ type: "response.created", response: { id: "resp_subagent_fast_mode", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item: message },
		{
			type: "response.completed",
			response: {
				id: "resp_subagent_fast_mode",
				status: "completed",
				output: [message],
				usage: {
					input_tokens: 0,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 0,
					total_tokens: 0,
				},
			},
		},
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function setupRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-fast-mode-"));
	tempRoots.push(root);
	mkdirSync(join(root, ".atomic"), { recursive: true });
	writeFileSync(
		join(root, ".atomic", "settings.json"),
		JSON.stringify({
			defaultProvider: "openai",
			defaultModel: "gpt-5.1-codex",
			codexFastMode: { chat: false, workflow: true },
		}),
		"utf8",
	);
	return root;
}
beforeEach(() => {
	previousFastModeEnv = Object.fromEntries(fastModeEnvNames.map((name) => [name, process.env[name]]));
	previousAgentDirEnv = Object.fromEntries(agentDirEnvNames.map((name) => [name, process.env[name]]));
	for (const name of fastModeEnvNames) delete process.env[name];
	for (const name of agentDirEnvNames) delete process.env[name];
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearSubagentControls();
	for (const name of fastModeEnvNames) {
		if (previousFastModeEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousFastModeEnv[name];
	}
	for (const name of agentDirEnvNames) {
		if (previousAgentDirEnv[name] === undefined) delete process.env[name];
		else process.env[name] = previousAgentDirEnv[name];
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

test("foreground launch updates carry step metadata before the prompt settles", async () => {
	const root = setupRoot();
	const gate = Promise.withResolvers<void>();
	const updates: Array<{ details?: { progress?: Array<{ model?: string; thinking?: string; fastMode?: boolean }> } }> =
		[];
	try {
		const running = runSingleInProcess(root, { ...agent(), thinking: "high" }, "launch task", {
			cwd: root,
			runId: "foreground-launch-metadata",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			testSession: { output: "launch result", promptGate: gate.promise },
			onUpdate: (update) => updates.push(update),
		});
		const progress = updates[0]?.details?.progress?.[0];
		assert.equal(progress?.model, CODEX_MODEL);
		assert.equal(progress?.thinking, "high");
		assert.equal(progress?.fastMode, true);
		gate.resolve();
		assert.equal((await running).status, "ok");
	} finally {
		gate.resolve();
	}
});

test("foreground results and live progress follow the effective fallback model's fast-mode scope", async () => {
	const root = setupRoot();
	const fallbackModel = "anthropic/claude-sonnet-4";
	const liveResults: Array<{ model?: string; thinking?: string; fastMode?: boolean }> = [];
	const fallbackAgent: AgentConfig = {
		...agent(),
		thinking: "low",
		fallbackModels: [`${fallbackModel}:high`],
	};

	const result = await runSingleInProcess(root, fallbackAgent, "fallback task", {
		cwd: root,
		runId: "foreground-fallback-metadata",
		modelOverride: CODEX_MODEL,
		workflowSessionMetadata: { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" },
		testSession: { output: "fallback result", fallbackModel, fallbackThinkingLevel: "high" },
		onUpdate: (update) => {
			const liveResult = update.details?.results[0];
			if (liveResult) liveResults.push(liveResult);
		},
	});

	assert.equal(result.model, fallbackModel);
	assert.equal(result.thinking, "high");
	assert.equal(result.fastMode, undefined);
	assert.ok(
		liveResults.some(
			(liveResult) =>
				liveResult.model === fallbackModel && liveResult.thinking === "high" && liveResult.fastMode === undefined,
		),
		"live progress should use the fallback model's effective thinking and fast-mode scope",
	);
});

test(
	"stage-launched in-process children carry workflow priority tier to the provider request",
	async () => {
		const root = setupRoot();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ openai: { type: "api_key", key: "test-api-key" } }),
			"utf8",
		);
		for (const name of agentDirEnvNames) process.env[name] = agentDir;
		const payloads: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const payload = await requestBody(init);
				if (payload) payloads.push(payload);
				return completedOpenAIResponse();
			}),
		);
		const workflowSessionMetadata = { runId: "workflow-run", stageId: "stage-1", stageName: "Stage 1" };
		const enabled = await runSingleInProcess(root, agent(), "priority request", {
			cwd: root,
			runId: "workflow-real-request-enabled",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			workflowSessionMetadata,
			testSession: false,
		});
		assert.equal(enabled.status, "ok");
		assert.ok(payloads.length > 0);
		for (const payload of payloads) assert.equal(payload.service_tier, "priority");
		payloads.length = 0;

		writeFileSync(
			join(root, ".atomic", "settings.json"),
			JSON.stringify({
				defaultProvider: "openai",
				defaultModel: "gpt-5.1-codex",
				codexFastMode: { chat: false, workflow: false },
			}),
			"utf8",
		);
		const disabled = await runSingleInProcess(root, agent(), "ordinary request", {
			cwd: root,
			runId: "workflow-real-request-disabled",
			modelOverride: CODEX_MODEL,
			workflowStageSubagentGuard: true,
			workflowSessionMetadata,
			testSession: false,
		});
		assert.equal(disabled.status, "ok");
		assert.ok(payloads.length > 0);
		for (const payload of payloads) assert.equal(payload.service_tier, undefined);
	},
	REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS,
);

test(
	"real child results report the session's clamped thinking level",
	async () => {
		const root = setupRoot();
		writeFileSync(
			join(root, ".atomic", "settings.json"),
			JSON.stringify({
				defaultProvider: "openai",
				defaultModel: "non-reasoning-fixture",
				codexFastMode: { chat: false, workflow: true },
			}),
			"utf8",
		);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ openai: { type: "api_key", key: "test-api-key" } }),
			"utf8",
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					openai: {
						api: "openai-responses",
						baseUrl: "https://api.openai.example/v1",
						models: [
							{
								id: "non-reasoning-fixture",
								name: "Non-reasoning fixture",
								reasoning: false,
								input: ["text"],
								contextWindow: 128_000,
								maxTokens: 4_096,
							},
						],
					},
				},
			}),
			"utf8",
		);
		for (const name of agentDirEnvNames) process.env[name] = agentDir;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedOpenAIResponse()),
		);

		const result = await runSingleInProcess(root, { ...agent(), thinking: "xhigh" }, "clamp thinking", {
			cwd: root,
			runId: "real-thinking-clamp",
			modelOverride: "openai/non-reasoning-fixture",
			testSession: false,
		});

		assert.equal(result.status, "ok");
		assert.equal(result.model, "openai/non-reasoning-fixture");
		assert.equal(result.thinking, "off");
		assert.equal(result.progress?.thinking, "off");
	},
	REAL_CHILD_BUILTIN_LOADER_TIMEOUT_MS,
);
