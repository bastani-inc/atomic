import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string;
let agentDir: string;
let projectDir: string;
let globalPath: string;
let projectPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-settings-types-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".atomic"), { recursive: true });
	globalPath = join(agentDir, "settings.json");
	projectPath = join(projectDir, ".atomic", "settings.json");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: object): void {
	writeFileSync(path, JSON.stringify(value));
}

type ListGetter = (manager: SettingsManager) => readonly unknown[];

const LIST_SETTINGS: Record<string, ListGetter> = {
	fallbackModels: (manager) => manager.getFallbackModels(),
	packages: (manager) => manager.getPackages(),
	extensions: (manager) => manager.getExtensionPaths(),
	skills: (manager) => manager.getSkillPaths(),
	prompts: (manager) => manager.getPromptTemplatePaths(),
	themes: (manager) => manager.getThemePaths(),
};

/** Skills accepts a legacy `{ customDirectories }` object, so its wrong-typed object is a bad legacy shape. */
const WRONG_VALUES: Record<string, (key: string) => object | string | number> = {
	string: () => "./x",
	object: (key) => (key === "skills" ? { customDirectories: "./skills" } : { path: "./x" }),
	number: () => 7,
};

describe("settings type validation (#4902)", () => {
	for (const [key, read] of Object.entries(LIST_SETTINGS)) {
		for (const [kind, wrongValue] of Object.entries(WRONG_VALUES)) {
			test(`a ${kind} ${key} reads as unset and is reported naming the file and key (#4902)`, () => {
				writeJson(globalPath, { [key]: wrongValue(key), theme: "dark" });

				const manager = SettingsManager.create(projectDir, agentDir);

				assert.deepEqual(read(manager), []);
				assert.equal(manager.getTheme(), "dark", "the valid settings beside it still apply");
				const errors = manager.drainErrors();
				assert.equal(errors.length, 1, JSON.stringify(errors.map(({ error }) => error.message)));
				assert.equal(errors[0]?.scope, "global");
				assert.equal(errors[0]?.path, globalPath);
				assert.match(errors[0]?.error.message ?? "", new RegExp(`"${key}`));
			});
		}
	}

	test("a wrong-typed project value falls back to the global value (#4902)", () => {
		writeJson(globalPath, { extensions: ["./global.ts"] });
		writeJson(projectPath, { extensions: "./project.ts" });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.getExtensionPaths(), ["./global.ts"]);
		const errors = manager.drainErrors();
		assert.deepEqual(
			errors.map(({ scope, path }) => ({ scope, path })),
			[{ scope: "project", path: projectPath }],
		);
	});

	test("a wrong-typed object setting reads as its default (#4902)", () => {
		writeJson(globalPath, { compaction: "off" });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.equal(manager.getCompactionEnabled(), true);
		const errors = manager.drainErrors();
		assert.deepEqual(
			errors.map(({ path, error }) => ({ path, message: error.message })),
			[{ path: globalPath, message: '"compaction" must be object, not string; ignoring it.' }],
		);
	});

	test("wrong-typed list entries are dropped and the valid entries kept (#4902)", () => {
		writeJson(globalPath, {
			fallbackModels: ["openai/gpt-4o", 4, "anthropic/claude-sonnet-4-5"],
			packages: ["npm:a", null, { source: "npm:b" }],
		});

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.getGlobalSettings().fallbackModels, ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
		assert.deepEqual(manager.getPackages(), ["npm:a", { source: "npm:b" }]);
		assert.deepEqual(
			manager.drainErrors().map(({ path, error, invalidKey }) => ({ path, invalidKey, message: error.message })),
			[
				{
					path: globalPath,
					invalidKey: "fallbackModels[1]",
					message: '"fallbackModels[1]" must be string, not number; ignoring it.',
				},
				{
					path: globalPath,
					invalidKey: "packages[1]",
					message: '"packages[1]" must be string or object, not null; ignoring it.',
				},
			],
		);
	});

	test("the diagnostic names every type a setting accepts and the type it found (#4902)", () => {
		writeJson(globalPath, { skills: 3, transport: 5, extensions: null, theme: "dark" });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.equal(manager.getTransport(), "auto");
		assert.deepEqual(
			manager.drainErrors().map(({ error }) => error.message),
			[
				'"transport" must be string, not number; ignoring it.',
				'"extensions" must be array of string, not null; ignoring it.',
				'"skills" must be array of string or object, not number; ignoring it.',
			],
		);
	});

	test("settings that reject a wrong type themselves keep failing closed (#4902)", () => {
		writeJson(globalPath, {
			decisionModel: 7,
			compactionModel: 7,
			storage: "memory",
			sessions: 1,
			snapshots: 1,
			httpIdleTimeoutMs: true,
			websocketConnectTimeoutMs: true,
			streamDeadlineMs: true,
		});

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.drainErrors(), []);
		assert.throws(() => manager.getHttpIdleTimeoutMs(), /Invalid httpIdleTimeoutMs setting/);
		assert.equal(manager.getGlobalSettings().streamDeadlineMs, true);
	});

	test("a setting limited to a list of words accepts those words and drops other types (#4902)", () => {
		writeJson(globalPath, { defaultThinkingLevel: "high" });
		writeJson(projectPath, { defaultThinkingLevel: 3 });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.equal(manager.getDefaultThinkingLevel(), "high");
		assert.deepEqual(
			manager.drainErrors().map(({ scope, error }) => ({ scope, message: error.message })),
			[{ scope: "project", message: '"defaultThinkingLevel" must be string, not number; ignoring it.' }],
		);
	});

	test("a right-typed word outside the allowed values is not a type error (#4902)", () => {
		writeJson(globalPath, { transport: "pigeon" });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.drainErrors(), []);
		assert.equal(manager.getGlobalSettings().transport, "pigeon");
	});

	test("the legacy skills object keeps migrating when its fields have the right types (#4902)", () => {
		writeJson(globalPath, { skills: { enableSkillCommands: false, customDirectories: ["./legacy-skills"] } });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.drainErrors(), []);
		assert.deepEqual(manager.getSkillPaths(), ["./legacy-skills"]);
		assert.equal(manager.getEnableSkillCommands(), false);
	});

	test("fields inside a current object setting are left to the feature that reads them (#4902)", () => {
		writeJson(globalPath, { storage: { path: 5 } });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.drainErrors(), []);
		assert.deepEqual(manager.getGlobalSettings().storage, { path: 5 });
	});

	test("a wrong-typed value in a legacy .pi settings file names that file (#4902)", () => {
		const legacyProjectPath = join(projectDir, ".pi", "settings.json");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeJson(legacyProjectPath, { prompts: "./prompts" });
		writeJson(projectPath, { theme: "dark" });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(
			manager.drainErrors().map(({ scope, path }) => ({ scope, path })),
			[{ scope: "project", path: legacyProjectPath }],
		);
	});

	test("in-memory settings report a wrong-typed value without a file (#4902)", () => {
		const manager = SettingsManager.inMemory({ themes: "./themes" } as object);

		assert.deepEqual(manager.getThemePaths(), []);
		assert.deepEqual(
			manager.drainErrors().map(({ scope, path, invalidKey }) => ({ scope, path, invalidKey })),
			[{ scope: "global", path: undefined, invalidKey: "themes" }],
		);
	});

	test("a right-typed value outside its allowed values is left for its accessor (#4902)", () => {
		writeJson(globalPath, { httpIdleTimeoutMs: "soon" });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.drainErrors(), []);
		assert.throws(() => manager.getHttpIdleTimeoutMs(), /Invalid httpIdleTimeoutMs setting/);
	});

	test("reloading an unchanged wrong-typed file does not report it again (#4902)", async () => {
		writeJson(globalPath, { fallbackModels: "openai/gpt-4o" });
		const manager = SettingsManager.create(projectDir, agentDir);
		assert.equal(manager.drainErrors().length, 1);

		await manager.reload();

		assert.deepEqual(manager.drainErrors(), []);
		assert.deepEqual(manager.getFallbackModels(), []);
	});

	test("a reload reports a wrong-typed value that is new, in the scope that holds it (#4902)", async () => {
		writeJson(globalPath, { fallbackModels: "openai/gpt-4o" });
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.drainErrors();
		writeJson(globalPath, { fallbackModels: "openai/gpt-4o", skills: 1 });
		writeJson(projectPath, { prompts: 2 });

		await manager.reload();

		assert.deepEqual(
			manager.drainErrors().map(({ scope, path, invalidKey }) => ({ scope, path, invalidKey })),
			[
				{ scope: "global", path: globalPath, invalidKey: "skills" },
				{ scope: "project", path: projectPath, invalidKey: "prompts" },
			],
		);
	});

	test("trusting a project reports its wrong-typed values as project settings (#4902)", () => {
		writeJson(projectPath, { extensions: "./x.ts" });
		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
		assert.deepEqual(manager.drainErrors(), []);

		manager.setProjectTrusted(true);

		assert.deepEqual(
			manager.drainErrors().map(({ scope, path, invalidKey }) => ({ scope, path, invalidKey })),
			[{ scope: "project", path: projectPath, invalidKey: "extensions" }],
		);
	});

	test("list accessors ignore wrong-typed override values instead of throwing or spreading strings (#4902)", () => {
		const manager = SettingsManager.inMemory();
		const overrides: Record<string, object | string | number> = {
			fallbackModels: "openai/gpt-4o",
			packages: 3,
			extensions: "./x.ts",
			skills: "./skills",
			prompts: { path: "./p" },
			themes: 5,
		};
		manager.applyOverrides(overrides);

		for (const [key, read] of Object.entries(LIST_SETTINGS)) {
			assert.deepEqual(read(manager), [], key);
		}
	});

	test("getPackages keeps only string sources and objects with a string source (#4902)", () => {
		const manager = SettingsManager.inMemory();
		manager.applyOverrides({ packages: ["npm:a", 3, null, { source: 4 }, { source: "npm:b" }] } as object);

		assert.deepEqual(manager.getPackages(), ["npm:a", { source: "npm:b" }]);
	});

	test("list accessors keep only the string entries of a mixed array (#4902)", () => {
		const manager = SettingsManager.inMemory();
		const mixed = ["./a", 4, { path: "./b" }, "./c"];
		manager.applyOverrides({ extensions: mixed, skills: mixed, prompts: mixed, themes: mixed } as object);

		assert.deepEqual(manager.getExtensionPaths(), ["./a", "./c"]);
		assert.deepEqual(manager.getSkillPaths(), ["./a", "./c"]);
		assert.deepEqual(manager.getPromptTemplatePaths(), ["./a", "./c"]);
		assert.deepEqual(manager.getThemePaths(), ["./a", "./c"]);
	});
});
