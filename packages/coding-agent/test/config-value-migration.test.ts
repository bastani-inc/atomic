import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { runMigrations } from "../src/migrations.ts";

import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("config value env var syntax migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-value-migration-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	}

	function withEnv(name: string, value: string | undefined, fn: () => void): void {
		const previous = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		try {
			fn();
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	}

	function writeAuthFixture(agentDir: string): void {
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify(
				{
					anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" },
					openai: { type: "api_key", key: "$OPENAI_API_KEY" },
					opencode: { type: "api_key", key: "public" },
					github: { type: "oauth", access: "ACCESS_TOKEN", refresh: "REFRESH_TOKEN", expires: 1 },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
	}

	it("rewrites an implicit auth.json environment reference when that variable exists", () => {
		const agentDir = createAgentDir();
		writeAuthFixture(agentDir);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		withEnv("ANTHROPIC_API_KEY", "secret", () => withAgentDir(agentDir, () => runMigrations(agentDir)));

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(migrated.anthropic.key).toBe("$ANTHROPIC_API_KEY");
		expect(migrated.openai.key).toBe("$OPENAI_API_KEY");
		expect(migrated.opencode.key).toBe("public");
		expect(migrated.github.access).toBe("ACCESS_TOKEN");
		expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
			'auth.json["anthropic"].key: ANTHROPIC_API_KEY -> $ANTHROPIC_API_KEY',
		);
	});

	it("preserves an uppercase auth.json literal when no matching variable exists", () => {
		const agentDir = createAgentDir();
		writeAuthFixture(agentDir);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		withEnv("ANTHROPIC_API_KEY", undefined, () => withAgentDir(agentDir, () => runMigrations(agentDir)));

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(migrated.anthropic.key).toBe("ANTHROPIC_API_KEY");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("migrates implicit auth references in the legacy .pi agent directory", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-legacy-pi-config-migration-test-"));
		tempDirs.push(homeDir);
		const legacyAgentDir = path.join(homeDir, ".pi", "agent");
		fs.mkdirSync(legacyAgentDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyAgentDir, "auth.json"),
			`${JSON.stringify({ anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" } }, null, 2)}\n`,
			"utf-8",
		);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		delete process.env[ENV_AGENT_DIR];
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		try {
			withEnv("ANTHROPIC_API_KEY", "secret", () => runMigrations(homeDir));
			const migrated = JSON.parse(fs.readFileSync(path.join(legacyAgentDir, "auth.json"), "utf-8")) as Record<
				string,
				Record<string, unknown>
			>;
			expect(migrated.anthropic.key).toBe("$ANTHROPIC_API_KEY");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	});

	it("preserves models.json comments and formatting while migrating environment references", () => {
		const agentDir = createAgentDir();
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(
			modelsPath,
			`{
  // keep provider notes
  "providers": {
    "CUSTOM_API_KEY": {
      "metadata": {
        "apiKey": "CUSTOM_API_KEY",
        "headers": { "x-api-key": "HEADER_API_KEY" },
      },
      "baseUrl": "https://example.com/v1",
      "apiKey": "CUSTOM_API_KEY", // migrate this value, not the key
      "api": "openai-completions",
      "headers": { "x-api-key": "HEADER_API_KEY" },
      "models": [{ "id": "CUSTOM_API_KEY", "name": "CUSTOM_API_KEY" }],
    },
  },
}\n`,
			"utf-8",
		);

		withEnv("CUSTOM_API_KEY", "secret", () =>
			withEnv("HEADER_API_KEY", "secret", () => withAgentDir(agentDir, () => runMigrations(agentDir))),
		);

		const migrated = fs.readFileSync(modelsPath, "utf-8");
		expect(migrated).toContain("// keep provider notes");
		expect(migrated).toContain('"CUSTOM_API_KEY": {');
		expect(migrated).toContain('"metadata": {\n        "apiKey": "CUSTOM_API_KEY"');
		expect(migrated).toContain('"apiKey": "$CUSTOM_API_KEY", // migrate this value, not the key');
		expect(migrated).toContain('"x-api-key": "$HEADER_API_KEY"');
		expect(migrated).toContain('"id": "CUSTOM_API_KEY"');
		expect(migrated).toContain('"name": "CUSTOM_API_KEY"');
	});

	it.each([
		["malformed", '{\n  "providers": {\n'],
		["blank", ""],
	])("does not throw on %s models.json during migrations", async (_name, content) => {
		const agentDir = createAgentDir();
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(modelsPath, content, "utf-8");

		withAgentDir(agentDir, () => expect(() => runMigrations(agentDir)).not.toThrow());

		expect(fs.readFileSync(modelsPath, "utf-8")).toBe(content);
		const registry = await createModelRegistry(AuthStorage.create(path.join(agentDir, "auth.json")), modelsPath);
		const loadError = registry.getError();
		expect(loadError).toContain("Failed to parse models.json");
		expect(loadError).toContain(`File: ${modelsPath}`);
	});

	it("migrates implicit models.json environment references to explicit dollar syntax", async () => {
		const agentDir = createAgentDir();
		const envKeys = ["CUSTOM_API_KEY", "HEADER_API_KEY", "MODEL_API_KEY", "OVERRIDE_API_KEY"];
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			process.env[key] = `env-${key}`;
		}

		try {
			fs.writeFileSync(
				path.join(agentDir, "models.json"),
				`${JSON.stringify(
					{
						providers: {
							"custom-provider": {
								baseUrl: "https://example.com/v1",
								apiKey: "CUSTOM_API_KEY",
								api: "openai-completions",
								headers: {
									"x-api-key": "HEADER_API_KEY",
									"x-literal": "literal",
								},
								models: [
									{
										id: "model-a",
										headers: { "x-model-key": "MODEL_API_KEY" },
									},
								],
								modelOverrides: {
									"model-b": { headers: { "x-override-key": "OVERRIDE_API_KEY" } },
								},
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			withAgentDir(agentDir, () => runMigrations(agentDir));

			const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")) as {
				providers: Record<
					string,
					{
						apiKey?: string;
						headers?: Record<string, string>;
						models?: Array<{ headers?: Record<string, string> }>;
						modelOverrides?: Record<string, { headers?: Record<string, string> }>;
					}
				>;
			};
			const provider = migrated.providers["custom-provider"]!;
			expect(provider.apiKey).toBe("$CUSTOM_API_KEY");
			expect(provider.headers?.["x-api-key"]).toBe("$HEADER_API_KEY");
			expect(provider.headers?.["x-literal"]).toBe("literal");
			expect(provider.models?.[0]?.headers?.["x-model-key"]).toBe("$MODEL_API_KEY");
			expect(provider.modelOverrides?.["model-b"]?.headers?.["x-override-key"]).toBe("$OVERRIDE_API_KEY");
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Migrated API key/header environment references"));

			const registry = await createModelRegistry(
				AuthStorage.create(path.join(agentDir, "auth.json")),
				path.join(agentDir, "models.json"),
			);
			const model = registry.find("custom-provider", "model-a");
			expect(model).toBeDefined();
			expect(await registry.getApiKeyForProvider("custom-provider")).toBe("env-CUSTOM_API_KEY");
			expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
				ok: true,
				apiKey: "env-CUSTOM_API_KEY",
				headers: {
					"x-api-key": "env-HEADER_API_KEY",
					"x-literal": "literal",
					"x-model-key": "env-MODEL_API_KEY",
				},
			});
		} finally {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = savedEnv[key];
				}
			}
		}
	});
});
