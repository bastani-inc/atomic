import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import { createEventBus } from "../src/core/event-bus.js";
import { hasLazyBuiltinSpec } from "../src/core/extensions/lazy-builtin.js";
import { loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.js";

const tempDirs: string[] = [];
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lazy builtin mcp", () => {
	test("registers byte-identical /mcp command, completions, and consumer registration without loading mcp bundle", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-mcp-"));
		tempDirs.push(dir);
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;

		const mcpLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "mcp");
		assert.ok(mcpLocation, "mcp builtin location must exist");
		const entryPath = join(mcpLocation.packageDir, "index.ts");

		const lazyLoaded = await loadExtensions([entryPath], dir);
		assert.equal(hasLazyBuiltinSpec("mcp"), true);
		assert.deepEqual(lazyLoaded.errors, []);
		assert.equal(lazyLoaded.extensions.length, 1);
		assert.equal(extensionLoaderTestHooks.hasNativeBuiltinFactory(entryPath), false);

		const eagerExt = await loadExtensionFromFactory(
			createMcpExtension(),
			dir,
			createEventBus(),
			createExtensionRuntime(),
			entryPath,
		);
		const lazyExt = lazyLoaded.extensions[0]!;

		// Command parity
		assert.deepEqual([...lazyExt.commands.keys()], [...eagerExt.commands.keys()]);
		assert.equal(lazyExt.commands.get("mcp")?.description, eagerExt.commands.get("mcp")?.description);

		// Synchronous argument completion parity while dormant
		const lazyComplete = lazyExt.commands.get("mcp")!.getArgumentCompletions!;
		const eagerComplete = eagerExt.commands.get("mcp")!.getArgumentCompletions!;
		for (const prefix of ["", "l", "log", "rec", "login ", "unknown "]) {
			assert.deepEqual(
				lazyComplete(prefix),
				eagerComplete(prefix),
				`completion mismatch for ${JSON.stringify(prefix)}`,
			);
		}

		// Consumer must be registered so reportUnhandledMcpServers does not report false positives while dormant.
		assert.equal(lazyLoaded.runtime.mcpServerRegistry.hasConsumers(), true);
	});

	test("stays dormant on session_start without mcp.json or servers, and activates when mcp.json exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-mcp-start-"));
		tempDirs.push(dir);
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;

		const mcpLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "mcp");
		assert.ok(mcpLocation);
		const entryPath = join(mcpLocation.packageDir, "index.ts");

		// 1. No mcp.json, no servers -> stays dormant on session_start (no before_agent_start handler registered on pi).
		const dormantLoaded = await loadExtensions([entryPath], dir);
		const runner1 = new ExtensionRunner(
			dormantLoaded.extensions,
			dormantLoaded.runtime,
			dir,
			SessionManager.inMemory(dir),
			new ModelRegistry(AuthStorage.inMemory()),
		);
		runner1.bindCore(
			{
				sendMessage: () => {},
				sendMessages: () => {},
				sendUserMessage: () => {},
				appendEntry: async () => {},
				setSessionName: async () => {},
				getSessionName: () => undefined,
				setLabel: async () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: () => {},
				refreshTools: () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => "off",
				setThinkingLevel: async () => {},
			},
			{
				getModel: () => undefined,
				getScopedModels: () => [],
				isIdle: () => true,
				isProjectTrusted: () => true,
				getSignal: () => undefined,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
			},
		);
		await runner1.emit({ type: "session_start", reason: "startup" });
		assert.equal(dormantLoaded.extensions[0]!.handlers.has("before_agent_start"), false);
		// Dormant mcp__* toolRenderer fallback works even without loading MCP.
		assert.ok(runner1.resolveToolRenderers("mcp__docs__search", () => undefined));
		await runner1.emit({ type: "session_shutdown", reason: "quit" });

		// 2. Project .atomic/mcp.json exists -> activates on session_start and attaches before_agent_start!
		mkdirSync(join(dir, ".atomic"), { recursive: true });
		writeFileSync(join(dir, ".atomic", "mcp.json"), JSON.stringify({ mcpServers: {} }));
		const activeLoaded = await loadExtensions([entryPath], dir);
		const runner2 = new ExtensionRunner(
			activeLoaded.extensions,
			activeLoaded.runtime,
			dir,
			SessionManager.inMemory(dir),
			new ModelRegistry(AuthStorage.inMemory()),
		);
		runner2.bindCore(
			{
				sendMessage: () => {},
				sendMessages: () => {},
				sendUserMessage: () => {},
				appendEntry: async () => {},
				setSessionName: async () => {},
				getSessionName: () => undefined,
				setLabel: async () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: () => {},
				refreshTools: () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => "off",
				setThinkingLevel: async () => {},
			},
			{
				getModel: () => undefined,
				getScopedModels: () => [],
				isIdle: () => true,
				isProjectTrusted: () => true,
				getSignal: () => undefined,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
			},
		);
		await runner2.emit({ type: "session_start", reason: "startup" });
		assert.equal(activeLoaded.extensions[0]!.handlers.has("before_agent_start"), true);
		await runner2.emit({ type: "session_shutdown", reason: "quit" });
	});
});
