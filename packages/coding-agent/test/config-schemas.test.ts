import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { Compile } from "typebox/compile";
import { afterEach, describe, it } from "vitest";
import { renderConfigSchemas } from "../scripts/generate-schemas.js";
import { parseHttpIdleTimeoutMs } from "../src/core/http-dispatcher.js";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.js";
import { KeybindingValueSchema } from "../src/core/keybindings-schema.js";
import { ModelConfig } from "../src/core/model-config.js";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { SettingsSchema } from "../src/core/settings-schema.js";
import type { ThemeBg, ThemeColor } from "../src/modes/interactive/theme/theme-class.js";
import { loadThemeFromContent } from "../src/modes/interactive/theme/theme-loading.js";
import { parseThemeJson } from "../src/modes/interactive/theme/theme-parse.js";
import { THEME_TOKENS } from "../src/modes/interactive/theme/theme-tokens.js";

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

type JsonSchemaNode = {
	properties?: Record<string, JsonSchemaNode>;
	anyOf?: JsonSchemaNode[];
	default?: unknown;
	$schema?: string;
	$id?: string;
	$ref?: string;
	title?: string;
	description?: string;
};

function assertDescriptionIncludes(node: JsonSchemaNode | undefined, fragment: string) {
	assert.equal(typeof node?.description, "string", `missing description containing ${fragment}`);
	assert.ok(node?.description?.includes(fragment), `${node?.description} should contain ${fragment}`);
}

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
		assert.deepEqual(
			[...rendered.keys()],
			[
				"schemas/models.schema.json",
				"schemas/settings.schema.json",
				"schemas/keybindings.schema.json",
				"schemas/theme.schema.json",
			],
		);
		for (const [relativePath, expected] of rendered) {
			assert.equal(
				readPackageFile(relativePath),
				expected,
				`${relativePath} is stale; run npm run generate:schemas --workspace=@bastani/atomic`,
			);
		}
	});

	it("identifies each artifact with its published location", () => {
		for (const name of ["models", "settings", "keybindings", "theme"] as const) {
			const schema = renderedSchema(name);
			assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
			assert.equal(schema.$id, schemaUrl(name));
		}
	});

	it("compiles every artifact with an independent JSON Schema validator", () => {
		for (const name of ["models", "settings", "keybindings", "theme"] as const) {
			assert.doesNotThrow(() => new Ajv2020({ allErrors: true }).compile(renderedSchema(name)), name);
		}
	});
});

