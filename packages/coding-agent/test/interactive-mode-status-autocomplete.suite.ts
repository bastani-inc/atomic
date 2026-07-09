import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model } from "@earendil-works/pi-ai/compat";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
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
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAutocompleteProvider(cwd: string, fdPath: string | null = null): AutocompleteProvider {
		type AutocompleteHost = {
			session: {
				scopedModels: [];
				modelRegistry: { getAvailable: () => [] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: string | null;
		};
		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: AutocompleteHost): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const fakeThis: AutocompleteHost = {
			session: {
				scopedModels: [],
				modelRegistry: { getAvailable: () => [] },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => cwd },
			fdPath,
		};
		Object.setPrototypeOf(fakeThis, (InteractiveMode as unknown as { prototype: object }).prototype);
		return createBaseAutocompleteProvider.call(fakeThis);
	}

	test("falls back to path completion for @ file mentions before fd is ready", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-at-autocomplete-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "spec.md"), "# Spec\n");
		writeFileSync(join(dir, "other.txt"), "Other\n");
		const provider = createAutocompleteProvider(dir);

		const suggestions = await provider.getSuggestions(["@sp"], 0, 3, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.prefix).toBe("@sp");
		expect(suggestions?.items.map((item) => item.value)).toEqual(["@spec.md"]);
	});

	test("preserves @ quoting when fallback completion targets paths with spaces", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-at-autocomplete-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "task brief.md"), "# Task\n");
		const provider = createAutocompleteProvider(dir);
		const line = 'please read @"task';

		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.prefix).toBe('@"task');
		expect(suggestions?.items.map((item) => item.value)).toEqual(['@"task brief.md"']);
	});

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


describe("InteractiveMode deferred workflow autocomplete", () => {
	function createDeferredWorkflowProvider(): AutocompleteProvider {
		const fakeThis: any = {
			deferredStartupPending: true,
			session: {
				scopedModels: [],
				modelRegistry: { getAvailable: () => [] },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => process.cwd() },
			fdPath: null,
		};
		Object.setPrototypeOf(fakeThis, (InteractiveMode as any).prototype);
		return (InteractiveMode as any).prototype.createBaseAutocompleteProvider.call(fakeThis) as AutocompleteProvider;
	}

	async function suggestionValues(provider: AutocompleteProvider, line: string): Promise<string[]> {
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		return suggestions?.items.map((item) => item.value) ?? [];
	}

	test("offers workflow names and inputs before the workflow extension implementation loads", async () => {
		const provider = createDeferredWorkflowProvider();

		expect(await suggestionValues(provider, "/wor")).toContain("workflow");
		expect(await suggestionValues(provider, "/workflow ")).toContain("deep-research-codebase ");
		expect(await suggestionValues(provider, "/workflow list")).toEqual([]);
		expect(await suggestionValues(provider, "/workflow de")).toEqual(["deep-research-codebase "]);
		expect(await suggestionValues(provider, "/workflow inputs de")).toEqual(["inputs deep-research-codebase "]);
		expect(await suggestionValues(provider, "/workflow deep-research-codebase p")).toEqual([
			"deep-research-codebase prompt=",
		]);
	});
});
