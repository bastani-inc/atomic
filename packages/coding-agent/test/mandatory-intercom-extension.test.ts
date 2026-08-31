import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { getMandatoryBuiltinPackagePaths } from "../src/core/builtin-packages.ts";
import { withMandatoryResourceLoader } from "../src/core/mandatory-resource-loader.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("mandatory bundled Intercom extension", () => {
	let tempDir = "";

	afterEach(() => {
		delete process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL;
		delete process.env.ATOMIC_INTERCOM_HEAVY_IMPORTED;
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads Intercom despite extension discovery and package filters while keeping heavy state lazy", async () => {
		tempDir = join(tmpdir(), `ic-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mandatoryPaths = getMandatoryBuiltinPackagePaths();
		expect(mandatoryPaths).toHaveLength(1);
		process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL = "1";

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			resourceLoaderOptions: {
				builtinPackagePaths: mandatoryPaths.map((source) => ({ source, autoload: false, extensions: [] })),
				noExtensions: true,
			},
		});

		const extensions = services.resourceLoader.getExtensions().extensions;
		expect(extensions).toHaveLength(1);
		expect(extensions[0]?.sourceInfo.configurationOrigin).toBe("bundled");
		expect(process.env.ATOMIC_INTERCOM_HEAVY_IMPORTED).toBeUndefined();
		expect([...extensions[0]!.tools.keys()]).toContain("intercom");
	});

	it("reuses the bundled Intercom instance loaded by DefaultResourceLoader", async () => {
		tempDir = join(tmpdir(), `ic-owner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			builtinPackagePaths: getMandatoryBuiltinPackagePaths(),
		});
		await loader.reload();
		const loaded = loader.getExtensions().extensions;
		expect(loaded).toHaveLength(1);

		const wrapped = await withMandatoryResourceLoader(loader, tempDir);
		expect(wrapped.getExtensions().extensions).toEqual([loaded[0]]);
		expect(wrapped.getExtensions().extensions[0]?.sourceInfo.configurationOrigin).toBe("bundled");
	});
});
