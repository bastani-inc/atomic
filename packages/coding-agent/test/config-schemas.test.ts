import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { renderConfigSchemas } from "../scripts/generate-schemas.ts";
import { parseHttpIdleTimeoutMs } from "../src/core/http-dispatcher.ts";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import { KeybindingValueSchema } from "../src/core/keybindings-schema.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import type { ThemeBg, ThemeColor } from "../src/modes/interactive/theme/theme-class.ts";
import { loadThemeFromContent } from "../src/modes/interactive/theme/theme-loading.ts";
import { parseThemeJson } from "../src/modes/interactive/theme/theme-parse.ts";
import { THEME_TOKENS } from "../src/modes/interactive/theme/theme-tokens.ts";

const schemaBaseUrl = "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas";
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-config-schema-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function schemaUrl(name: "models" | "settings" | "keybindings" | "theme"): string {
	return `${schemaBaseUrl}/${name}.schema.json`;
}

function readPackageFile(relativePath: string): string {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf-8");
}

type JsonSchemaNode = { properties?: Record<string, JsonSchemaNode>; anyOf?: JsonSchemaNode[]; default?: unknown };

function renderedSchema(name: "models" | "settings" | "keybindings" | "theme") {
	return JSON.parse(renderConfigSchemas().get(`schemas/${name}.schema.json`) ?? "") as JsonSchemaNode & {
		properties: Record<string, JsonSchemaNode>;
		$defs: Record<string, JsonSchemaNode>;
	};
}

/** Follow a dotted settings path through properties, descending into the object member of a union. */
function findSchemaNode(node: JsonSchemaNode, path: readonly string[]): JsonSchemaNode | undefined {
	const [head, ...rest] = path;
	if (head === undefined) return node;
	const candidates = [node, ...(node.anyOf ?? [])];
	for (const candidate of candidates) {
		const child = candidate.properties?.[head];
		if (child) return findSchemaNode(child, rest);
	}
	return undefined;
}

