import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, setKeybindings, type Terminal } from "@earendil-works/pi-tui";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import type { AgentSessionReloadOptions } from "../../packages/coding-agent/src/core/agent-session-types.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { keyText } from "../../packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 100;
	rows = 36;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalKeybindings = getKeybindings();
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	setKeybindings(originalKeybindings);
});

function writeExpandBinding(agentDir: string, binding: string): void {
	writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.tools.expand": binding }));
}

async function createMode(agentDir: string, extensionFactory?: ExtensionFactory): Promise<InteractiveMode> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-local-mode-cwd-"));
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: extensionFactory ? [extensionFactory] : [],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	initTheme("dark");
	const mode = new InteractiveMode(runtime, { terminal: new FakeTerminal() });
	cleanup.push(async () => {
		await runtime.dispose();
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});
	return mode;
}

test.serial("exported InteractiveMode uses services.agentDir for display and editor input", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-explicit-agent-dir-"));
	writeExpandBinding(agentDir, "ctrl+x");
	const ambientDir = mkdtempSync(join(tmpdir(), "atomic-ambient-agent-dir-"));
	process.env.ATOMIC_CODING_AGENT_DIR = ambientDir;
	cleanup.push(async () => { rmSync(ambientDir, { recursive: true, force: true }); });
	const mode = await createMode(agentDir);
	let dispatches = 0;
	mode.defaultEditor.onAction("app.tools.expand", () => { dispatches++; });

	assert.deepEqual(mode.keybindings.getKeys("app.tools.expand"), ["ctrl+x"]);
	assert.equal(keyText("app.tools.expand"), "ctrl+x");
	mode.defaultEditor.handleInput("\x18");
	assert.equal(dispatches, 1);
	let hostDisposals = 0;
	mode.disposeInteractiveEngineHost = () => { hostDisposals++; };
	mode.stop();
	assert.equal(hostDisposals, 1, "mode stop must dispose its interactive-engine host attachment");
});

test.serial("local slash and extension-context reloads stage keybindings before session_start and roll back in place", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-local-reload-agent-dir-"));
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	writeExpandBinding(agentDir, "ctrl+x");
	const observed: string[] = [];
	const extension: ExtensionFactory = (api) => {
		api.on("session_start", (event) => { observed.push(`${event.reason}:${keyText("app.tools.expand")}`); });
		api.registerCommand("fixture-reload", {
			description: "reload through extension context",
			handler: async (_args, ctx) => ctx.reload(),
		});
	};
	const mode = await createMode(agentDir, extension);
	await mode.bindCurrentSessionExtensions();
	const identity = mode.keybindings;
	assert.deepEqual(observed, ["startup:ctrl+x"]);

	writeExpandBinding(agentDir, "ctrl+y");
	await mode.handleReloadCommand();
	assert.deepEqual(observed, ["startup:ctrl+x", "reload:ctrl+y"]);
	assert.equal(mode.keybindings, identity);
	assert.deepEqual(mode.keybindings.getKeys("app.tools.expand"), ["ctrl+y"]);

	writeExpandBinding(agentDir, "ctrl+z");
	const command = mode.session.extensionRunner.getCommand("fixture-reload");
	assert.ok(command);
	await command.handler("", mode.session.extensionRunner.createCommandContext());
	assert.deepEqual(observed, ["startup:ctrl+x", "reload:ctrl+y", "reload:ctrl+z"]);
	assert.equal(mode.keybindings, identity);

	writeExpandBinding(agentDir, "ctrl+w");
	const session = mode.session;
	const originalReload = session.reload.bind(session);
	Object.defineProperty(session, "reload", {
		configurable: true,
		value: async (options?: AgentSessionReloadOptions) => {
			await options?.beforeSessionStart?.();
			throw new Error("fixture reload failure");
		},
	});
	await mode.handleReloadCommand();
	assert.equal(mode.keybindings, identity);
	assert.deepEqual(mode.keybindings.getKeys("app.tools.expand"), ["ctrl+z"]);
	Object.defineProperty(session, "reload", { configurable: true, value: originalReload });
});
