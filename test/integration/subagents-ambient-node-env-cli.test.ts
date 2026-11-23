import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { makeTempDirectory, moduleDir, readStreamText, spawnProcess } from "../helpers/runtime.js";
import { messageText, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
const CLI_SUBAGENT_TIMEOUT_MS = 60_000;

test(
	"shipped CLI runs real subagent model turns even when the user's shell sets NODE_ENV=test",
	async () => {
		const root = makeTempDirectory("cli-node-env-test-subagent-");
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		let childCalls = 0;
		let waited = false;
		const server = await startScriptedChatServer(({ messages }) => {
			const last = messages.at(-1);
			const lastUser = [...messages].reverse().find((m) => m.role === "user");
			const prompt = messageText(lastUser);
			if (prompt.includes("RUN_REAL_SUBAGENT")) {
				if (last?.role === "tool") {
					const toolText = messageText(last);
					if (!waited) {
						waited = true;
						const taskId = /"taskId":"([^"]+)"/.exec(toolText)?.[1];
						if (taskId) {
							return {
								label: "parent-wait",
								text: "Waiting for real worker.",
								chunks: 1,
								chunkDelayMs: 0,
								toolCalls: [{ name: "subagent", arguments: { action: "wait", id: taskId } }],
							};
						}
					}
					return {
						label: "parent-done",
						text: `FINAL:${toolText}`,
						chunks: 1,
						chunkDelayMs: 0,
					};
				}
				return {
					label: "parent-launch",
					text: "Launching real worker.",
					chunks: 1,
					chunkDelayMs: 0,
					toolCalls: [
						{
							name: "subagent",
							arguments: {
								context: "fresh",
								agent: "worker",
								model: "scripted/local",
								task: "CHILD_TASK_MARKER",
							},
						},
					],
				};
			}
			if (prompt.includes("Subagent worker completed")) {
				return { label: "wake", text: `WAKE:${prompt}`, chunks: 1, chunkDelayMs: 0 };
			}
			if (prompt.includes("CHILD_TASK_MARKER")) {
				childCalls++;
				return { label: "child", text: "REAL_SUBAGENT_CLI_REPLY", chunks: 1, chunkDelayMs: 0 };
			}
			return { label: "other", text: "OTHER", chunks: 1, chunkDelayMs: 0 };
		});

		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					scripted: {
						api: "openai-completions",
						apiKey: "fixture",
						baseUrl: server.baseUrl,
						models: [
							{
								id: "local",
								name: "local",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "scripted",
				defaultModel: "local",
				lastChangelogVersion: "0.0.0",
				firstRunOnboardingStartedVersion: "0.0.0",
				onboardedVersion: "0.0.0",
				sessionSummary: { enabled: false },
			}),
		);

		const osEnv: Record<string, string> = {};
		for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
			const value = process.env[key];
			if (value !== undefined) osEnv[key] = value;
		}

		try {
			const child = spawnProcess(
				[
					process.execPath,
					CLI,
					"--offline",
					"--no-mcp",
					"--no-session",
					"--provider",
					"scripted",
					"--model",
					"local",
					"-p",
					"RUN_REAL_SUBAGENT",
				],
				{
					cwd,
					env: {
						...osEnv,
						// Simulate a real user whose shell has NODE_ENV=test set!
						NODE_ENV: "test",
						HOME: root,
						USERPROFILE: root,
						ATOMIC_CODING_AGENT_DIR: agentDir,
						ATOMIC_CODING_AGENT_SESSION_DIR: "",
						ATOMIC_STORAGE: "",
						ATOMIC_SESSIONS_STORAGE: "",
						ATOMIC_INTERCOM_SESSION_ID: "",
						ATOMIC_SKIP_VERSION_CHECK: "1",
						ATOMIC_TELEMETRY: "0",
					},
					stdout: "pipe",
					stderr: "pipe",
					timeout: CLI_SUBAGENT_TIMEOUT_MS,
				},
			);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				readStreamText(child.stdout),
				readStreamText(child.stderr),
			]);
			assert.equal(code, 0, stderr);
			assert.equal(childCalls, 1, `subagent must call the real model under NODE_ENV=test; stdout:\n${stdout}`);
			assert.match(stdout, /REAL_SUBAGENT_CLI_REPLY/);
		} finally {
			try {
				await server.close();
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		}
	},
	CLI_SUBAGENT_TIMEOUT_MS,
);
