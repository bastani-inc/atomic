import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disables built-in MCP despite settings, explicit paths, and inherited resources", async () => {
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));
		const loaded: string[] = [];
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			disabledBuiltinExtensions: ["mcp"],
			additionalExtensionPaths: ["builtin:mcp"],
			extensionFactories: [
				{ name: "mcp", builtin: true, factory: () => void loaded.push("builtin:mcp") },
				{
					name: "replacement",
					factory: (pi) => {
						loaded.push("replacement");
						pi.registerCommand("mcp", { description: "Replacement MCP", handler: async () => {} });
					},
				},
			],
		});
		await loader.reload();
		expect(loaded).toEqual(["replacement"]);
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions.some((extension) => extension.path === "builtin:mcp")).toBe(false);
		const child = new DefaultResourceLoader({
			cwd,
			agentDir,
			resourceLoaderInheritanceSnapshot: loader.getInheritanceSnapshot(),
		});
		await child.reload();
		expect(loaded).toEqual(["replacement", "replacement"]);
		expect(child.getExtensions().extensions.some((extension) => extension.path === "builtin:mcp")).toBe(false);
	});

	it("disables the shipped MCP package entry through trust discovery, reload and inheritance", async () => {
		const mcp = getBuiltinPackageLocations(true).find((location) => location.distDirName === "mcp")!;
		const entry = join(mcp.packageDir, "index.ts");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			builtinPackagePaths: [mcp.packageDir],
			additionalExtensionPaths: [entry],
			disabledBuiltinExtensions: ["mcp"],
			extensionFactories: [
				{
					name: "replacement",
					factory: (pi) => {
						pi.registerCommand("mcp", { description: "Replacement MCP", handler: async () => {} });
					},
				},
			],
		});
		const safe = await loader.loadProjectTrustExtensions();
		expect(safe.errors).toEqual([]);
		expect(safe.extensions.map((extension) => extension.resolvedPath)).not.toContain(entry);
		for (let attempt = 0; attempt < 2; attempt++) {
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions.map((extension) => extension.resolvedPath)).not.toContain(entry);
			expect(loader.getExtensions().extensions.some((extension) => extension.commands.has("mcp"))).toBe(true);
		}
		const child = new DefaultResourceLoader({
			cwd,
			agentDir,
			resourceLoaderInheritanceSnapshot: loader.getInheritanceSnapshot(),
		});
		await child.reload();
		expect(child.getExtensions().extensions.map((extension) => extension.resolvedPath)).not.toContain(entry);
		expect(child.getExtensions().extensions.some((extension) => extension.commands.has("mcp"))).toBe(true);
	});

	describe("extension conflict detection", () => {
		it("should detect tool conflicts between extensions", async () => {
			// Create two extensions that register the same tool
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts"))).toBe(true);
		});
		it("should prefer explicit CLI extensions over discovered extensions when commands and tools conflict", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			const explicitExtPath = join(tempDir, "explicit-extension.ts");

			writeFileSync(
				join(globalExtDir, "global.ts"),
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  pi.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
			);

			writeFileSync(
				explicitExtPath,
				`
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  pi.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: [explicitExtPath],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions[0]?.path).toBe(explicitExtPath);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
			const modelRegistry = await createModelRegistry(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
			expect(runner.getCommand("deploy:2")?.description).toBe("global command");
			expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
		});
	});
});
