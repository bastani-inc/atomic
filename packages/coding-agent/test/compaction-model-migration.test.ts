import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { migrateCompactionModelSettings, resolveCompactionModel } from "../src/core/compaction/model-resolver.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;
const CHAT = "anthropic/claude-sonnet-4-5";
const CLASSIFIER = "openai-decisions/gpt-6-luna";
const COMPACTOR = "morph/morph-compactor";
const UNKNOWN = "acme/not-registered";

const REMOVED_COMPACTION_KEYS = {
	enabled: true,
	reserveTokens: 20_000,
	compression_ratio: 0.3,
	preserve_recent: 4,
	keepContextShare: 0.4,
	query: "focus",
	planningTimeoutMs: "5m",
	modelOverrides: { [CHAT]: { reserveTokens: 1, preserve_recent: 1 } },
	background: true,
	backgroundThresholdPercent: 70,
	historyRecall: false,
};

describe("compaction settings after the clear-and-recover change", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-compaction-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(tempDir, ".atomic"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSettings(global: object, project: object = {}): void {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
		writeFileSync(join(tempDir, ".atomic", "settings.json"), JSON.stringify(project));
	}

	function savedCompactionModel(scope: "global" | "project"): string | undefined {
		const path = scope === "global" ? join(agentDir, "settings.json") : join(tempDir, ".atomic", "settings.json");
		return (JSON.parse(readFileSync(path, "utf8")) as { compactionModel?: string }).compactionModel;
	}

	async function openSession(extensionFactories: ExtensionFactory[] = [], projectTrusted?: boolean) {
		const settingsManager = SettingsManager.create(
			tempDir,
			agentDir,
			projectTrusted === undefined ? {} : { projectTrusted },
		);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager, extensionFactories });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			authStorage,
			resourceLoader,
			builtins: NO_BUILTINS,
		});
		await settingsManager.flush();
		return { session, settingsManager, resourceLoader };
	}

	it("settings holding every removed compaction key load without an error", async () => {
		writeSettings({ compaction: REMOVED_COMPACTION_KEYS });
		const settings = SettingsManager.create(tempDir, agentDir);
		assert.deepEqual(settings.drainErrors(), []);
		assert.deepEqual(settings.getCompactionSettings(), { enabled: true, reserveTokens: 20_000 });
	});

	for (const [kind, value] of [
		["chat", CHAT],
		["classifier", CLASSIFIER],
	] as const) {
		it(`a saved ${kind} compactionModel is reset to auto in both scopes and persisted`, async () => {
			writeSettings({ compactionModel: value }, { compactionModel: value });
			const { session, settingsManager } = await openSession();
			try {
				assert.equal(savedCompactionModel("global"), "auto");
				assert.equal(savedCompactionModel("project"), "auto");
				assert.equal(settingsManager.getCompactionModel(), "auto");
				assert.deepEqual(settingsManager.drainErrors(), []);
				session.agent.streamFunction = async () => {
					throw new Error("compaction called a model");
				};
				await session.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
				session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
				const result = await session.compact();
				assert.equal(result.form, "cleared");
				assert.equal(result.fallbackReason, undefined);
			} finally {
				session.dispose();
			}
		});
	}

	it("a saved compactor selection and an unknown id are left unchanged", async () => {
		writeSettings({ compactionModel: COMPACTOR }, { compactionModel: UNKNOWN });
		const { session } = await openSession();
		try {
			assert.equal(savedCompactionModel("global"), COMPACTOR);
			assert.equal(savedCompactionModel("project"), UNKNOWN);
		} finally {
			session.dispose();
		}
	});

	/** An extension that registers one chat model under the `review-custom` provider. */
	function customProvider(id: string): ExtensionFactory {
		return (atomic) => {
			atomic.registerProvider("review-custom", {
				baseUrl: "http://127.0.0.1:9/v1",
				apiKey: "review-custom-key",
				api: "openai-completions",
				models: [
					{
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4_096,
					},
				],
			});
		};
	}

	it("a saved chat model that an extension registers is reset to auto once the extension has loaded", async () => {
		writeSettings({ compactionModel: "review-custom/chat" });
		const { session, settingsManager } = await openSession([customProvider("chat")]);
		try {
			await settingsManager.flush();
			assert.equal(settingsManager.getCompactionModel(), "auto");
			assert.equal(savedCompactionModel("global"), "auto");
		} finally {
			session.dispose();
		}
	});

	it("a project selection is migrated once the project is trusted", async () => {
		writeSettings({}, { compactionModel: CHAT });
		const settingsManager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });
		const models = [{ ...getModel("anthropic", "claude-sonnet-4-5")! }] as Parameters<
			typeof migrateCompactionModelSettings
		>[1];
		assert.deepEqual(migrateCompactionModelSettings(settingsManager, models), []);

		settingsManager.setProjectTrusted(true);
		assert.deepEqual(migrateCompactionModelSettings(settingsManager, models), [{ scope: "project", from: CHAT }]);
		await settingsManager.flush();
		assert.equal(savedCompactionModel("project"), "auto");
	});

	it("a project selection is migrated when startup completes after the project is trusted", async () => {
		writeSettings({}, { compactionModel: CHAT });
		const { session, settingsManager, resourceLoader } = await openSession([], false);
		try {
			assert.equal(savedCompactionModel("project"), CHAT);

			settingsManager.setProjectTrusted(true);
			await session.completeStartupResources(resourceLoader);
			await settingsManager.flush();

			assert.equal(savedCompactionModel("project"), "auto");
		} finally {
			session.dispose();
		}
	});

	it("the migration is idempotent and leaves an untrusted project alone", () => {
		const writes: Array<[string, string | undefined]> = [];
		const state = { global: CHAT, project: CLASSIFIER };
		const settings = {
			getGlobalSettings: () => ({ compactionModel: state.global }),
			getProjectSettings: () => ({ compactionModel: state.project }),
			isProjectTrusted: () => false,
			setCompactionModel: (model: string, scope?: "global" | "project") => {
				writes.push([model, scope]);
				if (scope === "project") state.project = model;
				else state.global = model;
			},
		};
		const models = [{ ...getModel("anthropic", "claude-sonnet-4-5")! }] as Parameters<
			typeof migrateCompactionModelSettings
		>[1];
		assert.deepEqual(migrateCompactionModelSettings(settings, models), [{ scope: "global", from: CHAT }]);
		assert.deepEqual(migrateCompactionModelSettings(settings, models), []);
		assert.deepEqual(writes, [["auto", "global"]]);
		assert.equal(state.project, CLASSIFIER);
	});

	it("a value that cannot be persisted still resolves to auto at compaction time", () => {
		const models = [{ ...getModel("anthropic", "claude-sonnet-4-5")! }] as Parameters<
			typeof resolveCompactionModel
		>[1];
		assert.deepEqual(resolveCompactionModel(CHAT, models), {
			kind: "auto",
			ignored: { configured: CHAT, reason: "chat" },
		});
		assert.deepEqual(resolveCompactionModel("", models), { kind: "auto" });
		assert.deepEqual(resolveCompactionModel(" auto ", models), { kind: "auto" });
		assert.deepEqual(resolveCompactionModel(UNKNOWN, models), {
			kind: "auto",
			ignored: { configured: UNKNOWN, reason: "unknown" },
		});
	});
});