describe("theme schema", () => {
	it("preserves editor guidance", () => {
		const schema = renderedSchema("theme");
		const colors = schema.properties.colors;
		assert.equal(schema.title, "Atomic Coding Agent Theme");
		assert.equal(schema.description, "Theme schema for the Atomic coding agent");
		assertDescriptionIncludes(colors, "fall back to compatible colors");
		assertDescriptionIncludes(colors.properties?.scrollbarThumb, "falls back to selectedBg");
		assert.equal(colors.properties?.accent?.description, "Primary accent color (logo, selected items, cursor)");
		assertDescriptionIncludes(schema.properties.workingIndicator, "six-tone palette");
		assertDescriptionIncludes(schema.properties.export, "defaults derived from userMessageBg");
		assert.deepEqual(Object.keys(schema.properties.workingIndicator.properties ?? {}), [
			"dark",
			"lift",
			"muted",
			"accent",
			"bright",
			"peak",
		]);
		const colorValueVariants = schema.$defs.ColorValue.anyOf;
		assert.ok(Array.isArray(colorValueVariants));
		assert.equal(colorValueVariants.length, 2);
		assertDescriptionIncludes(colorValueVariants[0], "Hex color");
		assert.equal(typeof colorValueVariants[1], "object");
		assert.equal(colors.properties?.accent?.$ref, "#/$defs/ColorValue");
	});

	it("declares exactly the tokens the runtime theme resolves, requiring those without a fallback", () => {
		const schema = renderedSchema("theme");
		const colors = schema.properties.colors as JsonSchemaNode & { required: string[] };
		assert.deepEqual(Object.keys(colors.properties ?? {}), Object.keys(THEME_TOKENS));
		const requiredTokens = Object.entries(THEME_TOKENS)
			.filter(([, descriptor]) => !("fallback" in descriptor))
			.map(([name]) => name);
		assert.deepEqual(colors.required, requiredTokens);
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
			if (descriptor.slot === "foreground") assert.ok(theme.getFgAnsi(name as ThemeColor).includes("\x1b["), name);
			else assert.ok(theme.getBgAnsi(name as ThemeBg).includes("\x1b["), name);
		}
		assert.equal(theme.getBgAnsi("scrollbarThumb"), theme.getBgAnsi("selectedBg"));
		assert.equal(theme.getFgAnsi("searchMatchText"), theme.getFgAnsi("text"));
	});

	it("documents every token in the theme reference", () => {
		const reference = readPackageFile("docs/themes/reference.md");
		for (const token of Object.keys(THEME_TOKENS)) {
			assert.ok(reference.includes(`\`${token}\``), token);
		}
	});

	it("accepts $schema and rejects malformed or unknown properties", () => {
		const builtIn = JSON.parse(readPackageFile("src/modes/interactive/theme/dark.json")) as Record<string, unknown>;
		assert.equal(
			parseThemeJson("custom", { ...builtIn, $schema: schemaUrl("theme"), name: "custom" }).name,
			"custom",
		);
		assert.throws(
			() => parseThemeJson("invalid", { ...builtIn, name: "invalid/name" }),
			/theme names cannot contain/,
		);
		assert.throws(() => parseThemeJson("invalid", { ...builtIn, colors: {} }), /Missing required color tokens/);
		for (const invalid of [
			{ ...builtIn, unexpected: true },
			{ ...builtIn, colors: { ...(builtIn.colors as Record<string, unknown>), scrollbarThmb: "" } },
			{ ...builtIn, export: { unexpected: "" } },
			{ ...builtIn, workingIndicator: { unexpected: "" } },
		]) {
			assert.throws(() => parseThemeJson("invalid", invalid), /additional properties/i);
		}
	});
});

describe("models.json schema", () => {
	const validator = () => Compile(renderedSchema("models"));

	it("preserves moved model guidance", () => {
		const models = renderedSchema("models");
		assertDescriptionIncludes(models.$defs.ModelCost.properties?.input, "USD per million tokens");
		assertDescriptionIncludes(models.$defs.ModelCost.properties?.tiers, "highest matching input threshold");
		assertDescriptionIncludes(
			models.$defs.ModelInputLimits.properties?.maxRequestBytes,
			"serialized provider request size",
		);
	});

	it("describes Atomic's provider and compatibility fields", () => {
		const models = renderedSchema("models");
		const compatProperties = Object.keys(models.$defs.ProviderCompat.properties ?? {});
		for (const property of [
			"supportsForcedToolChoice",
			"supportsTemperature",
			"enforcesPreservedThinkingBinding",
			"delegatesThinkingModelBinding",
			"supportsMidConvoToolChanges",
			"supportsAdditionalTools",
			"supportsGrammarTools",
		]) {
			assert.ok(compatProperties.includes(property), property);
		}
		assert.equal(
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
			true,
		);
		assert.equal(validator().Check({ providers: { local: { models: [{ id: "" }] } } }), false);
		assert.equal(
			validator().Check({ providers: { local: { compat: { delegatesThinkingModelBinding: "yes" } } } }),
			false,
		);
		assert.equal(validator().Check({ providers: { local: { compat: { supportsGrammarTools: "yes" } } } }), false);
	});

	it("rejects non-positive model token limits", () => {
		const schema = validator();
		for (const field of ["contextWindow", "maxTokens"] as const) {
			for (const value of [0, -1]) {
				assert.equal(
					schema.Check({ providers: { local: { models: [{ id: "model", [field]: value }] } } }),
					false,
					`models[].${field}=${value}`,
				);
				assert.equal(
					schema.Check({ providers: { local: { modelOverrides: { model: { [field]: value } } } } }),
					false,
					`modelOverrides.${field}=${value}`,
				);
			}
		}
		assert.equal(
			schema.Check({
				providers: {
					local: {
						models: [{ id: "model", contextWindow: 1, maxTokens: 1 }],
						modelOverrides: { model: { contextWindow: 1, maxTokens: 1 } },
					},
				},
			}),
			true,
		);
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
		assert.equal(config.getError(), undefined);
		assert.deepEqual(config.getProvider("demo")?.compat, compat);

		writeFileSync(path, JSON.stringify({ providers: { demo: { compat: { supportsLongCacheRetention: "yes" } } } }));
		assert.ok((await ModelConfig.load(path)).getError().includes("Invalid models.json schema"));
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
		assert.equal(config.getError(), undefined);
		assert.equal(config.getProvider("demo")?.models?.[0]?.id, "demo");

		writeFileSync(
			path,
			JSON.stringify({ $schema: schemaUrl("models"), providers: { demo: { models: [{ id: "" }] } } }),
		);
		assert.ok((await ModelConfig.load(path)).getError().includes("Invalid models.json schema"));

		writeFileSync(path, JSON.stringify({ $schema: 42, providers: {} }));
		assert.ok((await ModelConfig.load(path)).getError().includes("$schema"));
	});
});