function defaultAt(defaults: unknown, path: readonly string[]): unknown {
	let current = defaults;
	for (const segment of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function defaultLeaves(value: unknown, prefix: readonly string[] = []): string[][] {
	if (typeof value !== "object" || value === null) return [[...prefix]];
	return Object.entries(value).flatMap(([key, child]) => defaultLeaves(child, [...prefix, key]));
}

describe("generated configuration schemas", () => {
	it("matches the four committed artifacts", () => {
		const rendered = renderConfigSchemas();
		expect([...rendered.keys()]).toEqual([
			"schemas/models.schema.json",
			"schemas/settings.schema.json",
			"schemas/keybindings.schema.json",
			"schemas/theme.schema.json",
		]);
		for (const [relativePath, expected] of rendered) {
			expect(
				readPackageFile(relativePath),
				`${relativePath} is stale; run npm run generate:schemas --workspace=@bastani/atomic`,
			).toBe(expected);
		}
	});

	it("identifies each artifact with its published location", () => {
		for (const name of ["models", "settings", "keybindings", "theme"] as const) {
			expect(renderedSchema(name)).toMatchObject({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				$id: schemaUrl(name),
			});
		}
	});

	it("compiles every artifact with an independent JSON Schema validator", () => {
		for (const name of ["models", "settings", "keybindings", "theme"] as const) {
			expect(() => new Ajv2020({ allErrors: true }).compile(renderedSchema(name)), name).not.toThrow();
		}
	});
});

describe("theme schema", () => {
	it("preserves editor guidance", () => {
		const schema = renderedSchema("theme");
		const colors = schema.properties.colors;
		expect(schema).toMatchObject({
			title: "Atomic Coding Agent Theme",
			description: "Theme schema for the Atomic coding agent",
			properties: {
				colors: {
					description: expect.stringContaining("fall back to compatible colors"),
					properties: {
						scrollbarThumb: { description: expect.stringContaining("falls back to selectedBg") },
						accent: { description: "Primary accent color (logo, selected items, cursor)" },
					},
				},
				workingIndicator: { description: expect.stringContaining("six-tone palette") },
				export: { description: expect.stringContaining("defaults derived from userMessageBg") },
			},
		});
		expect(Object.keys(schema.properties.workingIndicator.properties ?? {})).toEqual([
			"dark",
			"lift",
			"muted",
			"accent",
			"bright",
			"peak",
		]);
		expect(schema.$defs.ColorValue).toMatchObject({
			anyOf: [{ description: expect.stringContaining("Hex color") }, expect.any(Object)],
		});
		expect(colors.properties?.accent).toMatchObject({ $ref: "#/$defs/ColorValue" });
	});

	it("declares exactly the tokens the runtime theme resolves, requiring those without a fallback", () => {
		const schema = renderedSchema("theme");
		const colors = schema.properties.colors as JsonSchemaNode & { required: string[] };
		expect(Object.keys(colors.properties ?? {})).toEqual(Object.keys(THEME_TOKENS));
		const requiredTokens = Object.entries(THEME_TOKENS)
			.filter(([, descriptor]) => !("fallback" in descriptor))
			.map(([name]) => name);
		expect(colors.required).toEqual(requiredTokens);
	});

	it("resolves every declared token on the runtime theme, applying fallbacks for omitted optional tokens", () => {
		const builtIn = JSON.parse(readPackageFile("src/modes/interactive/theme/dark.json")) as {
			colors: Record<string, string | number>;
		};
		const required = { ...builtIn, name: "required-only", colors: { ...builtIn.colors } };
		for (const [name, descriptor] of Object.entries(THEME_TOKENS)) {
			if ("fallback" in descriptor) delete required.colors[name];
		}
		const theme = loadThemeFromContent("required-only.json", JSON.stringify(required), "truecolor");
		for (const [name, descriptor] of Object.entries(THEME_TOKENS)) {
			if (descriptor.slot === "foreground") expect(theme.getFgAnsi(name as ThemeColor), name).toContain("\x1b[");
			else expect(theme.getBgAnsi(name as ThemeBg), name).toContain("\x1b[");
		}
		expect(theme.getBgAnsi("scrollbarThumb")).toBe(theme.getBgAnsi("selectedBg"));
		expect(theme.getFgAnsi("searchMatchText")).toBe(theme.getFgAnsi("text"));
	});

	it("documents every token in the theme reference", () => {
		const reference = readPackageFile("docs/themes/reference.md");
		for (const token of Object.keys(THEME_TOKENS)) {
			expect(reference, token).toContain(`\`${token}\``);
		}
	});

	it("accepts $schema and rejects malformed or unknown properties", () => {
		const builtIn = JSON.parse(readPackageFile("src/modes/interactive/theme/dark.json")) as Record<string, unknown>;
		expect(parseThemeJson("custom", { ...builtIn, $schema: schemaUrl("theme"), name: "custom" }).name).toBe("custom");
		expect(() => parseThemeJson("invalid", { ...builtIn, name: "invalid/name" })).toThrow(
			"theme names cannot contain",
		);
		expect(() => parseThemeJson("invalid", { ...builtIn, colors: {} })).toThrow("Missing required color tokens");
		for (const invalid of [
			{ ...builtIn, unexpected: true },
			{ ...builtIn, colors: { ...(builtIn.colors as Record<string, unknown>), scrollbarThmb: "" } },
			{ ...builtIn, export: { unexpected: "" } },
			{ ...builtIn, workingIndicator: { unexpected: "" } },
		]) {
			expect(() => parseThemeJson("invalid", invalid)).toThrow(/additional properties/i);
		}
	});
});

describe("models.json schema", () => {
	const validator = () => Compile(renderedSchema("models"));

	it("preserves moved model guidance", () => {
		const models = renderedSchema("models");
		expect(models.$defs.ModelCost.properties).toMatchObject({
			input: { description: expect.stringContaining("USD per million tokens") },
			tiers: { description: expect.stringContaining("highest matching input threshold") },
		});
		expect(models.$defs.ModelInputLimits.properties).toMatchObject({
			maxRequestBytes: { description: expect.stringContaining("serialized provider request size") },
		});
	});

	it("describes Atomic's provider and compatibility fields", () => {
		const models = renderedSchema("models");
		const compatProperties = Object.keys(models.$defs.ProviderCompat.properties ?? {});
		expect(compatProperties).toEqual(
			expect.arrayContaining([
				"supportsForcedToolChoice",
				"supportsTemperature",
				"enforcesPreservedThinkingBinding",
				"delegatesThinkingModelBinding",
				"supportsMidConvoToolChanges",
				"supportsAdditionalTools",
				"supportsGrammarTools",
			]),
		);
		expect(
			validator().Check({
				providers: {
					radius: { oauth: "radius", authHeader: true },
					local: {
						compat: {
							zaiToolStream: true,
							thinkingTokenBudgetField: "thinking_budget",
							chatTemplateKwargs: { budget: { $var: "thinking.budget" } },
							supportsMidConvoSystemMessages: true,
							supportsForcedToolChoice: false,
							delegatesThinkingModelBinding: true,
							supportsGrammarTools: true,
						},
						models: [
							{
								id: "model",
								input: ["text", "image", "pdf"],
								inputLimits: { maxRequestBytes: 1024, images: { maxPerRequest: 2 } },
								promptCache: { short: 300 },
							},
						],
					},
				},
			}),
		).toBe(true);
		expect(validator().Check({ providers: { local: { models: [{ id: "" }] } } })).toBe(false);
		expect(validator().Check({ providers: { local: { compat: { delegatesThinkingModelBinding: "yes" } } } })).toBe(
			false,
		);
		expect(validator().Check({ providers: { local: { compat: { supportsGrammarTools: "yes" } } } })).toBe(false);
	});

	it("rejects non-positive model token limits", () => {
		const schema = validator();
		for (const field of ["contextWindow", "maxTokens"] as const) {
			for (const value of [0, -1]) {
				expect(
					schema.Check({ providers: { local: { models: [{ id: "model", [field]: value }] } } }),
					`models[].${field}=${value}`,
				).toBe(false);
				expect(
					schema.Check({ providers: { local: { modelOverrides: { model: { [field]: value } } } } }),
					`modelOverrides.${field}=${value}`,
				).toBe(false);
			}
		}
		expect(
			schema.Check({
				providers: {
					local: {
						models: [{ id: "model", contextWindow: 1, maxTokens: 1 }],
						modelOverrides: { model: { contextWindow: 1, maxTokens: 1 } },
					},
				},
			}),
		).toBe(true);
	});

	it("accepts custom compatibility settings and rejects malformed known fields at runtime", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "models.json");
		const compat = {
			customOption: "value",
			supportsStore: true,
			supportsAdditionalTools: true,
		};
		writeFileSync(path, JSON.stringify({ providers: { demo: { api: "custom-api", compat } } }));

		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("demo")?.compat).toEqual(compat);

		writeFileSync(path, JSON.stringify({ providers: { demo: { compat: { supportsLongCacheRetention: "yes" } } } }));
		expect((await ModelConfig.load(path)).getError()).toContain("Invalid models.json schema");
	});

	it("validates $schema in models.json at runtime", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				$schema: schemaUrl("models"),
				providers: { demo: { baseUrl: "http://localhost:8080/v1", models: [{ id: "demo" }] } },
			}),
		);

		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("demo")?.models?.[0]?.id).toBe("demo");

		writeFileSync(
			path,
			JSON.stringify({ $schema: schemaUrl("models"), providers: { demo: { models: [{ id: "" }] } } }),
		);
		expect((await ModelConfig.load(path)).getError()).toContain("Invalid models.json schema");

		writeFileSync(path, JSON.stringify({ $schema: 42, providers: {} }));
		expect((await ModelConfig.load(path)).getError()).toContain("$schema");
	});
});

