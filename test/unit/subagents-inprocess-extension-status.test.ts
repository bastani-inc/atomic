import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvNames } from "@bastani/atomic";
import { test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import type { Cleanup } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.ts";

/** Structural cost, not a slow test: a real child session performs a full builtin-package loader reload. */
const LIVE_CHILD_RESOURCE_RELOAD_TIMEOUT_MS = 120_000;

function agent(): AgentConfig {
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

function completedOpenAIResponse(): Response {
	const message = {
		id: "msg_status",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
		phase: "final_answer",
	};
	const events = [
		{ type: "response.created", response: { id: "resp_status", status: "in_progress" } },
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
				id: "resp_status",
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
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test(
	"a live in-process child's extension statuses reach its task, not the parent, and end with the child (#4103)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-extension-status-"));
		const agentDir = join(root, "agent");
		const agentDirEnvNames = getEnvNames(ENV_AGENT_DIR);
		const previousAgentDirEnv = Object.fromEntries(agentDirEnvNames.map((name) => [name, process.env[name]]));
		mkdirSync(join(root, ".atomic"), { recursive: true });
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(root, ".atomic", "settings.json"),
			JSON.stringify({ defaultProvider: "openai", defaultModel: "status-fixture" }),
			"utf8",
		);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test-api-key" } }));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					openai: {
						api: "openai-responses",
						baseUrl: "https://api.openai.example/v1",
						models: [
							{
								id: "status-fixture",
								name: "Status fixture",
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
		writeFileSync(
			join(agentDir, "extensions", "child-status.js"),
			`export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("tps", "12 tok/s");
		ctx.ui.setStatus("gone", "short lived");
		ctx.ui.setStatus("gone", undefined);
		globalThis.__childStatusHasUI = ctx.hasUI;
	});
}
`,
			"utf8",
		);
		for (const name of agentDirEnvNames) process.env[name] = agentDir;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedOpenAIResponse()),
		);
		clearSubagentControls();
		try {
			const live = new Map<string, string>();
			const calls: string[] = [];
			let cleanup: Promise<Cleanup> | undefined;
			const hooks: TaskExecutionHooks = {
				signal: new AbortController().signal,
				reportActivity() {},
				setExtensionStatus(key, text) {
					calls.push(`${key}=${text ?? "(removed)"}`);
					if (text === undefined) live.delete(key);
					else live.set(key, text);
				},
				clearExtensionStatuses() {
					calls.push("(cleared)");
					live.clear();
				},
				onExecution(execution) {
					cleanup = execution.cleanup;
				},
				yieldTaskWait() {},
				isParentObserving: () => false,
			};

			const result = await runSingleInProcess(root, agent(), "report a status", {
				cwd: root,
				runId: "child-extension-status",
				sessionDir: join(root, "sessions"),
				testSession: false,
				taskExecution: hooks,
			});
			await cleanup;

			assert.equal(result.status, "ok");
			// The child's own session wrote them; the task's store received them in order.
			assert.deepEqual(calls.slice(0, 3), ["tps=12 tok/s", "gone=short lived", "gone=(removed)"]);
			// Statuses end with the child's session.
			assert.equal(calls.at(-1), "(cleared)");
			assert.equal(live.size, 0);
			// The child still presents no UI to its extensions: binding the sink did not make it interactive.
			assert.equal((globalThis as { __childStatusHasUI?: boolean }).__childStatusHasUI, false);
		} finally {
			delete (globalThis as { __childStatusHasUI?: boolean }).__childStatusHasUI;
			vi.unstubAllGlobals();
			for (const name of agentDirEnvNames) {
				if (previousAgentDirEnv[name] === undefined) delete process.env[name];
				else process.env[name] = previousAgentDirEnv[name];
			}
			clearSubagentControls();
			rmSync(root, { recursive: true, force: true });
		}
	},
	LIVE_CHILD_RESOURCE_RELOAD_TIMEOUT_MS,
);
