import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { test, vi } from "vitest";
import { ENV_AGENT_DIR, getAgentConfigPaths, getProjectConfigPaths } from "../src/config.js";
import { runMigrations } from "../src/migrations.js";
import { migrateAzureProvider } from "../src/migrations-azure.js";

const legacy = "azure-openai-responses";

test("startup migrates Azure config files atomically without replacing canonical entries or sessions", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-migration-"));
	const previous = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = join(root, "agent");
	try {
		const cwd = join(root, "project");
		const files = new Map<string, string>();
		const configs = {
			"auth.json": { [legacy]: { type: "api_key", key: "old" }, azure: { type: "api_key", key: "canonical" } },
			"settings.json": {
				defaultProvider: legacy,
				enabledModels: [`${legacy}/*:high`],
				fallbackModels: [`${legacy}/gpt-5.4:low`],
				routerModel: `${legacy}/gpt-5.4`,
				modelThinkingLevels: { [`${legacy}/gpt-5.4`]: "low", "azure/gpt-5.4": "high" },
				modelRouting: { allowedProviders: [legacy], excludedProviders: [legacy] },
				compaction: { modelOverrides: { [`${legacy}/gpt-5.4`]: { maxTokens: 1024 } } },
			},
			"models.json": {
				providers: { [legacy]: { api: legacy, baseUrl: "old" }, azure: { api: legacy, baseUrl: "canonical" } },
			},
		};
		for (const [filename, config] of Object.entries(configs)) {
			for (const path of [...getAgentConfigPaths(filename), ...getProjectConfigPaths(cwd, filename)]) {
				mkdirSync(join(path, ".."), { recursive: true });
				const content = `${JSON.stringify(config, null, 2)}\n`;
				writeFileSync(path, content);
				chmodSync(path, filename === "auth.json" ? 0o600 : 0o640);
				files.set(path, content);
			}
		}
		const session = join(process.env[ENV_AGENT_DIR]!, "sessions", "session.jsonl");
		mkdirSync(join(session, ".."), { recursive: true });
		writeFileSync(session, JSON.stringify({ type: "model_change", provider: legacy, modelId: "gpt-5.4" }));
		const savedSession = readFileSync(session, "utf-8");
		runMigrations(cwd, { projectTrusted: false });
		for (const [path, original] of files) {
			if (
				getProjectConfigPaths(
					cwd,
					path.endsWith("auth.json")
						? "auth.json"
						: path.endsWith("settings.json")
							? "settings.json"
							: "models.json",
				).includes(path)
			) {
				assert.equal(readFileSync(path, "utf-8"), original);
			}
		}
		migrateAzureProvider(cwd, { projectTrusted: true });
		for (const path of files.keys()) {
			const content = readFileSync(path, "utf-8");
			const parsed = JSON.parse(content);
			if (path.endsWith("auth.json")) {
				assert.deepEqual(parsed, { azure: { type: "api_key", key: "canonical" } });
			} else if (path.endsWith("models.json")) {
				assert.deepEqual(parsed, { providers: { azure: { api: legacy, baseUrl: "canonical" } } });
			} else {
				assert.equal(parsed.defaultProvider, "azure");
				assert.deepEqual(parsed.enabledModels, ["azure/*:high"]);
				assert.deepEqual(parsed.fallbackModels, ["azure/gpt-5.4:low"]);
				assert.equal(parsed.routerModel, "azure/gpt-5.4");
				assert.deepEqual(parsed.modelThinkingLevels, { "azure/gpt-5.4": "high" });
				assert.deepEqual(parsed.modelRouting, { allowedProviders: ["azure"], excludedProviders: ["azure"] });
				assert.deepEqual(parsed.compaction.modelOverrides, { "azure/gpt-5.4": { maxTokens: 1024 } });
			}
			if (process.platform !== "win32")
				assert.equal(statSync(path).mode & 0o777, path.endsWith("auth.json") ? 0o600 : 0o640);
			files.set(path, content);
		}
		migrateAzureProvider(cwd, { projectTrusted: true });
		for (const [path, content] of files) assert.equal(readFileSync(path, "utf-8"), content);
		assert.equal(readFileSync(session, "utf-8"), savedSession);
	} finally {
		if (previous === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("migration preserves legacy-only Azure credentials and models across both global config layers", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-layered-"));
	vi.stubEnv("HOME", root);
	vi.stubEnv("USERPROFILE", root);
	vi.stubEnv("HOMEDRIVE", undefined);
	vi.stubEnv("HOMEPATH", undefined);
	vi.stubEnv(ENV_AGENT_DIR, undefined);
	vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
	try {
		const auth = { [legacy]: { type: "api_key", key: "legacy-key" } };
		const provider = {
			api: legacy,
			baseUrl: "https://example.test",
			modelOverrides: { "gpt-5.4": { contextWindow: 32768 } },
		};
		const snapshots = new Map<string, string>();
		assert.equal(getAgentConfigPaths("auth.json").length, 2);
		for (const filename of ["auth.json", "settings.json", "models.json"]) {
			for (const path of getAgentConfigPaths(filename)) {
				mkdirSync(join(path, ".."), { recursive: true });
				const config =
					filename === "auth.json"
						? auth
						: filename === "models.json"
							? { providers: { [legacy]: provider } }
							: { defaultProvider: legacy };
				writeFileSync(
					path,
					`${filename === "models.json" ? "// configuration values\n" : ""}${JSON.stringify(config)}`,
				);
			}
		}
		migrateAzureProvider(join(root, "project"), { projectTrusted: false });
		for (const filename of ["auth.json", "settings.json", "models.json"]) {
			for (const path of getAgentConfigPaths(filename)) {
				const content = readFileSync(path, "utf-8");
				const expected =
					filename === "auth.json"
						? { azure: auth[legacy] }
						: filename === "models.json"
							? { providers: { azure: provider } }
							: { defaultProvider: "azure" };
				assert.deepEqual(JSON.parse(content), expected);
				snapshots.set(path, content);
			}
		}
		migrateAzureProvider(join(root, "project"), { projectTrusted: false });
		for (const [path, content] of snapshots) assert.equal(readFileSync(path, "utf-8"), content);
	} finally {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

test("migration leaves malformed config and locked files untouched", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-azure-locked-"));
	vi.stubEnv(ENV_AGENT_DIR, root);
	try {
		const path = join(root, "auth.json");
		const content = JSON.stringify({ [legacy]: { type: "api_key", key: "old" } });
		writeFileSync(path, content);
		writeFileSync(join(root, "models.json"), "null");
		writeFileSync(join(root, "settings.json"), "[]");
		const release = lockfile.lockSync(path, { realpath: false });
		try {
			migrateAzureProvider(root, { projectTrusted: false });
			assert.equal(readFileSync(path, "utf-8"), content);
		} finally {
			release();
		}
		assert.equal(readFileSync(join(root, "models.json"), "utf-8"), "null");
		assert.equal(readFileSync(join(root, "settings.json"), "utf-8"), "[]");
		migrateAzureProvider(root, { projectTrusted: false });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { azure: { type: "api_key", key: "old" } });
	} finally {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
