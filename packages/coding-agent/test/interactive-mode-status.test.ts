import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { type AutocompleteProvider, CombinedAutocompleteProvider, Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// Upstream pi 0.79.1 also exercises overlay focus restoration with packages/tui's
// VirtualTerminal harness. Atomic consumes @earendil-works/pi-tui as a dependency
// rather than vendoring that test harness, so this suite keeps the equivalent
// package-level interactive status/autocomplete coverage that can run here.

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.handleEvent model changes", () => {
	test("refreshes the built-in header when the active model changes", async () => {
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			refreshBuiltInHeader: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "model_changed",
			model: { id: "faux-2", provider: "faux" },
			previousModel: { id: "faux-1", provider: "faux" },
			source: "set",
		});

		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.refreshBuiltInHeader).toHaveBeenCalledTimes(1);
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode /trust", () => {
	test("uses the active runtime agentDir for saved decisions", () => {
		const root = mkdtempSync(path.join(tmpdir(), "atomic-trust-selector-agent-dir-"));
		try {
			const cwd = path.join(root, "project");
			const runtimeAgentDir = path.join(root, "runtime-agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(runtimeAgentDir, { recursive: true });
			let createdSelector: { handleInput(input: string): void } | undefined;
			const fakeThis = {
				sessionManager: { getCwd: () => cwd },
				settingsManager: { isProjectTrusted: () => false },
				runtimeHost: { services: { agentDir: runtimeAgentDir } },
				showStatus: vi.fn(),
				ui: { requestRender: vi.fn() },
				showSelector: vi.fn((factory: (done: () => void) => { component: { handleInput(input: string): void } }) => {
					createdSelector = factory(vi.fn()).component;
				}),
			};

			(InteractiveMode as any).prototype.showTrustSelector.call(fakeThis);
			createdSelector?.handleInput("\n");

			expect(new ProjectTrustStore(runtimeAgentDir).get(cwd)).toBe(true);
			expect(fakeThis.showStatus).toHaveBeenCalledWith(
				expect.stringContaining("Saved trust decision: trusted"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode reload project trust", () => {
	test("persists implicit startup trust after reload creates project config", () => {
		const root = mkdtempSync(path.join(tmpdir(), "atomic-reload-trust-"));
		try {
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			mkdirSync(path.join(cwd, ".atomic"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });

			const fakeThis = {
				autoTrustOnReloadCwd: cwd,
				sessionManager: { getCwd: () => cwd },
				settingsManager: { isProjectTrusted: () => true },
				runtimeHost: { services: { agentDir } },
				showWarning: vi.fn(),
			};

			const saved = (InteractiveMode as any).prototype.maybeSaveImplicitProjectTrustAfterReload.call(fakeThis);

			expect(saved).toBe(true);
			expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(true);
			expect(fakeThis.autoTrustOnReloadCwd).toBeUndefined();
			expect(fakeThis.showWarning).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			getThemeSetting: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => {
					fakeThis.ui.requestRender();
					return { success: true };
				}),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			getThemeSetting: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom host custom UI state", () => {
	function createCustomUiHostFixture() {
		const fakeThis: any = {
			editor: {
				getText: vi.fn(() => "draft"),
				setText: vi.fn(),
			},
			editorContainer: {
				clear: vi.fn(),
				addChild: vi.fn(),
			},
			keybindings: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
			blockingInlineCustomUiDepth: 0,
			deferredInlineCustomUiFocusDepth: 0,
			pendingInlineCustomUiFocus: undefined,
			hostCustomUiStateListeners: new Set(),
		};
		Object.setPrototypeOf(fakeThis, (InteractiveMode as any).prototype);
		return fakeThis;
	}

	test("runs the custom UI factory synchronously before returning", async () => {
		const fakeThis = createCustomUiHostFixture();
		let returned = false;
		let factoryCalled = false;
		const component = {
			render: () => [],
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};

		const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
			fakeThis,
			(_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result: string) => void) => {
				expect(returned).toBe(false);
				factoryCalled = true;
				done("done");
				return component;
			},
		);
		returned = true;

		expect(factoryCalled).toBe(true);
		await expect(promise).resolves.toBe("done");
	});

	test("does not invoke the custom UI factory or notify host state listeners when the signal is already aborted", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const controller = new AbortController();
		const failure = new Error("already aborted");
		let factoryCalled = false;
		controller.abort(failure);

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(
				fakeThis,
				() => {
					factoryCalled = true;
					return { render: () => [], invalidate: vi.fn() };
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(failure);

		expect(factoryCalled).toBe(false);
		expect(states).toEqual([]);
		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
	});

	test("immediate abort after custom() returns cannot run a deferred factory", async () => {
		const fakeThis = createCustomUiHostFixture();
		const controller = new AbortController();
		const failure = new Error("aborted after return");
		let factoryCalls = 0;
		const component = {
			render: () => [],
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};

		const promise = (InteractiveMode as any).prototype.showExtensionCustom.call(
			fakeThis,
			() => {
				factoryCalls++;
				return component;
			},
			{ signal: controller.signal },
		);
		expect(factoryCalls).toBe(1);

		controller.abort(failure);
		await expect(promise).rejects.toBe(failure);
		await Promise.resolve();

		expect(factoryCalls).toBe(1);
		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
	});

	test("releases host state when a non-overlay custom UI factory throws synchronously", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const failure = new Error("factory failed synchronously");

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, () => {
				expect(fakeThis.getHostCustomUiState()).toMatchObject({
					blockingInlineCustomUiActive: true,
					blockingInlineCustomUiDepth: 1,
				});
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
		expect(states).toEqual([
			{ blockingInlineCustomUiActive: true, blockingInlineCustomUiDepth: 1 },
			{ blockingInlineCustomUiActive: false, blockingInlineCustomUiDepth: 0 },
		]);
	});

	test("releases host state when a non-overlay custom UI factory rejects asynchronously", async () => {
		const fakeThis = createCustomUiHostFixture();
		const states: Array<{ blockingInlineCustomUiActive: boolean; blockingInlineCustomUiDepth: number }> = [];
		fakeThis.onHostCustomUiStateChange((state: (typeof states)[number]) => states.push({ ...state }));
		const failure = new Error("factory rejected asynchronously");

		await expect(
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, () => {
				expect(fakeThis.getHostCustomUiState()).toMatchObject({
					blockingInlineCustomUiActive: true,
					blockingInlineCustomUiDepth: 1,
				});
				return Promise.reject(failure);
			}),
		).rejects.toBe(failure);

		expect(fakeThis.getHostCustomUiState()).toEqual({
			blockingInlineCustomUiActive: false,
			blockingInlineCustomUiDepth: 0,
		});
		expect(states).toEqual([
			{ blockingInlineCustomUiActive: true, blockingInlineCustomUiDepth: 1 },
			{ blockingInlineCustomUiActive: false, blockingInlineCustomUiDepth: 0 },
		]);
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});
});

describe("InteractiveMode submit routing", () => {
	function installSubmitHandler(options: { onInput?: (text: string) => void } = {}) {
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const fakeThis: any = {
			defaultEditor,
			editor: {
				setText: vi.fn(),
				addToHistory: vi.fn(),
			},
			shutdown: vi.fn(async () => {}),
			session: {
				isBashRunning: false,
				isCompacting: false,
				isStreaming: false,
			},
			isExtensionCommand: vi.fn(() => false),
			flushPendingBashComponents: vi.fn(),
			onInputCallback: options.onInput,
		};

		(InteractiveMode as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		return { fakeThis, submit: defaultEditor.onSubmit! };
	}

	test("routes exact /exit and /quit to graceful shutdown", async () => {
		for (const command of ["/exit", "/quit"]) {
			const { fakeThis, submit } = installSubmitHandler();

			await submit(command);

			expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
			expect(fakeThis.shutdown).toHaveBeenCalledTimes(1);
		}
	});

	test("does not treat /exit with arguments as the exit command", async () => {
		const onInput = vi.fn();
		const { fakeThis, submit } = installSubmitHandler({ onInput });

		await submit("/exit now");

		expect(fakeThis.shutdown).not.toHaveBeenCalled();
		expect(onInput).toHaveBeenCalledWith("/exit now");
		expect(fakeThis.editor.addToHistory).toHaveBeenCalledWith("/exit now");
	});
});

describe("InteractiveMode /fast autocomplete", () => {
	function createModel(provider: string, id = `${provider}-model`): Model<Api> {
		return {
			id,
			name: id,
			api: "openai-completions",
			provider,
			baseUrl: `https://${provider}.example/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	type ExtensionCommandFixture = {
		name: string;
		invocationName?: string;
		description?: string;
	};

	function createProvider(
		models: Model<Api>[],
		scopedModels: Model<Api>[] = [],
		options: {
			hasConfiguredAuth?: (model: Model<Api>) => boolean;
			extensionCommands?: ExtensionCommandFixture[];
		} = {},
	): AutocompleteProvider {
		const fakeThis: any = {
			session: {
				scopedModels: scopedModels.map((model) => ({ model })),
				modelRegistry: {
					getAvailable: vi.fn(() => models),
					hasConfiguredAuth: vi.fn(options.hasConfiguredAuth ?? (() => true)),
				},
				promptTemplates: [],
				extensionRunner: {
					getRegisteredCommands: () =>
						(options.extensionCommands ?? []).map((command) => ({
							name: command.name,
							invocationName: command.invocationName ?? command.name,
							description: command.description,
							sourceInfo: {
								path: `/tmp/extensions/${command.name}.ts`,
								source: "test",
								scope: "project" as const,
								origin: "top-level" as const,
								baseDir: "/tmp/extensions",
							},
							handler: vi.fn(),
						})),
				},
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => true },
			sessionManager: { getCwd: () => process.cwd() },
			fdPath: undefined,
			skillCommands: new Map(),
		};
		Object.setPrototypeOf(fakeThis, (InteractiveMode as any).prototype);
		return (InteractiveMode as any).prototype.createBaseAutocompleteProvider.call(fakeThis) as AutocompleteProvider;
	}

	async function slashLabels(provider: AutocompleteProvider, prefix = "/fa"): Promise<string[]> {
		const suggestions = await provider.getSuggestions([prefix], 0, prefix.length, {
			signal: new AbortController().signal,
		});
		return suggestions?.items.map((item) => item.value) ?? [];
	}

	test("shows /fast when an OpenAI model is available", async () => {
		const labels = await slashLabels(createProvider([createModel("openai")]));

		expect(labels).toContain("fast");
	});

	test("shows /fast when an OpenAI Codex scoped model is available", async () => {
		const labels = await slashLabels(
			createProvider([createModel("github-copilot")], [createModel("openai-codex")]),
		);

		expect(labels).toContain("fast");
	});

	test("hides /fast when only GitHub Copilot models are available", async () => {
		const labels = await slashLabels(createProvider([createModel("github-copilot")]));

		expect(labels).not.toContain("fast");
	});

	test("hides /fast for unauthenticated scoped OpenAI models without falling back", async () => {
		for (const scopedProvider of ["openai", "openai-codex"]) {
			const scopedModel = createModel(scopedProvider, `${scopedProvider}-unauthenticated`);
			const labels = await slashLabels(
				createProvider([createModel("openai", "available-openai")], [scopedModel], {
					hasConfiguredAuth: (model) => model !== scopedModel,
				}),
			);

			expect(labels).not.toContain("fast");
		}
	});

	test("hides extension /fast when the built-in command is hidden", async () => {
		const labels = await slashLabels(
			createProvider([createModel("github-copilot")], [], {
				extensionCommands: [
					{ name: "fast", description: "Extension fast command" },
					{ name: "faster", description: "Non-conflicting extension command" },
				],
			}),
		);

		expect(labels).not.toContain("fast");
		expect(labels).toContain("faster");
	});

	test("shows built-in /exit for /ex and hides conflicting extension /exit", async () => {
		const labels = await slashLabels(
			createProvider([createModel("openai")], [], {
				extensionCommands: [
					{ name: "exit", description: "Extension exit command" },
					{ name: "explain", description: "Non-conflicting extension command" },
				],
			}),
			"/ex",
		);

		expect(labels).toContain("exit");
		expect(labels.filter((label) => label === "exit")).toHaveLength(1);
		expect(labels).toContain("explain");
	});
});

describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	test("matches model command arguments across provider/model order", async () => {
		type TestModel = { id: string; provider: string; name: string };
		type FakeInteractiveMode = {
			session: {
				scopedModels: Array<{ model: TestModel }>;
				modelRegistry: { getAvailable: () => TestModel[] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: null;
		};

		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const models = [
			{ id: "gpt-5.2-codex", provider: "github-copilot", name: "GPT-5.2 Codex" },
			{ id: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5" },
		];
		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRegistry: { getAvailable: () => models },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
		};
		Object.setPrototypeOf(fakeThis, (InteractiveMode as any).prototype);

		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const line = "/model codexgpt";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"openai-codex/gpt-5.5",
			"github-copilot/gpt-5.2-codex",
		]);
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
			getResourceDiagnosticsTotal: (values: Array<{ length: number }[]>) =>
				values.reduce((total, diagnostics) => total + diagnostics.length, 0),
			formatResourceCount: (count: number, singular: string, plural?: string) =>
				(InteractiveMode as any).prototype.formatResourceCount.call(fakeThis, count, singular, plural),
			addResourceDisclosure: (disclosure: unknown) =>
				(InteractiveMode as any).prototype.addResourceDisclosure.call(fakeThis, disclosure),
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.pi/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("shows a compact resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("RESOURCES");
		expect(output).toContain("1 skill");
		// compact summary only: no expanded detail rows, no per-resource names
		expect(output).not.toContain("available");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Skills");
		expect(output).toContain("available");
		expect(output).toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("Skills");
		expect(output).toContain("available");
		expect(output).toContain("commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		// abbreviated extension labels render in the expanded Extensions detail row
		expect(output).toContain("Extensions");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 8 extensions"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 3 extensions"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 1 extension"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 1 extension"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 2 extensions"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 2 extensions"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 2 extensions"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 1 extension"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`"RESOURCES context ready · 1 extension"`);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
			"RESOURCES context ready · 8 extensions
			✓ Ready      context loaded
			✓ Skills     0 available · none
			✓ Prompts    0 available · none
			✓ Extensions 8 available · answer.ts, local-index, user-index, pi-markdown-preview, +4"
		`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("RESOURCES");
		expect(output).toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
		// compact summary only: no expanded detail rows
		expect(output).not.toContain("available");
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("RESOURCES");
		// expanded view adds the ✓ Ready detail rows not present in the compact summary
		expect(output).toContain("Ready");
		expect(output).toContain("available");
		// external context path preserved in full; cwd-internal path relativized to its basename
		expect(output).toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