describe("settings.json schema", () => {
	it("preserves moved settings guidance", () => {
		expect(renderedSchema("settings").properties).toMatchObject({
			quietStartup: { description: expect.stringContaining("hide all startup output") },
			defaultTools: { description: expect.stringContaining("+name and -name") },
			fullscreenWheelScrollLines: { description: expect.stringContaining("1 to 100") },
		});
	});

	it("validates representative documents including Atomic's settings", () => {
		const validator = Compile(renderedSchema("settings"));
		expect(
			validator.Check({
				theme: "dark",
				cacheWarming: "idle",
				extensionSetting: { enabled: true },
				queueMode: "all",
				websockets: true,
				skills: { enableSkillCommands: true, customDirectories: ["./skills"] },
				retry: { maxDelayMs: 1000 },
				routerModel: "typesafe/jev-latest",
				compactionModel: "morph/morph-compactor",
				fallbackModels: ["anthropic/claude-opus-4-8:xhigh"],
				modelRouting: { allowedProviders: ["anthropic"], excludedModels: ["*-fast"] },
				compaction: {
					enabled: true,
					reserveTokens: 16384,
					compression_ratio: 0.5,
					preserve_recent: 2,
					query: "keep the auth decisions",
					modelOverrides: { "anthropic/claude-sonnet-4-5": { reserveTokens: 32768, preserve_recent: 4 } },
				},
				sessionSummary: { enabled: false },
				bashInterceptor: { enabled: true },
				search: { contextBefore: 2, contextAfter: 4 },
				herdr: { enabled: false },
				markdown: { codeBlockIndent: "  ", mermaid: "final", latex: false },
				packages: ["pi-skills", { source: "pi-skills", workflows: [], mcpServers: [], autoload: false }],
				workflows: { paths: ["./workflows"], durability: { systemDatabaseUrlFile: "~/.atomic/neon/direct.url" } },
				streamDeadlineMs: "5m",
				codemode: { mode: "only", inlineBudget: 0 },
			}),
		).toBe(true);
		expect(validator.Check({ cacheWarming: "always" })).toBe(false);
		expect(validator.Check({ workflows: { durability: { unknownKey: "x" } } })).toBe(false);
		expect(validator.Check({ compaction: { compression_ratio: 1 } })).toBe(false);
	});

	it("rejects settings values that runtime accessors reject", () => {
		const validator = Compile(SettingsSchema);
		const invalidSettings = [
			{ compaction: { reserveTokens: -1 } },
			{ compaction: { preserve_recent: 1.5 } },
			{
				compaction: {
					modelOverrides: { "provider/model": { reserveTokens: Number.MAX_SAFE_INTEGER + 1 } },
				},
			},
			{ httpIdleTimeoutMs: -1 },
			{ websocketConnectTimeoutMs: -1 },
			{ httpIdleTimeoutMs: "bogus" },
			{ streamDeadlineMs: "bogus" },
			{ codemode: { inlineBudget: -1 } },
		];
		for (const invalid of invalidSettings) {
			expect(validator.Check(invalid), JSON.stringify(invalid)).toBe(false);
		}
		expect(() => SettingsManager.inMemory(invalidSettings[0]).getCompactionReserveTokens()).toThrow();
		expect(() => SettingsManager.inMemory(invalidSettings[1]).getCompactionPreserveRecent()).toThrow();
		expect(() => SettingsManager.inMemory(invalidSettings[3]).getHttpIdleTimeoutMs()).toThrow();
		expect(() => SettingsManager.inMemory(invalidSettings[4]).getWebSocketConnectTimeoutMs()).toThrow();
		expect(() => SettingsManager.inMemory(invalidSettings[5]).getHttpIdleTimeoutMs()).toThrow();
		expect(() => SettingsManager.inMemory(invalidSettings[6]).getStreamDeadlineMs()).toThrow();
		expect(
			validator.Check({
				compaction: {
					reserveTokens: 0,
					preserve_recent: Number.MAX_SAFE_INTEGER,
					modelOverrides: { "provider/model": { reserveTokens: 0 } },
				},
				httpIdleTimeoutMs: 0,
				websocketConnectTimeoutMs: "disabled",
				codemode: { inlineBudget: 0 },
			}),
		).toBe(true);
	});

	it("accepts every timeout form the runtime parses", () => {
		const validator = Compile(SettingsSchema);
		for (const value of [0, 30_000, "0", "30000", "500ms", "30s", "5m", "1h", "30S", "disabled", "Disabled"]) {
			expect(parseHttpIdleTimeoutMs(value), String(value)).not.toBeUndefined();
			expect(validator.Check({ streamDeadlineMs: value }), String(value)).toBe(true);
		}
		for (const value of ["", "bogus", "-1", "5 minutes", "m"]) {
			expect(parseHttpIdleTimeoutMs(value), value).toBeUndefined();
			expect(validator.Check({ streamDeadlineMs: value }), value).toBe(false);
		}
	});

	it("describes legacy settings migrations accurately", () => {
		const schema = renderedSchema("settings") as unknown as {
			properties: {
				queueMode: { description: string };
				retry: { properties: { maxDelayMs: { description: string } } };
			};
		};
		expect(schema.properties.retry.properties.maxDelayMs.description).toContain("provider.maxRetryDelayMs");
		expect(schema.properties.queueMode.description).toBe("Legacy setting migrated to steeringMode.");
	});

	it("documents every setting in the settings reference", () => {
		const schema = renderedSchema("settings");
		const documented = readPackageFile("docs/settings.md")
			.split("\n")
			.map((line) => /^\| `([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)` \|/.exec(line)?.[1])
			.filter((setting): setting is string => setting !== undefined);
		expect(documented.length).toBeGreaterThan(60);
		const missing = documented.filter((setting) => findSchemaNode(schema, setting.split(".")) === undefined);
		expect(missing).toEqual([]);
	});

	it("publishes the runtime defaults", () => {
		const schema = renderedSchema("settings");
		for (const path of defaultLeaves(SETTINGS_DEFAULTS)) {
			const node = findSchemaNode(schema, path);
			expect(node, path.join(".")).toBeDefined();
			expect(node?.default, path.join(".")).toEqual(defaultAt(SETTINGS_DEFAULTS, path));
		}
	});

	it("returns the published defaults from accessors when nothing is configured", () => {
		const settings = SettingsManager.inMemory();
		const defaults = SETTINGS_DEFAULTS;
		expect(settings.getRouterModel()).toBe(defaults.routerModel);
		expect(settings.getTransport()).toBe(defaults.transport);
		expect(settings.getSteeringMode()).toBe(defaults.steeringMode);
		expect(settings.getFollowUpMode()).toBe(defaults.followUpMode);
		expect(settings.getCompactionSettings()).toEqual(defaults.compaction);
		expect(settings.getBranchSummarySettings()).toEqual(defaults.branchSummary);
		expect(settings.getSessionSummarySettings()).toEqual(defaults.sessionSummary);
		expect(settings.getRetrySettings()).toEqual({
			enabled: defaults.retry.enabled,
			maxRetries: defaults.retry.maxRetries,
			baseDelayMs: defaults.retry.baseDelayMs,
			maxAgentDelayMs: defaults.retry.maxAgentDelayMs,
		});
		expect(settings.getProviderRetrySettings().maxRetryDelayMs).toBe(defaults.retry.provider.maxRetryDelayMs);
		expect(settings.getHideThinkingBlock()).toBe(defaults.hideThinkingBlock);
		expect(settings.getShowCacheMissNotices()).toBe(defaults.showCacheMissNotices);
		expect(settings.getQuietStartup()).toBe(defaults.quietStartup);
		expect(settings.getDefaultProjectTrust()).toBe(defaults.defaultProjectTrust);
		expect(settings.getBashInterceptorEnabled()).toBe(defaults.bashInterceptor.enabled);
		expect(settings.getSearchContextBefore()).toBe(defaults.search.contextBefore);
		expect(settings.getSearchContextAfter()).toBe(defaults.search.contextAfter);
		expect(settings.getCollapseChangelog()).toBe(defaults.collapseChangelog);
		expect(settings.getEnableInstallTelemetry()).toBe(defaults.enableInstallTelemetry);
		expect(settings.getEnableSkillCommands()).toBe(defaults.enableSkillCommands);
		expect(settings.getShowImages()).toBe(defaults.terminal.showImages);
		expect(settings.getImageWidthCells()).toBe(defaults.terminal.imageWidthCells);
		expect(settings.getShowTerminalProgress()).toBe(defaults.terminal.showTerminalProgress);
		expect(settings.getImageAutoResize()).toBe(defaults.images.autoResize);
		expect(settings.getBlockImages()).toBe(defaults.images.blockImages);
		expect(settings.getDoubleEscapeAction()).toBe(defaults.doubleEscapeAction);
		expect(settings.getTreeFilterMode()).toBe(defaults.treeFilterMode);
		expect(settings.getEditorPaddingX()).toBe(defaults.editorPaddingX);
		expect(settings.getOutputPad()).toBe(defaults.outputPad);
		expect(settings.getAutocompleteMaxVisible()).toBe(defaults.autocompleteMaxVisible);
		expect(settings.getFullscreenScrollbar()).toBe(defaults.fullscreenScrollbar);
		expect(settings.getFullscreenExitOutput()).toBe(defaults.fullscreenExitOutput);
		expect(settings.getFullscreenCopyOnSelect()).toBe(defaults.fullscreenCopyOnSelect);
		expect(settings.getFullscreenWheelScrollLines()).toBe(defaults.fullscreenWheelScrollLines);
		expect(settings.getCodemodeInlineBudget()).toBe(defaults.codemode.inlineBudget);
		expect(settings.getCodeBlockIndent()).toBe(defaults.markdown.codeBlockIndent);
		expect(settings.getMermaidRenderingMode()).toBe(defaults.markdown.mermaid);
		expect(settings.getLatexRenderingEnabled()).toBe(defaults.markdown.latex);
		expect(settings.getHttpIdleTimeoutMs()).toBe(defaults.httpIdleTimeoutMs);
		expect(settings.getCacheWarmingMode()).toBe(defaults.cacheWarming);
	});

	it("accepts $schema in settings.json and preserves unknown settings", async () => {
		const directory = createTemporaryDirectory();
		writeFileSync(
			join(directory, "settings.json"),
			JSON.stringify({ $schema: schemaUrl("settings"), theme: "light", extensionSetting: { enabled: true } }),
		);

		const manager = SettingsManager.create(directory, directory);
		expect(manager.getTheme()).toBe("light");
		expect(manager.getGlobalSettings()).toMatchObject({
			$schema: schemaUrl("settings"),
			extensionSetting: { enabled: true },
		});
		manager.setTheme("dark");
		await manager.flush();
		expect(JSON.parse(readFileSync(join(directory, "settings.json"), "utf-8"))).toMatchObject({
			$schema: schemaUrl("settings"),
			theme: "dark",
			extensionSetting: { enabled: true },
		});
	});
});

