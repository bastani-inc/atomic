import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { resolveFallbackModel } from "../src/core/fallback-models.js";
import { SessionManager } from "../src/core/session-manager.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";

const REAL_STARTUP_RPC_TIMEOUT_MS = 120_000;

function providerConfig(modelIds: string[]) {
	return {
		baseUrl: "https://example.invalid/v1",
		api: "openai-completions",
		apiKey: "local-test-key",
		models: modelIds.map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		})),
	};
}

async function createStartupFallbackFixture(defaultProjectTrust: "always" | "ask") {
	const root = mkdtempSync(join(tmpdir(), "atomic-startup-fallback-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const source = join(root, "saved.jsonl");
	mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "default-provider",
			defaultModel: "default-primary",
			fallbackModels: ["shared-model", "ghost/no-model", "ghost/no-model"],
			defaultProjectTrust,
		}),
	);
	writeFileSync(
		join(agentDir, "extensions", "safe.ts"),
		`export default function(pi) {
			pi.registerProvider("default-provider", ${JSON.stringify(providerConfig(["default-primary"]))});
			pi.registerProvider("other-provider", ${JSON.stringify(providerConfig(["shared-model"]))});
		}`,
	);
	writeFileSync(
		join(cwd, ".atomic", "extensions", "restored.ts"),
		`export default function(pi) {
			pi.registerProvider("restored-provider", ${JSON.stringify(providerConfig(["saved-primary", "shared-model"]))});
		}`,
	);
	const saved = SessionManager.inMemory(cwd);
	await saved.appendModelChange("restored-provider", "saved-primary");
	await saved.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Previous turn finished." }],
		api: "openai-completions",
		provider: "restored-provider",
		model: "saved-primary",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	writeFileSync(
		source,
		`${[saved.getHeader(), ...saved.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return { root, cwd, agentDir, source };
}

test(
	"startup trust checks bare fallback ids against the restored provider and warns once for invalid entries (#5247)",
	async () => {
		const { root, cwd, agentDir, source } = await createStartupFallbackFixture("ask");
		const trustPrompt = Promise.withResolvers<RpcExtensionUIRequest>();
		const invalidWarning = Promise.withResolvers<void>();
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: [
				"--import",
				source,
				"--no-session",
				"--offline",
				"--no-skills",
				"--no-themes",
				"--no-prompt-templates",
				"--no-context-files",
			],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			interactiveEngine: {
				onDiagnostic: ({ message }) => {
					if (message.includes('fallbackModels setting entry "ghost/no-model"')) invalidWarning.resolve();
				},
			},
		});
		client.onExtensionUIRequest((request) => {
			if (request.method === "select") trustPrompt.resolve(request);
		});
		try {
			await client.start();
			const request = await trustPrompt.promise;
			const before = await client.getState();
			assert.equal(before.model?.provider, "default-provider");
			assert.equal(before.model?.id, "default-primary");
			assert.doesNotMatch(client.getStderr(), /fallbackModels setting entry/);
			await client.respondExtensionUI({
				type: "extension_ui_response",
				id: request.id,
				value: "Trust (this session only)",
			});
			await client.waitForInteractiveEngineResources();
			const after = await client.getState();
			assert.equal(after.model?.provider, "restored-provider");
			assert.equal(after.model?.id, "saved-primary");
			const available = await client.getAvailableModels();
			const fallback = resolveFallbackModel(
				"shared-model",
				{ getModels: () => available, hasConfiguredAuth: () => true },
				after.model?.provider,
			);
			assert.equal(fallback?.model.provider, "restored-provider");
			assert.equal(fallback?.model.id, "shared-model");
			await invalidWarning.promise;
			assert.deepEqual(
				[...client.getStderr().matchAll(/fallbackModels setting entry "([^"]+)"/g)].map((match) => match[1]),
				["ghost/no-model"],
			);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

test(
	"eager resumed startup checks bare fallback ids against the restored provider and warns once for invalid entries (#5247)",
	async () => {
		const { root, cwd, agentDir, source } = await createStartupFallbackFixture("always");
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: [
				"--approve",
				"--import",
				source,
				"--no-session",
				"--offline",
				"--no-skills",
				"--no-themes",
				"--no-prompt-templates",
				"--no-context-files",
			],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
		});
		try {
			await client.start();
			const state = await client.getState();
			assert.equal(state.model?.provider, "restored-provider");
			assert.equal(state.model?.id, "saved-primary");
			const available = await client.getAvailableModels();
			const fallback = resolveFallbackModel(
				"shared-model",
				{ getModels: () => available, hasConfiguredAuth: () => true },
				state.model?.provider,
			);
			assert.equal(fallback?.model.provider, "restored-provider");
			assert.equal(fallback?.model.id, "shared-model");
			assert.deepEqual(
				[...client.getStderr().matchAll(/fallbackModels setting entry "([^"]+)"/g)].map((match) => match[1]),
				["ghost/no-model"],
			);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);
