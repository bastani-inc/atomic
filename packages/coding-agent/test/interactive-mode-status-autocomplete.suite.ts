import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import { buildSkillCatalog, type SkillCatalog } from "../src/core/skill-catalog.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
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
		expect(onInput).toHaveBeenCalledWith({ text: "/exit now", draft: "/exit now" });
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
			hasConfiguredAuth?: (provider: string) => boolean;
			extensionCommands?: ExtensionCommandFixture[];
		} = {},
	): AutocompleteProvider {
		const fakeThis: any = {
			session: {
				scopedModels: scopedModels.map((model) => ({ model })),
				modelRuntime: {
					getAvailableSnapshot: vi.fn(() => models),
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

	test("offers an extension /fast command now that no built-in reserves the name", async () => {
		const labels = await slashLabels(
			createProvider([createModel("github-copilot")], [], {
				extensionCommands: [
					{ name: "fast", description: "Extension fast command" },
					{ name: "faster", description: "Non-conflicting extension command" },
				],
			}),
		);

		expect(labels).toContain("fast");
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

	function createAutocompleteProvider(
		cwd: string,
		fdPath: string | null = null,
		skillCatalog?: SkillCatalog,
	): AutocompleteProvider {
		type AutocompleteHost = {
			session: {
				scopedModels: [];
				modelRuntime: { getAvailableSnapshot: () => [] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: {
					getSkills: () => { skills: Skill[]; diagnostics: [] };
					getSkillCatalog?: () => SkillCatalog;
				};
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
				modelRuntime: { getAvailableSnapshot: () => [] },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: {
					getSkills: () => ({
						skills: skillCatalog?.candidates.map((candidate) => candidate.skill) ?? [],
						diagnostics: [],
					}),
					...(skillCatalog ? { getSkillCatalog: () => skillCatalog } : {}),
				},
			},
			settingsManager: { getEnableSkillCommands: () => skillCatalog !== undefined },
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

	const FAKE_FD_HELPER = `
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
const args = process.argv.slice(2);
const base = args[args.indexOf("--base-directory") + 1];
const subjectIsFullPath = args.includes("--full-path");
let pattern;
try {
	pattern = new RegExp(args.at(-1), "i");
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
const found = [];
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relativePath = relative(base, join(dir, entry.name)).split(sep).join("/");
		if (pattern.test(subjectIsFullPath ? relativePath : entry.name)) {
			found.push(entry.isDirectory() ? relativePath + "/" : relativePath);
		}
		if (entry.isDirectory()) walk(join(dir, entry.name));
	}
};
walk(base);
process.stdout.write(found.join("\\n"));
`;

	function createFakeFd(): string {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fake-fd-"));
		tempDirs.push(dir);
		const helperPath = join(dir, "fd.mjs");
		const fdPath = join(dir, "fd");
		writeFileSync(helperPath, FAKE_FD_HELPER);
		writeFileSync(fdPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} "$@"\n`);
		chmodSync(fdPath, 0o755);
		return fdPath;
	}

	test.skipIf(process.platform === "win32")(
		"completes @ file mentions whose query contains regex metacharacters through fd (#10972)",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "atomic-at-autocomplete-"));
			tempDirs.push(dir);
			mkdirSync(join(dir, "pages"));
			for (const file of ["[id].tsx", "index.tsx", "(group).ts"]) writeFileSync(join(dir, "pages", file), "x");
			const provider = createAutocompleteProvider(dir, createFakeFd());

			for (const [line, expected] of [
				["@pages/[", "@pages/[id].tsx"],
				["@pages/(", "@pages/(group).ts"],
				["@[id", "@pages/[id].tsx"],
				["@(group", "@pages/(group).ts"],
			] as const) {
				const suggestions = await provider.getSuggestions([line], 0, line.length, {
					signal: new AbortController().signal,
				});

				expect(
					suggestions?.items.map((item) => item.value),
					line,
				).toEqual([expected]);
			}
		},
	);

	test("offers every source-qualified collision command from the catalog", async () => {
		const makeSkill = (filePath: string, scope: "user" | "temporary", bundled: boolean): Skill => ({
			name: "review",
			description: `${scope} review`,
			filePath,
			baseDir: join(filePath, ".."),
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo(filePath, {
				source: bundled ? "/packages/workflows" : "local",
				scope,
				configurationOrigin: bundled ? "bundled" : "atomic",
			}),
		});
		const user = makeSkill("/tmp/user/review/SKILL.md", "user", false);
		const builtin = makeSkill("/tmp/builtin/review/SKILL.md", "temporary", true);
		const catalog = buildSkillCatalog([user, builtin], [user]);
		const provider = createAutocompleteProvider("/tmp", null, catalog);
		const line = "/skill:review@";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual(["skill:review@user", "skill:review@builtin"]);
	});

	test("matches model command arguments across provider/model order", async () => {
		type TestModel = { id: string; provider: string; name: string };
		type FakeInteractiveMode = {
			session: {
				scopedModels: Array<{ model: TestModel }>;
				modelRuntime: { getAvailableSnapshot: () => TestModel[] };
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
				modelRuntime: { getAvailableSnapshot: () => models },
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
				modelRuntime: { getAvailableSnapshot: () => [] },
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
		expect(await suggestionValues(provider, "/workflow ")).toContain("fan-out-and-synthesize ");
		expect(await suggestionValues(provider, "/workflow list")).toEqual([]);
		expect(await suggestionValues(provider, "/workflow fa")).toEqual(["fan-out-and-synthesize "]);
		expect(await suggestionValues(provider, "/workflow inputs fa")).toEqual(["inputs fan-out-and-synthesize "]);
		expect(await suggestionValues(provider, "/workflow fan-out-and-synthesize p")).toEqual([
			"fan-out-and-synthesize prompt=",
		]);
	});
});