describe("settings.json schema", () => {
	it("preserves moved settings guidance", () => {
		const properties = renderedSchema("settings").properties;
		assertDescriptionIncludes(properties.quietStartup, "hide all startup output");
		assertDescriptionIncludes(properties.defaultTools, "+name and -name");
		assertDescriptionIncludes(properties.fullscreenWheelScrollLines, "1 to 100");
	});

	it("validates representative documents including Atomic's settings", () => {
		const validator = Compile(renderedSchema("settings"));
		assert.equal(
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
			true,
		);
		assert.equal(validator.Check({ cacheWarming: "always" }), false);
		assert.equal(validator.Check({ workflows: { durability: { unknownKey: "x" } } }), false);
		assert.equal(validator.Check({ compaction: { compression_ratio: 1 } }), false);
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
			assert.equal(validator.Check(invalid), false, JSON.stringify(invalid));
		}
		assert.throws(() => SettingsManager.inMemory(invalidSettings[0]).getCompactionReserveTokens());
		assert.throws(() => SettingsManager.inMemory(invalidSettings[1]).getCompactionPreserveRecent());
		assert.throws(() => SettingsManager.inMemory(invalidSettings[3]).getHttpIdleTimeoutMs());
		assert.throws(() => SettingsManager.inMemory(invalidSettings[4]).getWebSocketConnectTimeoutMs());
		assert.throws(() => SettingsManager.inMemory(invalidSettings[5]).getHttpIdleTimeoutMs());
		assert.throws(() => SettingsManager.inMemory(invalidSettings[6]).getStreamDeadlineMs());
		assert.equal(
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
			true,
		);
	});

	it("accepts every timeout form the runtime parses", () => {
		const validator = Compile(SettingsSchema);
		for (const value of [0, 30_000, "0", "30000", "500ms", "30s", "5m", "1h", "30S", "disabled", "Disabled"]) {
			assert.notEqual(parseHttpIdleTimeoutMs(value), undefined, String(value));
			assert.equal(validator.Check({ streamDeadlineMs: value }), true, String(value));
		}
		for (const value of ["", "bogus", "-1", "5 minutes", "m"]) {
			assert.equal(parseHttpIdleTimeoutMs(value), undefined, value);
			assert.equal(validator.Check({ streamDeadlineMs: value }), false, value);
		}
	});

	it("describes legacy settings migrations accurately", () => {
		const schema = renderedSchema("settings") as unknown as {
			properties: {
				queueMode: { description: string };
				retry: { properties: { maxDelayMs: { description: string } } };
			};
		};
		assert.ok(schema.properties.retry.properties.maxDelayMs.description.includes("provider.maxRetryDelayMs"));
		assert.equal(schema.properties.queueMode.description, "Legacy setting migrated to steeringMode.");
	});

	it("documents every setting in the settings reference", () => {
		const schema = renderedSchema("settings");
		const documented = readPackageFile("docs/settings.md")
			.split("\n")
			.map((line) => /^\| `([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)` \|/.exec(line)?.[1])
			.filter((setting): setting is string => setting !== undefined);
		assert.ok(documented.length > 60);
		const missing = documented.filter((setting) => findSchemaNode(schema, setting.split(".")) === undefined);
		assert.deepEqual(missing, []);
	});

	it("publishes the runtime defaults", () => {
		const schema = renderedSchema("settings");
		for (const path of defaultLeaves(SETTINGS_DEFAULTS)) {
			const node = findSchemaNode(schema, path);
			assert.notEqual(node, undefined, path.join("."));
			assert.deepEqual(node?.default, defaultAt(SETTINGS_DEFAULTS, path), path.join("."));
		}
	});

	it("returns the published defaults from accessors when nothing is configured", () => {
		const settings = SettingsManager.inMemory();
		const defaults = SETTINGS_DEFAULTS;
		assert.equal(settings.getRouterModel(), defaults.routerModel);
		assert.equal(settings.getTransport(), defaults.transport);
		assert.equal(settings.getSteeringMode(), defaults.steeringMode);
		assert.equal(settings.getFollowUpMode(), defaults.followUpMode);
		assert.deepEqual(settings.getCompactionSettings(), defaults.compaction);
		assert.deepEqual(settings.getBranchSummarySettings(), defaults.branchSummary);
		assert.deepEqual(settings.getSessionSummarySettings(), defaults.sessionSummary);
		assert.deepEqual(settings.getRetrySettings(), {
			enabled: defaults.retry.enabled,
			maxRetries: defaults.retry.maxRetries,
			baseDelayMs: defaults.retry.baseDelayMs,
			maxAgentDelayMs: defaults.retry.maxAgentDelayMs,
		});
		assert.equal(settings.getProviderRetrySettings().maxRetryDelayMs, defaults.retry.provider.maxRetryDelayMs);
		assert.equal(settings.getHideThinkingBlock(), defaults.hideThinkingBlock);
		assert.equal(settings.getShowCacheMissNotices(), defaults.showCacheMissNotices);
		assert.equal(settings.getQuietStartup(), defaults.quietStartup);
		assert.equal(settings.getDefaultProjectTrust(), defaults.defaultProjectTrust);
		assert.equal(settings.getBashInterceptorEnabled(), defaults.bashInterceptor.enabled);
		assert.equal(settings.getSearchContextBefore(), defaults.search.contextBefore);
		assert.equal(settings.getSearchContextAfter(), defaults.search.contextAfter);
		assert.equal(settings.getCollapseChangelog(), defaults.collapseChangelog);
		assert.equal(settings.getEnableInstallTelemetry(), defaults.enableInstallTelemetry);
		assert.equal(settings.getEnableSkillCommands(), defaults.enableSkillCommands);
		assert.equal(settings.getShowImages(), defaults.terminal.showImages);
		assert.equal(settings.getImageWidthCells(), defaults.terminal.imageWidthCells);
		assert.equal(settings.getShowTerminalProgress(), defaults.terminal.showTerminalProgress);
		assert.equal(settings.getImageAutoResize(), defaults.images.autoResize);
		assert.equal(settings.getBlockImages(), defaults.images.blockImages);
		assert.equal(settings.getDoubleEscapeAction(), defaults.doubleEscapeAction);
		assert.equal(settings.getTreeFilterMode(), defaults.treeFilterMode);
		assert.equal(settings.getEditorPaddingX(), defaults.editorPaddingX);
		assert.equal(settings.getOutputPad(), defaults.outputPad);
		assert.equal(settings.getAutocompleteMaxVisible(), defaults.autocompleteMaxVisible);
		assert.equal(settings.getFullscreenScrollbar(), defaults.fullscreenScrollbar);
		assert.equal(settings.getFullscreenExitOutput(), defaults.fullscreenExitOutput);
		assert.equal(settings.getFullscreenCopyOnSelect(), defaults.fullscreenCopyOnSelect);
		assert.equal(settings.getFullscreenWheelScrollLines(), defaults.fullscreenWheelScrollLines);
		assert.equal(settings.getCodemodeInlineBudget(), defaults.codemode.inlineBudget);
		assert.equal(settings.getCodeBlockIndent(), defaults.markdown.codeBlockIndent);
		assert.equal(settings.getMermaidRenderingMode(), defaults.markdown.mermaid);
		assert.equal(settings.getLatexRenderingEnabled(), defaults.markdown.latex);
		assert.equal(settings.getHttpIdleTimeoutMs(), defaults.httpIdleTimeoutMs);
		assert.equal(settings.getCacheWarmingMode(), defaults.cacheWarming);
	});

	it("accepts $schema in settings.json and preserves unknown settings", async () => {
		const directory = createTemporaryDirectory();
		writeFileSync(
			join(directory, "settings.json"),
			JSON.stringify({ $schema: schemaUrl("settings"), theme: "light", extensionSetting: { enabled: true } }),
		);

		const manager = SettingsManager.create(directory, directory);
		assert.equal(manager.getTheme(), "light");
		const globalSettings = manager.getGlobalSettings() as {
			$schema?: string;
			extensionSetting?: { enabled: boolean };
		};
		assert.equal(globalSettings.$schema, schemaUrl("settings"));
		assert.deepEqual(globalSettings.extensionSetting, { enabled: true });
		manager.setTheme("dark");
		await manager.flush();
		const savedSettings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf-8")) as {
			$schema?: string;
			theme?: string;
			extensionSetting?: { enabled: boolean };
		};
		assert.equal(savedSettings.$schema, schemaUrl("settings"));
		assert.equal(savedSettings.theme, "dark");
		assert.deepEqual(savedSettings.extensionSetting, { enabled: true });
	});
});

