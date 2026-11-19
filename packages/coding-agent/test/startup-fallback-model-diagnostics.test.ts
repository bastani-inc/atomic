import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@bastani/atomic-agent-core";
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

async function createStartupFallbackFixture(defaultProjectTrust: "always" | "ask", savedThinkingLevel?: ThinkingLevel) {
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
	if (savedThinkingLevel) await saved.appendThinkingLevelChange(savedThinkingLevel);
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

test(
	"startup trust uses the configured default provider for bare fallback ids when the session stays on the unknown placeholder (#5247)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-fallback-placeholder-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, ".atomic", "extensions", "noop.ts"), "export default function() {}\n");
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"github-copilot": { type: "api_key", key: "local-test-key" },
				openai: { type: "api_key", key: "local-test-key" },
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "github-copilot",
				defaultModel: "not-in-copilot-cache",
				fallbackModels: ["gpt-5.3-codex", "ghost/no-model", "ghost/no-model"],
				defaultProjectTrust: "ask",
			}),
		);
		const trustPrompt = Promise.withResolvers<RpcExtensionUIRequest>();
		const invalidWarning = Promise.withResolvers<void>();
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: [
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
			assert.doesNotMatch(client.getStderr(), /fallbackModels setting entry/);
			await client.respondExtensionUI({
				type: "extension_ui_response",
				id: request.id,
				value: "Trust (this session only)",
			});
			await client.waitForInteractiveEngineResources();
			await invalidWarning.promise;
			const after = await client.getState();
			assert.equal(after.model?.provider, "unknown");
			assert.equal(after.model?.id, "unknown");
			const available = await client.getAvailableModels();
			const runtimeView = { getModels: () => available, hasConfiguredAuth: () => true };
			assert.equal(resolveFallbackModel("gpt-5.3-codex", runtimeView, after.model?.provider), undefined);
			const fallback = resolveFallbackModel("gpt-5.3-codex", runtimeView, "github-copilot");
			assert.equal(fallback?.model.provider, "github-copilot");
			assert.equal(fallback?.model.id, "gpt-5.3-codex");
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
	"startup trust warns when a continued session provider is missing and preserves saved thinking (#5247)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-trust-restore-warning-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const source = join(root, "saved.jsonl");
		mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "ext-provider",
				defaultModel: "ext-primary",
				defaultProjectTrust: "ask",
			}),
		);
		writeFileSync(
			join(cwd, ".atomic", "extensions", "provider.ts"),
			`export default function(pi) {
				pi.registerProvider("ext-provider", ${JSON.stringify(providerConfig(["ext-primary"]))});
			}\n`,
		);
		const saved = SessionManager.inMemory(cwd);
		await saved.appendModelChange("gone-provider", "old-model");
		await saved.appendThinkingLevelChange("high");
		await saved.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Continue previous work." }],
			timestamp: Date.now(),
		});
		writeFileSync(
			source,
			`${[saved.getHeader(), ...saved.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const trustPrompt = Promise.withResolvers<RpcExtensionUIRequest>();
		const restoreWarning = Promise.withResolvers<void>();
		const expectedWarning = "Could not restore model gone-provider/old-model. Using ext-provider/ext-primary";
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
					if (message.includes(expectedWarning)) restoreWarning.resolve();
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
			assert.equal(before.model?.provider, "unknown");
			assert.equal(before.thinkingLevel, "off");
			await client.respondExtensionUI({
				type: "extension_ui_response",
				id: request.id,
				value: "Trust (this session only)",
			});
			await client.waitForInteractiveEngineResources();
			const after = await client.getState();
			assert.equal(after.model?.provider, "ext-provider");
			assert.equal(after.model?.id, "ext-primary");
			assert.equal(after.thinkingLevel, "high");
			assert.equal(after.modelFallbackMessage, undefined);
			await restoreWarning.promise;
			assert.deepEqual(
				[...client.getStderr().matchAll(/Could not restore model [^\r\n]+/g)].map((match) => match[0].trim()),
				[expectedWarning],
			);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

test(
	"startup trust applies the default medium thinking level after leaving the unknown placeholder (#5247)",
	async () => {
		for (const continuedWithoutThinkingEntry of [false, true]) {
			const root = mkdtempSync(join(tmpdir(), "atomic-startup-trust-thinking-"));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			const source = join(root, "saved.jsonl");
			mkdirSync(join(cwd, ".atomic", "extensions"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: "ext-provider",
					defaultModel: "ext-primary",
					defaultProjectTrust: "ask",
				}),
			);
			writeFileSync(
				join(cwd, ".atomic", "extensions", "provider.ts"),
				`export default function(pi) {
					pi.registerProvider("ext-provider", ${JSON.stringify(providerConfig(["ext-primary"]))});
				}\n`,
			);
			if (continuedWithoutThinkingEntry) {
				const saved = SessionManager.inMemory(cwd);
				await saved.appendModelChange("gone-provider", "old-model");
				await saved.appendMessage({
					role: "user",
					content: [{ type: "text", text: "Continue without explicit thinking entry." }],
					timestamp: Date.now(),
				});
				writeFileSync(
					source,
					`${[saved.getHeader(), ...saved.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				);
			}
			const trustPrompt = Promise.withResolvers<RpcExtensionUIRequest>();
			const client = new RpcClient({
				cliPath,
				cwd,
				runtimeExecutable: bunExecutable(),
				args: [
					...(continuedWithoutThinkingEntry ? ["--import", source] : []),
					"--no-session",
					"--offline",
					"--no-skills",
					"--no-themes",
					"--no-prompt-templates",
					"--no-context-files",
				],
				env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
				interactiveEngine: { onDiagnostic: () => {} },
			});
			client.onExtensionUIRequest((request) => {
				if (request.method === "select") trustPrompt.resolve(request);
			});
			try {
				await client.start();
				const request = await trustPrompt.promise;
				const before = await client.getState();
				assert.equal(before.model?.provider, "unknown");
				assert.equal(before.thinkingLevel, "off");
				await client.respondExtensionUI({
					type: "extension_ui_response",
					id: request.id,
					value: "Trust (this session only)",
				});
				await client.waitForInteractiveEngineResources();
				const after = await client.getState();
				assert.equal(after.model?.provider, "ext-provider");
				assert.equal(after.model?.id, "ext-primary");
				assert.equal(after.thinkingLevel, "medium");
				assert.equal(after.modelFallbackMessage, undefined);
			} finally {
				await client.stop();
				rmSync(root, { recursive: true, force: true });
			}
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

async function startupThinkingRecord(
	trust: "ask" | "always",
	startup: { continued: boolean; savedThinkingLevel?: ThinkingLevel; args?: string[] },
): Promise<{ thinkingLevel: string | undefined; latestThinkingEntry: string | undefined }> {
	const { root, cwd, agentDir, source } = await createStartupFallbackFixture(trust, startup.savedThinkingLevel);
	const trustPrompt = Promise.withResolvers<RpcExtensionUIRequest>();
	const client = new RpcClient({
		cliPath,
		cwd,
		runtimeExecutable: bunExecutable(),
		args: [
			...(trust === "always" ? ["--approve"] : []),
			...(startup.continued ? ["--import", source] : []),
			"--no-session",
			"--offline",
			"--no-skills",
			"--no-themes",
			"--no-prompt-templates",
			"--no-context-files",
			...(startup.args ?? []),
		],
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
		...(trust === "ask" ? { interactiveEngine: { onDiagnostic: () => {} } } : {}),
	});
	client.onExtensionUIRequest((request) => {
		if (request.method === "select") trustPrompt.resolve(request);
	});
	try {
		await client.start();
		if (trust === "ask") {
			const request = await trustPrompt.promise;
			await client.respondExtensionUI({
				type: "extension_ui_response",
				id: request.id,
				value: "Trust (this session only)",
			});
			await client.waitForInteractiveEngineResources();
		}
		const state = await client.getState();
		const thinkingEntries = [];
		let cursor: string | undefined;
		do {
			const page = await client.getHistoryPage({ cursor });
			for (const item of page.items)
				if ("entry" in item && item.entry.type === "thinking_level_change") thinkingEntries.push(item.entry);
			cursor = page.nextCursor;
		} while (cursor);
		return {
			thinkingLevel: state.thinkingLevel,
			latestThinkingEntry: thinkingEntries.at(-1)?.thinkingLevel,
		};
	} finally {
		await client.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

for (const [name, startup, expected] of [
	[
		"a continued conversation's saved level under --thinking",
		{ continued: true, savedThinkingLevel: "low", args: ["--thinking", "high"] },
		{ thinkingLevel: "high", latestThinkingEntry: "low" },
	],
	[
		"a continued conversation without a saved level",
		{ continued: true },
		{ thinkingLevel: "medium", latestThinkingEntry: "medium" },
	],
	["an empty session", { continued: false }, { thinkingLevel: "medium", latestThinkingEntry: "medium" }],
] as const) {
	test(
		`startup trust records the thinking level eager startup records for ${name}`,
		async () => {
			const eager = await startupThinkingRecord("always", startup);
			assert.deepEqual(eager, expected);
			assert.deepEqual(await startupThinkingRecord("ask", startup), eager);
		},
		REAL_STARTUP_RPC_TIMEOUT_MS * 2,
	);
}
