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
			[{ path: globalPath, message: '"compaction" must be object; ignoring it.' }],
		);
	});

	test("wrong-typed list entries are dropped and the valid entries kept (#4902)", () => {
		writeJson(globalPath, { fallbackModels: ["openai/gpt-4o", 4, "anthropic/claude-sonnet-4-5"] });

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(manager.getFallbackModels(), ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
		const errors = manager.drainErrors();
		assert.deepEqual(
			errors.map(({ path, error }) => ({ path, message: error.message })),
			[{ path: globalPath, message: '"fallbackModels[1]" must be string; ignoring it.' }],
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
