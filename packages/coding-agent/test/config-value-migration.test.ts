import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { runMigrations } from "../src/migrations.ts";

describe("config value env var syntax migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-config-value-migration-test-"));
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

	it("rewrites legacy uppercase auth.json API key values in legacy .pi agent config when the env var exists", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-legacy-pi-config-value-migration-test-"));
		tempDirs.push(homeDir);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
		delete process.env[ENV_AGENT_DIR];
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		process.env.ANTHROPIC_API_KEY = "secret";
		try {
			const legacyAgentDir = path.join(homeDir, ".pi", "agent");
			fs.mkdirSync(legacyAgentDir, { recursive: true });
			fs.writeFileSync(
				path.join(legacyAgentDir, "auth.json"),
				`${JSON.stringify({ anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" } }, null, 2)}\n`,
				"utf-8",
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			runMigrations(homeDir);

			const migrated = JSON.parse(fs.readFileSync(path.join(legacyAgentDir, "auth.json"), "utf-8")) as Record<
				string,
				Record<string, unknown>
			>;
			expect(migrated.anthropic.key).toBe("$ANTHROPIC_API_KEY");
			const logMessage = String(logSpy.mock.calls[0]?.[0] ?? "");
			expect(logMessage).toContain('auth.json["anthropic"].key: ANTHROPIC_API_KEY -> $ANTHROPIC_API_KEY');
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			if (previousUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = previousUserProfile;
			}
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
			if (previousAnthropicKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
			}
		}
	});

	it("rewrites legacy uppercase auth.json API key values to explicit env references when the env var exists", () => {
		const agentDir = createAgentDir();
		const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "secret";
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
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			withAgentDir(agentDir, () => runMigrations(agentDir));

			const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
				string,
				Record<string, unknown>
			>;
			expect(migrated.anthropic.key).toBe("$ANTHROPIC_API_KEY");
			expect(migrated.openai.key).toBe("$OPENAI_API_KEY");
			expect(migrated.opencode.key).toBe("public");
			expect(migrated.github.access).toBe("ACCESS_TOKEN");
			const logMessage = String(logSpy.mock.calls[0]?.[0] ?? "");
			expect(logMessage).toContain("explicit $ENV_VAR syntax");
			expect(logMessage).toContain('auth.json["anthropic"].key: ANTHROPIC_API_KEY -> $ANTHROPIC_API_KEY');
		} finally {
			if (previousAnthropicKey === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
			}
		}
	});

	it.each([
		["malformed", '{\n  "providers": {\n'],
		["blank", ""],
	])("does not throw on %s models.json during config migration", (_name, content) => {
		const agentDir = createAgentDir();
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(modelsPath, content, "utf-8");

		withAgentDir(agentDir, () => expect(() => runMigrations(agentDir)).not.toThrow());

		expect(fs.readFileSync(modelsPath, "utf-8")).toBe(content);
		const registry = ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), modelsPath);
		const loadError = registry.getError();
		expect(loadError).toContain("Failed to parse models.json");
		expect(loadError).toContain(`File: ${modelsPath}`);
	});

	it("rewrites legacy uppercase models.json API key and header values when env vars exist", () => {
		const agentDir = createAgentDir();
		const envVarNames = ["CUSTOM_API_KEY", "HEADER_API_KEY", "MODEL_API_KEY", "OVERRIDE_API_KEY"];
		const previousEnv = new Map(envVarNames.map((name) => [name, process.env[name]]));
		for (const name of envVarNames) {
			process.env[name] = "secret";
		}
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

		try {
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
			const logMessage = String(logSpy.mock.calls[0]?.[0] ?? "");
			expect(logMessage).toContain(
				'models.json.providers["custom-provider"].apiKey: CUSTOM_API_KEY -> $CUSTOM_API_KEY',
			);
			expect(logMessage).toContain(
				'models.json.providers["custom-provider"].headers["x-api-key"]: HEADER_API_KEY -> $HEADER_API_KEY',
			);
			expect(logMessage).toContain(
				'models.json.providers["custom-provider"].models["model-a"].headers["x-model-key"]: MODEL_API_KEY -> $MODEL_API_KEY',
			);
			expect(logMessage).toContain(
				'models.json.providers["custom-provider"].modelOverrides["model-b"].headers["x-override-key"]: OVERRIDE_API_KEY -> $OVERRIDE_API_KEY',
			);
		} finally {
			for (const [name, value] of previousEnv) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	});

	it("preserves models.json comments and formatting while migrating env references", () => {
		const agentDir = createAgentDir();
		const envVarNames = ["CUSTOM_API_KEY", "HEADER_API_KEY"];
		const previousEnv = new Map(envVarNames.map((name) => [name, process.env[name]]));
		for (const name of envVarNames) {
			process.env[name] = "secret";
		}
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(
			modelsPath,
			`{
  // keep provider notes
  "providers": {
    "CUSTOM_API_KEY": {
      "metadata": {
        "apiKey": "CUSTOM_API_KEY",
        "headers": {
          "x-api-key": "HEADER_API_KEY",
        },
      },
      "baseUrl": "https://example.com/v1",
      "apiKey": "CUSTOM_API_KEY", // migrate this value, not the key
      "api": "openai-completions",
      "headers": {
        "x-api-key": "HEADER_API_KEY",
      },
      "models": [
        {
          "id": "CUSTOM_API_KEY",
          "name": "CUSTOM_API_KEY",
        },
      ],
    },
  },
}
`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			withAgentDir(agentDir, () => runMigrations(agentDir));

			const migrated = fs.readFileSync(modelsPath, "utf-8");
			expect(migrated).toContain("// keep provider notes");
			expect(migrated).toContain('"CUSTOM_API_KEY": {');
			expect(migrated).toContain('"metadata": {\n        "apiKey": "CUSTOM_API_KEY"');
			expect(migrated).toContain('"metadata": {\n        "apiKey": "CUSTOM_API_KEY",\n        "headers": {\n          "x-api-key": "HEADER_API_KEY"');
			expect(migrated).toContain('"apiKey": "$CUSTOM_API_KEY", // migrate this value, not the key');
			expect(migrated).toContain('"x-api-key": "$HEADER_API_KEY",');
			expect(migrated).toContain('"id": "CUSTOM_API_KEY"');
			expect(migrated).toContain('"name": "CUSTOM_API_KEY"');
			expect(migrated).toContain('      },\n      "models": [');
			expect(logSpy).toHaveBeenCalled();
		} finally {
			for (const [name, value] of previousEnv) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	});

	it("preserves uppercase literal credentials when no matching env var exists", () => {
		const agentDir = createAgentDir();
		const literalCredential = "AKIAIOSFODNN7EXAMPLE";
		const previousLiteralEnv = process.env[literalCredential];
		delete process.env[literalCredential];
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify({ aws: { type: "api_key", key: literalCredential } }, null, 2)}\n`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			withAgentDir(agentDir, () => runMigrations(agentDir));

			const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
				string,
				Record<string, unknown>
			>;
			expect(migrated.aws.key).toBe(literalCredential);
			expect(logSpy).not.toHaveBeenCalled();
		} finally {
			if (previousLiteralEnv === undefined) {
				delete process.env[literalCredential];
			} else {
				process.env[literalCredential] = previousLiteralEnv;
			}
		}
	});
});
