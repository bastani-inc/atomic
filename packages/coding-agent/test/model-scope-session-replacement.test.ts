import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE } from "../src/config.js";
import type { ActivityWatchdogDiagnostic } from "../src/modes/interactive-engine/activity-watchdog.js";
import { renderEngineDiagnostic } from "../src/modes/interactive-engine/engine-diagnostic-view.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import type { RpcExtensionUIRequest, RpcModelCatalog } from "../src/modes/rpc/rpc-types.js";
import { bunExecutable, cliPath, removeTempDirs } from "./cli-test-helpers.js";

const REAL_RPC_CLI_TIMEOUT_MS = 60_000;
const tempDirs: string[] = [];

afterEach(() => {
	removeTempDirs(tempDirs);
});

async function runNewSessionOverRpc(agentDir: string, projectDir: string): Promise<string> {
	const child = spawn(
		bunExecutable(),
		[cliPath, "--mode", "rpc", "--no-session", "--no-skills", "--no-themes", "--no-prompt-templates"],
		{
			cwd: projectDir,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_CODING_AGENT_DIR: "", [ENV_OFFLINE]: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<void>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", () => resolvePromise());
	});
	await new Promise<void>((resolvePromise, reject) => {
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes('"command":"new_session"')) resolvePromise();
		});
		child.on("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
		child.stdin.write(`${JSON.stringify({ id: "1", type: "new_session" })}\n`);
	});
	child.stdin.end();
	await exited;
	return stderr;
}

describe("model scope warnings on session replacement", () => {
	it(
		"reports unmatched enabledModels patterns once at startup, not again on new_session (#4694)",
		async () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "atomic-model-scope-replacement-"));
			tempDirs.push(tempRoot);
			const agentDir = join(tempRoot, "agent");
			const projectDir = join(tempRoot, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						fake: {
							baseUrl: "http://127.0.0.1:9/v1",
							api: "openai-completions",
							apiKey: "test",
							models: [{ id: "fake-model" }],
						},
					},
				}),
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: "fake",
					defaultModel: "fake-model",
					enabledModels: ["fake/fake-model", "github-copilot/missing-model"],
				}),
			);

			const stderr = await runNewSessionOverRpc(agentDir, projectDir);

			assert.equal(stderr.match(/No models match pattern "github-copilot\/missing-model"/g)?.length ?? 0, 1);
		},
		REAL_RPC_CLI_TIMEOUT_MS,
	);

	it(
		"surfaces unmatched model scope patterns once in isolated interactive engine after deferred extension load and not again on new_session (#4694)",
		async () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "atomic-isolated-model-scope-"));
			tempDirs.push(tempRoot);
			const agentDir = join(tempRoot, "agent");
			const projectDir = join(tempRoot, "project");
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						fake: {
							baseUrl: "http://127.0.0.1:9/v1",
							api: "openai-completions",
							apiKey: "test",
							models: [{ id: "fake-model" }],
						},
					},
				}),
			);
			writeFileSync(
				join(agentDir, "extensions", "provider.ts"),
				`export default function(pi) {
					pi.registerProvider("ext-provider", {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "test",
						models: [{
							id: "ext-model",
							name: "Extension Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 8192,
							maxTokens: 256,
						}],
					});
				}`,
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: "fake",
					defaultModel: "fake-model",
					enabledModels: ["fake/fake-model", "ext-provider/ext-model", "github-copilot/missing-model"],
				}),
			);

			const chatStatuses: string[] = [];
			const chatErrors: string[] = [];
			const client = new RpcClient({
				cliPath,
				cwd: projectDir,
				runtimeExecutable: bunExecutable(),
				args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates"],
				env: { [ENV_AGENT_DIR]: agentDir, PI_CODING_AGENT_DIR: "" },
				interactiveEngine: {
					onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => {
						renderEngineDiagnostic(diagnostic, {
							stopWorkingLoader() {},
							showStatus: (message) => chatStatuses.push(message),
							showError: (message) => chatErrors.push(message),
						});
					},
				},
			});

			try {
				await client.start();
				await client.waitForInteractiveEngineResources();
				const catalog = await client.requestInternal<RpcModelCatalog>({ type: "get_available_models" });
				assert.deepEqual(
					(catalog.scopedModels ?? []).map((entry) => `${entry.model.provider}/${entry.model.id}`),
					["fake/fake-model", "ext-provider/ext-model"],
				);

				const replacement = await client.newSession();
				assert.equal(replacement.cancelled, false);
				await client.getState();
				await new Promise<void>((resolve) => setImmediate(resolve));

				const renderedChat = chatStatuses.join("\n");
				assert.equal(chatErrors.length, 0);
				assert.equal(renderedChat.match(/No models match pattern "ext-provider\/ext-model"/g)?.length ?? 0, 0);
				assert.equal(
					renderedChat.match(/No models match pattern "github-copilot\/missing-model"/g)?.length ?? 0,
					1,
				);
			} finally {
				await client.stop();
			}
		},
		REAL_RPC_CLI_TIMEOUT_MS,
	);

	it(
		"reports trusted project enabledModels warnings once after deferred project trust approval and not again on new_session (#4694)",
		async () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "atomic-isolated-trust-model-scope-"));
			tempDirs.push(tempRoot);
			const agentDir = join(tempRoot, "agent");
			const projectDir = join(tempRoot, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(projectDir, ".atomic", "extensions"), { recursive: true });
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						fake: {
							baseUrl: "http://127.0.0.1:9/v1",
							api: "openai-completions",
							apiKey: "test",
							models: [{ id: "fake-model" }],
						},
					},
				}),
			);
			writeFileSync(join(projectDir, ".atomic", "extensions", "noop.ts"), "export default function() {}\n");
			writeFileSync(
				join(projectDir, ".atomic", "settings.json"),
				JSON.stringify({
					defaultProvider: "fake",
					defaultModel: "fake-model",
					enabledModels: ["fake/fake-model", "github-copilot/missing-model", "github-copilot/missing-model"],
				}),
			);

			const chatStatuses: string[] = [];
			const chatErrors: string[] = [];
			const client = new RpcClient({
				cliPath,
				cwd: projectDir,
				runtimeExecutable: bunExecutable(),
				args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates"],
				env: { [ENV_AGENT_DIR]: agentDir, PI_CODING_AGENT_DIR: "" },
				interactiveEngine: {
					onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => {
						renderEngineDiagnostic(diagnostic, {
							stopWorkingLoader() {},
							showStatus: (message) => chatStatuses.push(message),
							showError: (message) => chatErrors.push(message),
						});
					},
				},
			});
			const trustPrompt = Promise.withResolvers<RpcExtensionUIRequest>();
			client.onExtensionUIRequest((request) => {
				if (request.method === "select") trustPrompt.resolve(request);
			});

			try {
				await client.start();
				const request = await trustPrompt.promise;
				await client.respondExtensionUI({
					type: "extension_ui_response",
					id: request.id,
					value: "Trust (this session only)",
				});
				await client.waitForInteractiveEngineResources();

				const replacement = await client.newSession();
				assert.equal(replacement.cancelled, false);
				await client.getState();
				await new Promise<void>((resolve) => setImmediate(resolve));

				const renderedChat = chatStatuses.join("\n");
				assert.equal(chatErrors.length, 0);
				assert.equal(
					renderedChat.match(/No models match pattern "github-copilot\/missing-model"/g)?.length ?? 0,
					1,
				);
			} finally {
				await client.stop();
			}
		},
		REAL_RPC_CLI_TIMEOUT_MS,
	);
});
