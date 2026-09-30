import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildGroups, ResourceList } from "../src/modes/interactive/components/config-selector-list.js";

test("builtin extension paths remain synthetic and explicit loading overrides no-extensions", async () => {
	const root = mkdtempSync(join(tmpdir(), "builtin-resource-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			additionalExtensionPaths: ["builtin:fixture"],
			extensionFactories: [
				{
					name: "fixture",
					builtin: true,
					factory: (pi) => pi.registerCommand("fixture", { handler: async () => {} }),
				},
			],
		});
		await loader.reload();
		const result = loader.getExtensions();
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.equal(result.extensions[0].path, "builtin:fixture");
		assert.equal(result.extensions[0].resolvedPath, "builtin:fixture");
		assert.equal(result.extensions[0].sourceInfo.source, "builtin");
		assert.equal(result.extensions[0].hidden, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("trusted project builtin settings override global exclusions only after trust resolves", async () => {
	const root = mkdtempSync(join(tmpdir(), "builtin-trust-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	mkdirSync(join(root, ".atomic"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:fixture"] }));
	writeFileSync(join(root, ".atomic/settings.json"), JSON.stringify({ extensions: ["+builtin:fixture"] }));
	let loads = 0;
	try {
		const factories = [
			{
				name: "fixture",
				builtin: true,
				factory: () => {
					loads++;
				},
			},
		];
		const loader = new DefaultResourceLoader({ cwd: root, agentDir, extensionFactories: factories });
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				assert.equal(loads, 0);
				assert.equal(
					extensionsResult.extensions.some((extension) => extension.path === "builtin:fixture"),
					false,
				);
				return true;
			},
		});
		assert.equal(loads, 1);
		assert.equal(loader.getExtensions().extensions[0].sourceInfo.scope, "project");
		const disabled = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			noExtensions: true,
			extensionFactories: factories,
		});
		await disabled.reload();
		assert.equal(loads, 1);
		assert.deepEqual(disabled.getExtensions().extensions, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("replacing an opt-in builtin reports the owner and Atomic recovery command", async () => {
	const root = mkdtempSync(join(tmpdir(), "builtin-replacement-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [
				{
					name: "fixture",
					builtin: true,
					replaceable: true,
					factory: (pi) => pi.registerCommand("fixture", { handler: async () => {} }),
				},
				{ name: "replacement", factory: (pi) => pi.registerCommand("fixture", { handler: async () => {} }) },
			],
		});
		await loader.reload();
		const result = loader.getExtensions();
		assert.deepEqual(
			result.extensions.map((extension) => extension.path),
			["<inline:replacement>"],
		);
		assert.deepEqual(result.errors, []);
		assert.equal(result.warnings?.length, 1);
		assert.equal(result.warnings?.[0].path, "builtin:fixture");
		assert.match(result.warnings?.[0].warning ?? "", /<inline:replacement>.*command.*\/fixture.*atomic config/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config lists builtin names and writes portable global and project toggles", async () => {
	const settings = SettingsManager.inMemory();
	const manager = new DefaultPackageManager({
		cwd: "/project",
		agentDir: "/agent",
		settingsManager: settings,
		builtinExtensions: ["fixture"],
	});
	const resolved = await manager.resolve();
	const groups = buildGroups(resolved, "/agent");
	assert.equal(groups[0].label, "Built-in extensions");
	assert.equal(groups[0].subgroups[0].items[0].displayName, "builtin:fixture");
	const list = new ResourceList(groups, settings, "/project", "/agent");
	list.handleInput("fixture");
	list.handleInput(" ");
	assert.deepEqual(settings.getGlobalSettings().extensions, ["-builtin:fixture"]);
	list.setWriteScope("project");
	list.handleInput(" ");
	assert.deepEqual(settings.getProjectSettings().extensions, ["+builtin:fixture"]);
	const reloaded = await manager.resolve();
	assert.equal(reloaded.extensions[0].path, "builtin:fixture");
	assert.equal(reloaded.extensions[0].enabled, true);
	assert.equal(reloaded.extensions[0].metadata.scope, "project");
});
