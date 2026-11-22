import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_COMMAND_NAMES } from "@bastani/atomic-tui/dist/builtin-command-names.js";
import { afterEach, describe, test } from "vitest";
import intercomHeavyFactory from "../../intercom/index-heavy.js";
import subagentsEagerFactory from "../../subagents/src/extension/index.js";
import webAccessHeavyFactory from "../../web-access/index-heavy.js";
import { getBuiltinPackagePaths } from "../src/core/builtin-packages.js";
import { createEventBus } from "../src/core/event-bus.js";
import { loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { viewedAgentCommand } from "../src/modes/interactive/subagent-chat-commands.ts";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.ts";

/** Structural: loading every shipped builtin package through DefaultResourceLoader. */
const BUILTIN_LOAD_TIMEOUT_MS = 60_000;

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bundled slash command list parity", () => {
	test(
		"BUNDLED_COMMAND_NAMES and BUNDLED_EXTENSION_SLASH_COMMANDS match every real bundled registration",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-bundled-commands-"));
			tempDirs.push(root);
			const home = join(root, "home");
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			mkdirSync(home, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(cwd, { recursive: true });
			process.env.HOME = home;
			process.env.USERPROFILE = home;
			process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
			linkSharedTranspileCache(agentDir);

			// 1. Load every shipped builtin package and inline builtin extension through the real loader.
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				builtinPackagePaths: getBuiltinPackagePaths(),
				extensionFactories: builtInExtensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const loadedResult = loader.getExtensions();
			assert.deepEqual(loadedResult.errors, []);

			const loaderCommands = new Map<string, string | undefined>();
			for (const ext of loadedResult.extensions) {
				for (const [name, command] of ext.commands) {
					loaderCommands.set(name, command.description);
				}
			}

			// 2. Also execute every real (heavy/eager) bundled extension factory directly so a stale
			//    lazy-builtin wrapper cannot mask a missing or removed slash command.
			const realFactories = [
				{ label: "subagents", factory: subagentsEagerFactory },
				{ label: "mcp", factory: createMcpExtension() },
				{ label: "web-access", factory: webAccessHeavyFactory },
				{ label: "intercom", factory: intercomHeavyFactory },
				...builtInExtensions.map((entry) =>
					typeof entry === "function"
						? { label: "inline", factory: entry }
						: { label: entry.name, factory: entry.factory },
				),
			];
			const realCommands = new Map<string, string | undefined>();
			for (const { label, factory } of realFactories) {
				const ext = await loadExtensionFromFactory(
					factory,
					cwd,
					createEventBus(),
					createExtensionRuntime(),
					`test:${label}`,
				);
				for (const [name, command] of ext.commands) {
					realCommands.set(name, command.description);
				}
			}

			// Loader (lazy builtins + inline builtins) and direct real factories must agree on command names.
			assert.deepEqual([...loaderCommands.keys()].sort(), [...realCommands.keys()].sort());

			// BUNDLED_COMMAND_NAMES must match the exact set of real registered bundled commands.
			const expectedNames = [...realCommands.keys()].sort();
			assert.deepEqual([...BUNDLED_COMMAND_NAMES].sort(), expectedNames);
			assert.equal(
				BUNDLED_COMMAND_NAMES.length,
				new Set(BUNDLED_COMMAND_NAMES).size,
				"BUNDLED_COMMAND_NAMES must not contain duplicates",
			);

			// BUNDLED_EXTENSION_SLASH_COMMANDS must match BUNDLED_COMMAND_NAMES in order and real descriptions.
			assert.deepEqual(
				BUNDLED_EXTENSION_SLASH_COMMANDS.map((cmd) => cmd.name),
				[...BUNDLED_COMMAND_NAMES],
			);
			for (const cmd of BUNDLED_EXTENSION_SLASH_COMMANDS) {
				assert.equal(
					cmd.description,
					realCommands.get(cmd.name),
					`BUNDLED_EXTENSION_SLASH_COMMANDS description mismatch for /${cmd.name}`,
				);
			}
		},
		BUILTIN_LOAD_TIMEOUT_MS,
	);

	test("deferred startup bundled-command lookup includes /llama and excludes /mcp-auth", () => {
		const isDeferredBundled = (name: string) =>
			BUNDLED_EXTENSION_SLASH_COMMANDS.some((command) => command.name === name) ? ("bundled" as const) : undefined;

		assert.deepEqual(viewedAgentCommand("/llama", isDeferredBundled), {
			kind: "main",
			name: "llama",
			showMain: false,
		});
		assert.deepEqual(viewedAgentCommand("/mcp", isDeferredBundled), { kind: "main", name: "mcp", showMain: false });
		assert.deepEqual(viewedAgentCommand("/mcp-auth", isDeferredBundled), { kind: "agent" });
	});
});
