/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createExtensionRuntime, discoverAndLoadExtensions, loadExtensions } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner, emitProjectTrustEvent } from "../../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
	ProviderConfig,
} from "../../src/core/extensions/types.ts";
import { KeybindingsManager, type KeyId } from "../../src/core/keybindings.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("ExtensionRunner", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	const defaultKeybindings = new KeybindingsManager().getEffectiveConfig();

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const providerModelConfig: ProviderConfig = {
		baseUrl: "https://provider.test/v1",
		apiKey: "provider-test-key",
		api: "openai-completions",
		models: [
			{
				id: "instant-model",
				name: "Instant Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};

		describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("allows a shortcut when the reserved set no longer contains the default key", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Uses freed default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebinding.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.model.cycleForward": "ctrl+n" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(shortcuts.has("ctrl+p")).toBe(true);
			expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));

			warnSpy.mockRestore();
		});

		it("warns but allows when extension uses non-reserved built-in shortcut", async () => {
			const pasteImageKey = Array.isArray(defaultKeybindings["app.clipboard.pasteImage"])
				? (defaultKeybindings["app.clipboard.pasteImage"][0] ?? "")
				: defaultKeybindings["app.clipboard.pasteImage"];
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("${pasteImageKey}", {
						description: "Overrides non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has(pasteImageKey as KeyId)).toBe(true);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts for reserved actions even when rebound", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+x", {
						description: "Conflicts with rebound reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebound-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.interrupt": "ctrl+x" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+x")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved key is also bound to non-reserved actions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Conflicts with shared reserved default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "shared-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+p")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Conflicts with multi-key reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clear": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+y")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns but allows when non-reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Overrides multi-key non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has("ctrl+y")).toBe(true);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

});
