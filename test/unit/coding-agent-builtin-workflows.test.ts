/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "vitest";
import { INSTALLED_EXTENSION_ENTRIES } from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { getBuiltinPackagePaths } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

const expectedBuiltinPackages = [
	resolve("packages/subagents"),
	resolve("packages/mcp"),
	resolve("packages/web-access"),
	resolve("packages/intercom"),
];

const builtinPackageFixtures = [
	{ packageName: "@bastani/subagents", dirname: "subagents", requiredEntry: join("src", "extension", "index.ts") },
	{ packageName: "@bastani/mcp", dirname: "mcp", requiredEntry: "index.ts" },
	{ packageName: "@bastani/web-access", dirname: "web-access", requiredEntry: "index.ts" },
	{ packageName: "@bastani/intercom", dirname: "intercom", requiredEntry: "index.ts" },
] as const;

const REAL_BUILTIN_RESOURCE_LOADER_TIMEOUT_MS = 120_000;

describe("coding-agent builtin resources", () => {
	test("discovers bundled companion packages in development without the removed Cursor package", () => {
		assert.deepEqual(getBuiltinPackagePaths(), expectedBuiltinPackages);
		assert.equal(
			getBuiltinPackagePaths().some((packagePath) => packagePath.endsWith("/cursor")),
			false,
		);
	});

	test("discovers shipped binary adjacent builtin packages", () => {
		const packageDir = tempDir("atomic-binary-package-dir-");
		const previousPackageDir = process.env.ATOMIC_PACKAGE_DIR;
		try {
			for (const fixture of builtinPackageFixtures) {
				const builtinDir = join(packageDir, "builtin", fixture.dirname);
				const entryPath = join(builtinDir, fixture.requiredEntry);
				mkdirSync(dirname(entryPath), { recursive: true });
				writeFileSync(join(builtinDir, "package.json"), JSON.stringify({ name: fixture.packageName }), "utf-8");
				writeFileSync(entryPath, "export default function register() {}\n", "utf-8");
			}
			process.env.ATOMIC_PACKAGE_DIR = packageDir;

			assert.deepEqual(
				getBuiltinPackagePaths(),
				builtinPackageFixtures.map((fixture) => join(packageDir, "builtin", fixture.dirname)),
			);
		} finally {
			if (previousPackageDir === undefined) delete process.env.ATOMIC_PACKAGE_DIR;
			else process.env.ATOMIC_PACKAGE_DIR = previousPackageDir;
		}
	});

	test("discovers shipped builtin packages from prebundled extension entries", () => {
		const packageDir = tempDir("atomic-binary-bundled-package-dir-");
		const previousPackageDir = process.env.ATOMIC_PACKAGE_DIR;
		try {
			for (const fixture of builtinPackageFixtures) {
				const builtinDir = join(packageDir, "builtin", fixture.dirname);
				const entryPath = join(builtinDir, INSTALLED_EXTENSION_ENTRIES[fixture.dirname]);
				mkdirSync(dirname(entryPath), { recursive: true });
				writeFileSync(join(builtinDir, "package.json"), JSON.stringify({ name: fixture.packageName }), "utf-8");
				writeFileSync(entryPath, "export default function register() {}\n", "utf-8");
			}
			process.env.ATOMIC_PACKAGE_DIR = packageDir;

			assert.deepEqual(
				getBuiltinPackagePaths(),
				builtinPackageFixtures.map((fixture) => join(packageDir, "builtin", fixture.dirname)),
			);
		} finally {
			if (previousPackageDir === undefined) delete process.env.ATOMIC_PACKAGE_DIR;
			else process.env.ATOMIC_PACKAGE_DIR = previousPackageDir;
		}
	});

	test(
		"loads builtin pi package resources",
		async () => {
			const cwd = tempDir("atomic-builtin-packages-cwd-");
			const agentDir = tempDir("atomic-builtin-packages-agent-");
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				builtinPackagePaths: expectedBuiltinPackages,
			});

			await loader.reload();

			const extensions = loader.getExtensions();
			assert.deepEqual(extensions.errors, []);

			const extensionPaths = extensions.extensions.map((extension) => extension.path.replace(/\\/g, "/"));
			for (const suffix of [
				"packages/subagents/src/extension/index.ts",
				"packages/mcp/index.ts",
				"packages/web-access/index.ts",
				"packages/intercom/index.ts",
			]) {
				assert.ok(
					extensionPaths.some((extensionPath) => extensionPath.endsWith(suffix)),
					`expected builtin extension path ending in ${suffix}`,
				);
			}

			const skillNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
			for (const skillName of ["subagent", "intercom", "feedback"]) {
				assert.ok(skillNames.has(skillName), `expected builtin skill ${skillName}`);
			}
			assert.ok(
				!loader.getPrompts().prompts.some((prompt) => prompt.name === "feedback"),
				"feedback should only be available as a skill, not a bundled prompt",
			);
		},
		REAL_BUILTIN_RESOURCE_LOADER_TIMEOUT_MS,
	);

	test(
		"ships the bundled skills without loading workflow tooling",
		async () => {
			const cwd = tempDir("atomic-stage-builtin-skills-cwd-");
			const agentDir = tempDir("atomic-stage-builtin-skills-agent-");
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				builtinPackagePaths: expectedBuiltinPackages,
			});

			await loader.reload();

			const extensions = loader.getExtensions();
			assert.deepEqual(extensions.errors, []);
			const extensionPaths = extensions.extensions.map((extension) => extension.path.replace(/\\/g, "/"));
			assert.equal(
				extensionPaths.some((extensionPath) => extensionPath.endsWith("packages/workflows/src/extension/index.ts")),
				false,
				"expected stage sessions not to recursively load the workflows extension",
			);
			assert.ok(
				extensionPaths.some((extensionPath) => extensionPath.endsWith("packages/subagents/src/extension/index.ts")),
				"expected non-workflow builtin extensions to stay enabled",
			);

			const skillNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
			for (const skillName of [
				"bro",
				"create-spec",
				"feedback",
				"how",
				"impeccable",
				"intercom",
				"liteparse",
				"agent-browser",
				"prompt-engineer",
				"qlty",
				"research-codebase",
				"show-me",
				"skill-creator",
				"subagent",
				"tdd",
				"teach",
				"tmux",
				"unslop",
				"why",
			]) {
				assert.ok(skillNames.has(skillName), `expected bundled package skill ${skillName}`);
			}
			assert.equal(
				skillNames.has("effective-liteparse"),
				false,
				"expected the renamed liteparse skill not to reappear under its obsolete name",
			);
		},
		REAL_BUILTIN_RESOURCE_LOADER_TIMEOUT_MS,
	);
});