describe("keybindings.json schema", () => {
	it("describes every keybinding, including Atomic's", () => {
		const properties = Object.keys(renderedSchema("keybindings").properties);
		expect(properties).toEqual(["$schema", ...Object.keys(KEYBINDINGS)]);
		expect(properties).toEqual(
			expect.arrayContaining([
				"app.workflows.scrollUp",
				"app.tasks.open",
				"app.auth.copyUrl",
				"tui.altScreen.search",
			]),
		);
		expect(renderedSchema("keybindings").properties["app.suspend"]).toMatchObject({
			description: expect.stringContaining("PowerShell"),
		});
	});

	it("accepts the default keys of every keybinding", () => {
		const validator = Compile(KeybindingValueSchema);
		for (const [id, definition] of Object.entries(KEYBINDINGS)) {
			expect(validator.Check(definition.defaultKeys), id).toBe(true);
		}
	});

	it("documents only keybindings that exist", () => {
		const documented = readPackageFile("docs/keybindings.md")
			.split("\n")
			.map((line) => /^\| `((?:app|tui)\.[A-Za-z.]+)` \|/.exec(line)?.[1])
			.filter((id): id is string => id !== undefined);
		expect(documented.length).toBeGreaterThan(60);
		expect(documented.filter((id) => !(id in KEYBINDINGS))).toEqual([]);
	});

	it("validates representative documents", () => {
		const validator = Compile(renderedSchema("keybindings"));
		expect(
			validator.Check({
				$schema: schemaUrl("keybindings"),
				"app.session.new": "ctrl+n",
				"app.workflows.scrollUp": ["ctrl+alt+k"],
				"extension.action": ["alt+x"],
			}),
		).toBe(true);
		expect(validator.Check({ "app.session.new": 42 })).toBe(false);
	});

	it("validates keybinding syntax", () => {
		const validator = Compile(renderedSchema("keybindings"));
		for (const binding of ["a", "9", "pageUp", "+", "ctrl+shift+x", "alt+ctrl+?", "ctrl+shift+alt+super+f12"]) {
			expect(validator.Check({ "extension.action": binding }), binding).toBe(true);
		}
		for (const binding of [
			"",
			"Ctrl+x",
			"control+x",
			"ctrl+not-a-key",
			"ctrl+ctrl+x",
			"ctrl+shift+alt+super+ctrl+x",
		]) {
			expect(validator.Check({ "extension.action": binding }), binding).toBe(false);
		}
	});

	it("accepts $schema in keybindings.json without treating it as an action", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(
			join(directory, "keybindings.json"),
			JSON.stringify({ $schema: schemaUrl("keybindings"), "app.session.new": "ctrl+n" }),
		);

		const manager = KeybindingsManager.create(directory);
		expect(manager.getUserBindings()).toEqual({ "app.session.new": "ctrl+n" });
		expect(manager.getEffectiveConfig()["app.session.new"]).toBe("ctrl+n");
	});
});
