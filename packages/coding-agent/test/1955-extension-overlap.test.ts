import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../src/config.ts";
import { buildExtensionResourcePaths } from "../src/core/agent-session-extension-bindings.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { collectFlags, collectRegisteredTools, resolveRegisteredCommands } from "../src/core/extensions/runner-registries.ts";
import { resolveExtensionShortcuts } from "../src/core/extensions/runner-shortcuts.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader-types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionActions, ExtensionRuntime, RpcSessionState } from "../src/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const ENV_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ATOMIC_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const;
const originalEnv = new Map<string, string | undefined>();
let root: string;
let home: string;
let cwd: string;
let legacySettingsPath: string;
let legacySettingsBytes: string;
let legacyPackageFiles: Array<{ path: string; bytes: string }>;
let bundledPackage: string;

function writeExtensionPackage(directory: string, label: string): void {
	mkdirSync(join(directory, "extensions"), { recursive: true });
	mkdirSync(join(directory, "prompts"), { recursive: true });
	mkdirSync(join(directory, "discovered"), { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({
		name: `@example/${label}`,
		pi: { extensions: ["./extensions/index.ts"], prompts: ["./prompts"] },
	}, null, 2));
	writeFileSync(join(directory, "extensions", "index.ts"), `
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
export default function(pi) {
  pi.registerTool({ name: "shared-tool", description: "${label} tool", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
  pi.registerCommand("shared-command", { description: "${label} command", handler: async () => {} });
  pi.registerFlag("shared-flag", { description: "${label} flag", type: "string", default: "${label}" });
  pi.registerShortcut("ctrl+shift+u", { description: "${label} shortcut", handler: async () => {} });
  ${label === "bundled" ? `
  pi.registerTool({ name: "dynamic-shared-tool", description: "bundled dynamic winner", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
  pi.registerCommand("dynamic-shared-command", { description: "bundled dynamic winner", handler: async () => {} });
  pi.registerFlag("dynamic-shared-flag", { description: "bundled dynamic winner", type: "string", default: "bundled-dynamic" });
  pi.registerShortcut("ctrl+shift+d", { description: "bundled dynamic winner", handler: async () => {} });
  ` : ""}
  ${label === "legacy" ? `
  pi.registerTool({ name: "legacy-only-tool", description: "legacy only", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
  pi.registerCommand("legacy-only-command", { description: "legacy only", handler: async () => {} });
  pi.registerFlag("legacy-only-flag", { description: "legacy only", type: "boolean", default: true });
  pi.registerShortcut("ctrl+shift+l", { description: "legacy only", handler: async () => {} });
  pi.on("session_start", async () => {
    pi.registerTool({ name: "dynamic-shared-tool", description: "legacy dynamic loser", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
    pi.registerCommand("dynamic-shared-command", { description: "legacy dynamic loser", handler: async () => {} });
    pi.registerFlag("dynamic-shared-flag", { description: "legacy dynamic loser", type: "string", default: "legacy-dynamic" });
    pi.registerShortcut("ctrl+shift+d", { description: "legacy dynamic loser", handler: async () => {} });
  });
  pi.on("resources_discover", () => ({
    promptPaths: [fileURLToPath(new URL("../discovered/discovered-shared-prompt.md", import.meta.url))],
  }));
  ` : ""}
  pi.on("session_start", async () => {
    pi.registerTool({ name: "late-shared-tool", description: "${label} late tool", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
    pi.registerTool({ name: "late-second-shared-tool", description: "${label} second late tool", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
    pi.registerFlag("late-shared-flag", { type: "string", default: "${label === "legacy" ? "same" : "bundled-late"}" });
    pi.registerFlag("late-no-default-flag", { type: "string", default: "${label === "legacy" ? "legacy-value" : "bundled-value"}" });
    ${label === "legacy" ? `pi.registerCommand("legacy-observed-late-flag", { description: String(pi.getFlag("late-shared-flag")), handler: async () => {} });` : ""}
  });
  pi.on("message_end", async () => {
    pi.registerTool({ name: "message-end-shared-tool", description: "${label} message-end tool", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
  });
}
`);
	writeFileSync(join(directory, "prompts", "shared-prompt.md"), `---\ndescription: ${label} prompt\n---\n${label} prompt body\n`);
	if (label === "bundled") {
		writeFileSync(join(directory, "prompts", "discovered-shared-prompt.md"), "bundled discovered prompt body\n");
	} else {
		writeFileSync(join(directory, "discovered", "discovered-shared-prompt.md"), "legacy discovered prompt body\n");
	}
	if (label === "legacy") {
		writeFileSync(join(directory, "prompts", "legacy-only-prompt.md"), "legacy-only prompt body\n");
	}
}

function setupFixture(): { legacyPackage: string } {
	root = mkdtempSync(join(tmpdir(), "atomic-1955-overlap-"));
	home = join(root, "home");
	cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
	process.env.HOME = home;
	delete process.env.USERPROFILE;
	delete process.env.HOMEDRIVE;
	delete process.env.HOMEPATH;
	delete process.env.ATOMIC_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;

	const legacyPackage = join(root, "legacy-package");
	bundledPackage = join(root, "bundled-package");
	writeExtensionPackage(legacyPackage, "legacy");
	writeExtensionPackage(bundledPackage, "bundled");
	legacyPackageFiles = [
		join(legacyPackage, "package.json"),
		join(legacyPackage, "extensions", "index.ts"),
	].map((path) => ({ path, bytes: readFileSync(path, "utf8") }));
	legacySettingsPath = join(home, ".pi", "agent", "settings.json");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	legacySettingsBytes = `${JSON.stringify({ packages: [legacyPackage] }, null, 2)}\n`;
	writeFileSync(legacySettingsPath, legacySettingsBytes);
	return { legacyPackage };
}

function restoreFixture(): void {
	for (const key of ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	originalEnv.clear();
	if (root) rmSync(root, { recursive: true, force: true });
}

function createLoader(): DefaultResourceLoader {
	return new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), builtinPackagePaths: [bundledPackage] });
}

describe("inherited Pi resource overlap compatibility", () => {
	beforeEach(setupFixture);
	afterEach(restoreFixture);

	it("keeps bundled exact-name registrations and all unrelated inherited resources without mutating Pi settings", async () => {
		const loader = createLoader();
		await loader.reload();

		const result = loader.getExtensions();
		const tools = collectRegisteredTools(result.extensions);
		expect(tools.find((tool) => tool.definition.name === "shared-tool")?.definition.description).toBe("bundled tool");
		expect(tools.some((tool) => tool.definition.name === "legacy-only-tool")).toBe(true);
		const commands = resolveRegisteredCommands(result.extensions);
		expect(commands.find((command) => command.name === "shared-command")?.description).toBe("bundled command");
		expect(commands.some((command) => command.name === "legacy-only-command")).toBe(true);
		expect(collectFlags(result.extensions).get("shared-flag")?.description).toBe("bundled flag");
		expect(collectFlags(result.extensions).has("legacy-only-flag")).toBe(true);
		const shortcuts = resolveExtensionShortcuts(result.extensions, {}, true).shortcuts;
		expect(shortcuts.get("ctrl+shift+u")?.description).toBe("bundled shortcut");
		expect(shortcuts.has("ctrl+shift+l")).toBe(true);
		expect(result.runtime.flagValues.get("shared-flag")).toBe("bundled");

		const prompts = loader.getPrompts();
		expect(prompts.prompts.find((prompt) => prompt.name === "shared-prompt")?.content).toContain("bundled prompt body");
		expect(prompts.prompts.some((prompt) => prompt.name === "legacy-only-prompt")).toBe(true);
		expect(prompts.diagnostics).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(loader.getOverlaps().map((overlap) => overlap.resourceType)).toEqual([
			"tool", "command", "flag", "shortcut", "prompt",
		]);

		const inheritedExtension = result.extensions.find((extension) => extension.sourceInfo.configurationOrigin === "inherited-pi");
		expect(inheritedExtension).toBeDefined();
		const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, {} as never, {} as never);
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(inheritedExtension?.tools.has("dynamic-shared-tool")).toBe(false);
		expect(inheritedExtension?.commands.has("dynamic-shared-command")).toBe(false);
		expect(inheritedExtension?.flags.has("dynamic-shared-flag")).toBe(false);
		expect(inheritedExtension?.shortcuts.has("ctrl+shift+d")).toBe(false);
		expect(loader.getOverlaps().map((overlap) => overlap.name)).toContain("dynamic-shared-tool");
		expect(loader.getOverlaps().map((overlap) => overlap.name)).toContain("dynamic-shared-command");
		expect(loader.getOverlaps().map((overlap) => overlap.name)).toContain("dynamic-shared-flag");
		expect(loader.getOverlaps().map((overlap) => overlap.name)).toContain("ctrl+shift+d");
		expect(readFileSync(legacySettingsPath, "utf8")).toBe(legacySettingsBytes);
		for (const file of legacyPackageFiles) expect(readFileSync(file.path, "utf8")).toBe(file.bytes);

		const firstOverlaps = loader.getOverlaps();
		await loader.reload();
		const reloadedResult = loader.getExtensions();
		const reloadedRunner = new ExtensionRunner(reloadedResult.extensions, reloadedResult.runtime, cwd, {} as never, {} as never);
		await reloadedRunner.emit({ type: "session_start", reason: "reload" });
		expect(loader.getOverlaps()).toEqual(firstOverlaps);
		expect(readFileSync(legacySettingsPath, "utf8")).toBe(legacySettingsBytes);
		for (const file of legacyPackageFiles) expect(readFileSync(file.path, "utf8")).toBe(file.bytes);

		const restartedLoader = createLoader();
		await restartedLoader.reload();
		const restartedResult = restartedLoader.getExtensions();
		const restartedRunner = new ExtensionRunner(restartedResult.extensions, restartedResult.runtime, cwd, {} as never, {} as never);
		await restartedRunner.emit({ type: "session_start", reason: "startup" });
		expect(restartedLoader.getOverlaps()).toEqual(firstOverlaps);
		expect(collectRegisteredTools(restartedResult.extensions).find((tool) => tool.definition.name === "shared-tool")?.definition.description)
			.toBe("bundled tool");
		expect(readFileSync(legacySettingsPath, "utf8")).toBe(legacySettingsBytes);
		for (const file of legacyPackageFiles) expect(readFileSync(file.path, "utf8")).toBe(file.bytes);
	});

	it("keeps inherited late tools inactive until bundled session-start handlers finish", async () => {
		const loader = createLoader();
		await loader.reload();
		const result = loader.getExtensions();
		const inheritedIndex = result.extensions.findIndex((extension) => extension.sourceInfo.configurationOrigin === "inherited-pi");
		const bundledIndex = result.extensions.findIndex((extension) => extension.sourceInfo.configurationOrigin === "bundled");
		expect(inheritedIndex).toBeLessThan(bundledIndex);
		expect(result.extensions.every((extension) => !extension.tools.has("late-shared-tool"))).toBe(true);
		const activeOwners: string[] = [];
		result.runtime.refreshTools = () => {
			const owners = ["late-shared-tool", "late-second-shared-tool"]
				.map((name) => result.extensions.find((extension) => extension.tools.has(name))?.sourceInfo.configurationOrigin);
			activeOwners.push(owners.join("/"));
		};
		const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, {} as never, {} as never);
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(activeOwners.every((owners) => !owners.includes("inherited"))).toBe(true);
		expect(activeOwners.at(-1)).toBe("bundled/bundled");
		const winner = result.extensions.find((extension) => extension.tools.has("late-shared-tool"));
		expect(winner?.sourceInfo.configurationOrigin).toBe("bundled");
		expect(resolveRegisteredCommands(result.extensions).find((command) => command.name === "legacy-observed-late-flag")?.description)
			.toBe("same");
		expect(result.runtime.flagValues.get("late-shared-flag")).toBe("bundled-late");
		expect(result.extensions.find((extension) => extension.flags.has("late-shared-flag"))?.sourceInfo.configurationOrigin)
			.toBe("bundled");
		expect(loader.getOverlaps().some((overlap) => overlap.name === "late-shared-tool")).toBe(true);
	});
	it("keeps inherited tools inactive across specialized event dispatchers", async () => {
		const loader = createLoader();
		await loader.reload();
		const result = loader.getExtensions();
		const activeOwners: string[] = [];
		result.runtime.refreshTools = () => {
			const owner = result.extensions.find((extension) => extension.tools.has("message-end-shared-tool"));
			if (owner?.sourceInfo.configurationOrigin) activeOwners.push(owner.sourceInfo.configurationOrigin);
		};
		const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, {} as never, {} as never);
		await runner.emitMessageEnd({ type: "message_end", message: {} as never });
		expect(activeOwners.length).toBeGreaterThan(0);
		expect(activeOwners.every((owner) => owner === "bundled")).toBe(true);
		const winner = result.extensions.find((extension) => extension.tools.has("message-end-shared-tool"));
		expect(winner?.sourceInfo.configurationOrigin).toBe("bundled");
		expect(loader.getOverlaps().some((overlap) => overlap.name === "message-end-shared-tool")).toBe(true);
	});
	it("preserves inherited provenance for prompts discovered by extensions", async () => {
		const loader = createLoader();
		await loader.reload();
		const inherited = loader.getExtensions().extensions.find((extension) =>
			extension.sourceInfo.configurationOrigin === "inherited-pi");
		expect(inherited).toBeDefined();
		const runner = new ExtensionRunner(
			loader.getExtensions().extensions,
			loader.getExtensions().runtime,
			cwd,
			{} as never,
			{} as never,
		);
		const discovered = await runner.emitResourcesDiscover(cwd, "startup");
		expect(discovered.promptPaths).toHaveLength(1);
		const promptPaths = buildExtensionResourcePaths.call({
			_resourceLoader: loader,
			getExtensionSourceLabel: () => "fallback",
		} as never, discovered.promptPaths);
		expect(promptPaths[0]?.metadata.configurationOrigin).toBe("inherited-pi");
		expect(promptPaths[0]?.metadata.source).toBe(inherited?.sourceInfo.source);

		await loader.extendResources({ promptPaths });
		const prompts = loader.getPrompts();
		expect(prompts.prompts.find((prompt) => prompt.name === "discovered-shared-prompt")?.content)
			.toContain("bundled discovered prompt body");
		expect(prompts.diagnostics).toEqual([]);
		expect(loader.getOverlaps().some((overlap) =>
			overlap.resourceType === "prompt" && overlap.name === "discovered-shared-prompt")).toBe(true);
	});
	it("preserves an explicitly configured Atomic extension override", async () => {
		const atomicExtensionDir = join(home, ".atomic", "agent", "extensions");
		mkdirSync(atomicExtensionDir, { recursive: true });
		writeFileSync(join(atomicExtensionDir, "override.ts"), `
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({ name: "shared-tool", description: "explicit atomic tool", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
  pi.registerFlag("late-shared-flag", { type: "string", default: "same" });
  pi.registerFlag("late-no-default-flag", { type: "string" });
}
`);
		const loader = createLoader();
		await loader.reload();
		const result = loader.getExtensions();
		const tools = collectRegisteredTools(result.extensions);
		expect(tools.find((tool) => tool.definition.name === "shared-tool")?.definition.description).toBe("explicit atomic tool");
		expect(tools.some((tool) => tool.definition.name === "legacy-only-tool")).toBe(true);
		expect(result.runtime.flagValues.get("late-shared-flag")).toBe("same");
		expect(result.runtime.flagValues.has("late-no-default-flag")).toBe(false);
		expect(result.runtime.flagOwnerOrigins?.get("late-no-default-flag")).toBe("atomic");
		const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, {} as never, {} as never);
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(result.runtime.flagValues.get("late-shared-flag")).toBe("same");
		expect(result.runtime.flagValues.has("late-no-default-flag")).toBe(false);
		expect(collectFlags(result.extensions).get("late-shared-flag")?.extensionPath)
			.toBe(join(atomicExtensionDir, "override.ts"));
		expect(collectFlags(result.extensions).get("late-no-default-flag")?.extensionPath)
			.toBe(join(atomicExtensionDir, "override.ts"));
		expect(loader.getOverlaps().some((overlap) => overlap.name === "late-shared-flag")).toBe(true);
		expect(loader.getOverlaps().some((overlap) => overlap.name === "late-no-default-flag")).toBe(true);
	});
	it("preserves immediate non-conflicting dynamic registrations from an explicit Atomic extension", async () => {
		const atomicExtensionDir = join(home, ".atomic", "agent", "extensions");
		mkdirSync(atomicExtensionDir, { recursive: true });
		writeFileSync(legacySettingsPath, "{}\n");
		writeFileSync(join(atomicExtensionDir, "dynamic-explicit.ts"), `
import { Type } from "typebox";
export default function(pi) {
  pi.on("session_start", async () => {
    pi.registerFlag("atomic-only-dynamic", { type: "string", default: "ready" });
    pi.registerTool({ name: "atomic-only-tool", description: "unique", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
    pi.registerCommand("observed-explicit-flag", { description: String(pi.getFlag("atomic-only-dynamic")), handler: async () => {} });
    if (pi.getFlag("atomic-only-dynamic") === "ready") {
      pi.registerTool({ name: "atomic-conditional-tool", description: "conditional", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
    }
  });
}
`);
		const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), builtinPackagePaths: [] });
		await loader.reload();
		const result = loader.getExtensions();
		const commandPresentAtRefresh: boolean[] = [];
		result.runtime.refreshTools = () => {
			const explicit = result.extensions.find((extension) => extension.path.endsWith("dynamic-explicit.ts"));
			commandPresentAtRefresh.push(explicit?.commands.has("observed-explicit-flag") ?? false);
		};
		const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, {} as never, {} as never);
		await runner.emit({ type: "session_start", reason: "startup" });
		const commands = resolveRegisteredCommands(result.extensions);
		expect(commands.find((command) => command.name === "observed-explicit-flag")?.description).toBe("ready");
		expect(collectRegisteredTools(result.extensions).some((tool) => tool.definition.name === "atomic-conditional-tool")).toBe(true);
		expect(commandPresentAtRefresh[0]).toBe(false);
		expect(loader.getOverlaps()).toEqual([]);
	});
	it("keeps a relative package explicitly listed by Atomic explicit when compatibility lookup finds it under Pi", async () => {
		const atomicAgentDir = join(home, ".atomic", "agent");
		const compatibilityPackage = join(home, ".pi", "agent", "compat-package");
		mkdirSync(atomicAgentDir, { recursive: true });
		mkdirSync(join(compatibilityPackage, "extensions"), { recursive: true });
		writeFileSync(join(compatibilityPackage, "package.json"), JSON.stringify({
			name: "example-atomic-compatibility",
			pi: { extensions: ["./extensions/index.ts"] },
		}, null, 2));
		writeFileSync(join(compatibilityPackage, "extensions", "index.ts"), `
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({ name: "shared-tool", description: "explicit Atomic compatibility package", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
  pi.registerTool({ name: "atomic-package-only", description: "unrelated", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
}
`);
		writeFileSync(join(atomicAgentDir, "settings.json"), `${JSON.stringify({ packages: ["./compat-package"] }, null, 2)}\n`);
		const loader = createLoader();
		await loader.reload();
		const explicit = loader.getExtensions().extensions.find((extension) => extension.path.startsWith(compatibilityPackage));
		expect(explicit?.sourceInfo.configurationOrigin).toBe("atomic");
		const tools = collectRegisteredTools(loader.getExtensions().extensions);
		expect(tools.find((tool) => tool.definition.name === "shared-tool")?.definition.description)
			.toBe("explicit Atomic compatibility package");
		expect(tools.some((tool) => tool.definition.name === "atomic-package-only")).toBe(true);
	});
	it("keeps same-relative Atomic extensions explicit when inherited settings also resolve under Pi", async () => {
		const atomicExtensionDir = join(home, ".atomic", "agent", "extensions");
		const piExtensionDir = join(home, ".pi", "agent", "extensions");
		mkdirSync(atomicExtensionDir, { recursive: true });
		mkdirSync(piExtensionDir, { recursive: true });
		const extensionSource = (description: string) => `
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({ name: "shared-tool", description: "${description}", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
}
`;
		writeFileSync(join(atomicExtensionDir, "relative.ts"), extensionSource("explicit atomic relative tool"));
		writeFileSync(join(piExtensionDir, "relative.ts"), extensionSource("inherited pi relative tool"));
		writeFileSync(legacySettingsPath, `${JSON.stringify({
			packages: [join(root, "legacy-package")],
			extensions: ["extensions/relative.ts"],
		}, null, 2)}\n`);

		const loader = createLoader();
		await loader.reload();
		const relativeExtensions = loader.getExtensions().extensions.filter((extension) => extension.path.endsWith("relative.ts"));
		expect(relativeExtensions.map((extension) => extension.sourceInfo.configurationOrigin)).toEqual(["atomic", "inherited-pi"]);
		const winner = collectRegisteredTools(loader.getExtensions().extensions)
			.find((tool) => tool.definition.name === "shared-tool");
		expect(winner?.definition.description).toBe("explicit atomic relative tool");
	});

	it("keeps a relative extension explicitly listed by Atomic explicit when compatibility lookup finds it under Pi", async () => {
		const piExtensionDir = join(home, ".pi", "agent", "extensions");
		const atomicAgentDir = join(home, ".atomic", "agent");
		mkdirSync(piExtensionDir, { recursive: true });
		mkdirSync(atomicAgentDir, { recursive: true });
		writeFileSync(join(piExtensionDir, "atomic-listed.ts"), `
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({ name: "shared-tool", description: "explicit Atomic compatibility tool", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
  pi.registerTool({ name: "atomic-listed-only", description: "unrelated", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
}
`);
		writeFileSync(join(atomicAgentDir, "settings.json"), `${JSON.stringify({
			extensions: ["extensions/atomic-listed.ts"],
		}, null, 2)}\n`);

		const loader = createLoader();
		await loader.reload();
		const explicit = loader.getExtensions().extensions.find((extension) => extension.path.endsWith("atomic-listed.ts"));
		expect(explicit?.sourceInfo.configurationOrigin).toBe("atomic");
		const tools = collectRegisteredTools(loader.getExtensions().extensions);
		expect(tools.find((tool) => tool.definition.name === "shared-tool")?.definition.description)
			.toBe("explicit Atomic compatibility tool");
		expect(tools.some((tool) => tool.definition.name === "atomic-listed-only")).toBe(true);
	});
	it("keeps absolute paths from inherited settings classified as inherited", async () => {
		const inheritedExtensionPath = join(root, "absolute-inherited.ts");
		writeFileSync(inheritedExtensionPath, `
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({ name: "shared-tool", description: "absolute inherited tool", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
}
`);
		writeFileSync(legacySettingsPath, `${JSON.stringify({
			packages: [join(root, "legacy-package")],
			extensions: [inheritedExtensionPath],
		}, null, 2)}\n`);

		const loader = createLoader();
		await loader.reload();
		const inherited = loader.getExtensions().extensions.find((extension) => extension.path === inheritedExtensionPath);
		expect(inherited?.sourceInfo.configurationOrigin).toBe("inherited-pi");
		const winner = collectRegisteredTools(loader.getExtensions().extensions)
			.find((tool) => tool.definition.name === "shared-tool");
		expect(winner?.definition.description).toBe("bundled tool");
	});

	it("treats marked Atomic inline extensions as bundled collision owners", async () => {
		const inheritedPath = join(home, ".pi", "agent", "extensions", "inline-overlap.ts");
		mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
		writeFileSync(inheritedPath, `
export default function(pi) {
  pi.registerCommand("llama", { description: "inherited collision", handler: async () => {} });
  pi.registerCommand("inline-legacy-only", { description: "unrelated", handler: async () => {} });
}
`);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			builtinPackagePaths: [],
			extensionFactories: builtInExtensions,
		});
		await loader.reload();
		const inline = loader.getExtensions().extensions.find((extension) => extension.path === "<inline:llama.cpp>");
		expect(inline?.sourceInfo.configurationOrigin).toBe("bundled");

		const commands = resolveRegisteredCommands(loader.getExtensions().extensions);
		expect(commands.filter((command) => command.name === "llama").map((command) => command.invocationName)).toEqual(["llama"]);
		expect(commands.some((command) => command.name === "inline-legacy-only")).toBe(true);
		expect(loader.getOverlaps().some((overlap) => overlap.resourceType === "command" && overlap.name === "llama")).toBe(true);
	});
	it("keeps overlap reporting optional for existing custom resource loaders", () => {
		const customLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: async () => {},
			reload: async () => {},
		};
		expect("getOverlaps" in customLoader).toBe(false);
		expect(customLoader.getExtensions().overlaps ?? []).toEqual([]);
	});

	it("keeps the exported RPC state source compatible without overlap metadata", () => {
		const previousConsumerState: RpcSessionState = {
			thinkingLevel: "high",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			sessionId: "session",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		};
		expect(previousConsumerState.resourceOverlaps ?? []).toEqual([]);
	});

	it("keeps the exported extension runtime source compatible with prior custom runtimes", () => {
		const createLegacyRuntime = (actions: ExtensionActions): ExtensionRuntime => ({
			...actions,
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [],
			assertActive: () => {},
			invalidate: () => {},
			registerProvider: (() => {}) as ExtensionRuntime["registerProvider"],
			unregisterProvider: () => {},
		});
		expect(typeof createLegacyRuntime).toBe("function");
	});
});