describe("keybindings.json schema", () => {
	it("describes every keybinding, including Atomic's", () => {
		const properties = Object.keys(renderedSchema("keybindings").properties);
		assert.deepEqual(properties, ["$schema", ...Object.keys(KEYBINDINGS)]);
		for (const property of ["app.workflows.scrollUp", "app.tasks.open", "app.auth.copyUrl", "tui.altScreen.search"]) {
			assert.ok(properties.includes(property), property);
		}
		assertDescriptionIncludes(renderedSchema("keybindings").properties["app.suspend"], "PowerShell");
	});

	it("accepts the default keys of every keybinding", () => {
		const validator = Compile(KeybindingValueSchema);
		for (const [id, definition] of Object.entries(KEYBINDINGS)) {
			assert.equal(validator.Check(definition.defaultKeys), true, id);
		}
	});

	it("documents only keybindings that exist", () => {
		const documented = readPackageFile("docs/keybindings.md")
			.split("\n")
			.map((line) => /^\| `((?:app|tui)\.[A-Za-z.]+)` \|/.exec(line)?.[1])
			.filter((id): id is string => id !== undefined);
		assert.ok(documented.length > 60);
		assert.deepEqual(
			documented.filter((id) => !(id in KEYBINDINGS)),
			[],
		);
	});

	it("validates representative documents", () => {
		const validator = Compile(renderedSchema("keybindings"));
		assert.equal(
			validator.Check({
				$schema: schemaUrl("keybindings"),
				"app.session.new": "ctrl+n",
				"app.workflows.scrollUp": ["ctrl+alt+k"],
				"extension.action": ["alt+x"],
			}),
			true,
		);
		assert.equal(validator.Check({ "app.session.new": 42 }), false);
	});

	it("validates keybinding syntax", () => {
		const validator = Compile(renderedSchema("keybindings"));
		for (const binding of ["a", "9", "pageUp", "+", "ctrl+shift+x", "alt+ctrl+?", "ctrl+shift+alt+super+f12"]) {
			assert.equal(validator.Check({ "extension.action": binding }), true, binding);
		}
		for (const binding of [
			"",
			"Ctrl+x",
			"control+x",
			"ctrl+not-a-key",
			"ctrl+ctrl+x",
			"ctrl+shift+alt+super+ctrl+x",
		]) {
			assert.equal(validator.Check({ "extension.action": binding }), false, binding);
		}
	});

	it("accepts $schema in keybindings.json without treating it as an action", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(
			join(directory, "keybindings.json"),
			JSON.stringify({ $schema: schemaUrl("keybindings"), "app.session.new": "ctrl+n" }),
		);

		const manager = KeybindingsManager.create(directory);
		assert.deepEqual(manager.getUserBindings(), { "app.session.new": "ctrl+n" });
		assert.equal(manager.getEffectiveConfig()["app.session.new"], "ctrl+n");
	});
});
