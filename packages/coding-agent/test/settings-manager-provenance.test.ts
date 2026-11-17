import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { SettingsScope, SettingsStorage } from "../src/core/settings-manager.js";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.js";

// Regression coverage for #2299: writes must preserve layered field provenance.
describe("SettingsManager layered settings provenance", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let primaryGlobalPath: string;
	let legacyGlobalPath: string;
	let primaryProjectPath: string;
	let legacyProjectPath: string;

	function writeJson(path: string, value: object): string {
		mkdirSync(dirname(path), { recursive: true });
		const bytes = `${JSON.stringify(value, null, 2)}\n`;
		writeFileSync(path, bytes);
		return bytes;
	}

	function readJson(path: string): Record<string, unknown> {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	}

	function createManager(): SettingsManager {
		const storage = new FileSettingsStorage(projectDir, agentDir, {
			globalReadPaths: [primaryGlobalPath, legacyGlobalPath],
			projectReadPaths: [primaryProjectPath, legacyProjectPath],
		});
		return SettingsManager.fromStorage(storage);
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-2299-settings-"));
		agentDir = join(root, ".atomic", "agent");
		projectDir = join(root, "project");
		primaryGlobalPath = join(agentDir, "settings.json");
		legacyGlobalPath = join(root, ".pi", "agent", "settings.json");
		primaryProjectPath = join(projectDir, ".atomic", "settings.json");
		legacyProjectPath = join(projectDir, ".pi", "settings.json");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("does not materialize legacy-only global fields into an absent primary file (#2299)", async () => {
		const legacyBytes = writeJson(legacyGlobalPath, {
			packages: ["npm:legacy-package"],
			extensions: ["./legacy-extension.ts"],
		});
		const manager = createManager();

		assert.deepEqual(manager.getPackages(), ["npm:legacy-package"]);
		assert.equal(manager.isFieldInherited("global", "packages"), true);

		manager.setTheme("dark");
		await manager.flush();

		assert.deepEqual(readJson(primaryGlobalPath), { theme: "dark" });
		assert.equal(readFileSync(legacyGlobalPath, "utf8"), legacyBytes);

		await manager.reload();
		assert.deepEqual(manager.getPackages(), ["npm:legacy-package"]);
		assert.equal(manager.isFieldInherited("global", "packages"), true);
	});

	it("writes only a modified nested field over an empty primary file (#2299)", async () => {
		const legacyBytes = writeJson(legacyGlobalPath, {
			packages: ["npm:legacy-package"],
			compaction: { enabled: true, reserveTokens: 8192 },
		});
		writeJson(primaryGlobalPath, {});
		const manager = createManager();

		manager.setCompactionEnabled(false);
		await manager.flush();

		assert.deepEqual(readJson(primaryGlobalPath), { compaction: { enabled: false } });
		assert.equal(readFileSync(legacyGlobalPath, "utf8"), legacyBytes);

		await manager.reload();
		assert.equal(manager.getCompactionSettings().enabled, false);
		assert.equal(manager.getCompactionSettings().reserveTokens, 8192);
		assert.equal(manager.isFieldInherited("global", "packages"), true);
	});

	describe.each(["global", "project"] as const)("%s primary overrides", (scope) => {
		it.each([
			{ label: "a non-empty list", packages: ["npm:primary-package"] as string[] },
			{ label: "an explicit empty list", packages: [] as string[] },
		])("preserves primary packages when they are $label (#2299)", async ({ packages }) => {
			const primaryPath = scope === "global" ? primaryGlobalPath : primaryProjectPath;
			const legacyPath = scope === "global" ? legacyGlobalPath : legacyProjectPath;
			const legacyBytes = writeJson(legacyPath, { packages: ["npm:legacy-package"] });
			writeJson(primaryPath, { packages });
			const manager = createManager();

			if (scope === "global") manager.setExtensionPaths(["./atomic-extension.ts"]);
			else manager.setProjectExtensionPaths(["./atomic-extension.ts"]);
			await manager.flush();

			assert.deepEqual(manager.drainErrors(), []);
			assert.deepEqual(readJson(primaryPath), { packages, extensions: ["./atomic-extension.ts"] });
			assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes);
			await manager.reload();
			assert.equal(manager.isFieldInherited(scope, "packages"), false);
			assert.deepEqual(scope === "global" ? manager.getPackages() : manager.getProjectSettings().packages, packages);
		});
	});

	it.each([
		{ label: "absent", createPrimary: false },
		{ label: "empty", createPrimary: true },
	])(
		"does not materialize legacy-only project fields into an $label primary file (#2299)",
		async ({ createPrimary }) => {
			const legacyBytes = writeJson(legacyProjectPath, {
				packages: ["npm:legacy-project-package"],
				prompts: ["./legacy-prompt.md"],
			});
			if (createPrimary) writeJson(primaryProjectPath, {});
			const manager = createManager();

			manager.setProjectExtensionPaths(["./atomic-extension.ts"]);
			await manager.flush();

			assert.deepEqual(readJson(primaryProjectPath), { extensions: ["./atomic-extension.ts"] });
			assert.equal(readFileSync(legacyProjectPath, "utf8"), legacyBytes);

			await manager.reload();
			assert.deepEqual(manager.getProjectSettings().packages, ["npm:legacy-project-package"]);
			assert.equal(manager.isFieldInherited("project", "packages"), true);
		},
	);

	it("preserves external edits and concurrent scoped writes without copying legacy fields (#2299)", async () => {
		writeJson(legacyGlobalPath, { packages: ["npm:legacy-package"] });
		writeJson(primaryGlobalPath, { theme: "dark" });
		const firstManager = createManager();
		const secondManager = createManager();

		writeJson(primaryGlobalPath, {
			theme: "external",
			enabledModels: ["anthropic/claude-sonnet"],
		});
		firstManager.setDefaultThinkingLevel("high");
		secondManager.setTheme("light");
		await Promise.all([firstManager.flush(), secondManager.flush()]);

		assert.deepEqual(readJson(primaryGlobalPath), {
			theme: "light",
			enabledModels: ["anthropic/claude-sonnet"],
			defaultThinkingLevel: "high",
		});
	});

	it("preserves project edits made after the manager loaded (#2299)", async () => {
		const legacyBytes = writeJson(legacyProjectPath, { packages: ["npm:legacy-project-package"] });
		const manager = createManager();
		writeJson(primaryProjectPath, { prompts: ["./external-prompt.md"] });

		manager.setProjectExtensionPaths(["./atomic-extension.ts"]);
		await manager.flush();

		assert.deepEqual(manager.drainErrors(), []);
		assert.deepEqual(readJson(primaryProjectPath), {
			prompts: ["./external-prompt.md"],
			extensions: ["./atomic-extension.ts"],
		});
		assert.equal(readFileSync(legacyProjectPath, "utf8"), legacyBytes);
		await manager.reload();
		assert.equal(manager.isFieldInherited("project", "packages"), true);
	});

	it("preserves newer primary nested fields without promoting fallback siblings (#2299)", async () => {
		writeJson(legacyGlobalPath, { compaction: { enabled: true, reserveTokens: 8192, preserve_recent: 4 } });
		const manager = createManager();
		writeJson(primaryGlobalPath, { compaction: { reserveTokens: 16384 } });

		manager.setCompactionEnabled(false);
		await manager.flush();

		assert.deepEqual(manager.drainErrors(), []);
		assert.deepEqual(readJson(primaryGlobalPath), { compaction: { enabled: false, reserveTokens: 16384 } });
		await manager.reload();
		const compaction = manager.getCompactionSettings();
		assert.equal(compaction.enabled, false);
		assert.equal(compaction.reserveTokens, 16384);
		// A removed key read from the fallback file still merges as a sibling; nothing reads it any more.
		assert.equal((manager.getSettings().compaction as { preserve_recent?: number }).preserve_recent, 4);
	});

	it("keeps alternate SettingsStorage implementations source-compatible (#2299)", async () => {
		const values: Record<SettingsScope, string | undefined> = {
			global: JSON.stringify({ packages: ["npm:custom-storage"] }),
			project: undefined,
		};
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				const next = fn(values[scope]);
				if (next !== undefined) values[scope] = next;
			},
		};
		const manager = SettingsManager.fromStorage(storage);

		manager.setTheme("dark");
		await manager.flush();

		assert.deepEqual(JSON.parse(values.global ?? "{}"), {
			packages: ["npm:custom-storage"],
			theme: "dark",
		});
	});
});
