import assert from "node:assert/strict";
import { join } from "node:path";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { type Args, printHelp } from "../../packages/coding-agent/src/cli/args.js";
import { buildInitialMessage } from "../../packages/coding-agent/src/cli/initial-message.js";
import { exitOnDecisionConfigError } from "../../packages/coding-agent/src/cli/settings-startup.js";
import { getThemesDir } from "../../packages/coding-agent/src/config.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { areExperimentalFeaturesEnabled } from "../../packages/coding-agent/src/core/experimental.js";
import type {
	ProviderChatModelConfig,
	ProviderClassifierModelConfig,
} from "../../packages/coding-agent/src/core/extensions/provider-types.js";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.js";
import { splitFallbackModel } from "../../packages/coding-agent/src/core/fallback-models.js";
import { resolveModelReference } from "../../packages/coding-agent/src/core/model-resolver-patterns.js";
import { resolveModelScopeFromModels } from "../../packages/coding-agent/src/core/model-resolver-scope.js";
import { DefaultPackageManager } from "../../packages/coding-agent/src/core/package-manager.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { loadSkills } from "../../packages/coding-agent/src/core/skills.js";
import { loadSkillsAsync } from "../../packages/coding-agent/src/core/skills-async.js";
import { StorageConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { createLocalBashOperations } from "../../packages/coding-agent/src/core/tools/bash.js";
import { isReadResourceSelector } from "../../packages/coding-agent/src/core/tools/read-selectors.js";
import { createSearchToolDefinition } from "../../packages/coding-agent/src/core/tools/search.js";
import { limitMcpContent } from "../../packages/coding-agent/src/extensions/mcp/tools.js";
import { NativeModuleUnavailableError } from "../../packages/coding-agent/src/index.js";
import { main } from "../../packages/coding-agent/src/main.js";
import { buildSettingsItems } from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-items.js";
import type {
	SettingsCallbacks,
	SettingsConfig,
} from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-types.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import {
	hexColorAnsi,
	initTheme,
	loadThemeFromPath,
	onThemeChange,
	refreshColorEnvironment,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
	theme,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import type { RpcCommand } from "../../packages/coding-agent/src/modes/rpc/rpc-types.js";
import * as fsWatch from "../../packages/coding-agent/src/utils/fs-watch.js";
import { checkForNewPiVersion, getLatestPiRelease } from "../../packages/coding-agent/src/utils/version-check.js";
import { sqlite } from "../../packages/coding-agent/test/helpers/sqlite.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = makeTempDirectory(prefix);
	tempDirs.push(dir);
	return dir;
}

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

function createTestModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "openai-completions",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	stopThemeWatcher();
	onThemeChange(() => {});
	setRegisteredThemes([]);
	initTheme("dark");
	for (const dir of tempDirs.splice(0)) {
		removeTempDirectory(dir);
	}
});

describe("buildInitialMessage stdin separation", () => {
	test("separates trimmed stdin from subsequent prompt and file text when neither has boundary whitespace", () => {
		const promptOnly = buildInitialMessage({
			parsed: createArgs(["Summarize"]),
			stdinContent: "hello",
		});
		assert.equal(promptOnly.initialMessage, "hello\n\nSummarize");

		const withFile = buildInitialMessage({
			parsed: createArgs(["Explain"]),
			stdinContent: "hello",
			fileText: "<file>body</file>\n",
		});
		assert.equal(withFile.initialMessage, "hello\n\n<file>body</file>\nExplain");
	});

	test("does not insert extra newlines when stdin ends with whitespace, next text starts with whitespace, or stdin is empty", () => {
		assert.equal(
			buildInitialMessage({
				parsed: createArgs(["Summarize"]),
				stdinContent: "hello\n",
			}).initialMessage,
			"hello\nSummarize",
		);
		assert.equal(
			buildInitialMessage({
				parsed: createArgs([" and more"]),
				stdinContent: "piped context",
			}).initialMessage,
			"piped context and more",
		);
		assert.equal(
			buildInitialMessage({
				parsed: createArgs(["Summarize"]),
				stdinContent: "",
			}).initialMessage,
			"Summarize",
		);
	});
});

describe("ATOMIC_* over PI_* precedence for EXPERIMENTAL and NO_PTY", () => {
	test("ATOMIC_EXPERIMENTAL=0 overrides PI_EXPERIMENTAL=1", () => {
		vi.stubEnv("ATOMIC_EXPERIMENTAL", "0");
		vi.stubEnv("PI_EXPERIMENTAL", "1");
		assert.equal(areExperimentalFeaturesEnabled(), false);

		vi.stubEnv("ATOMIC_EXPERIMENTAL", "1");
		vi.stubEnv("PI_EXPERIMENTAL", "0");
		assert.equal(areExperimentalFeaturesEnabled(), true);

		vi.stubEnv("ATOMIC_EXPERIMENTAL", undefined);
		vi.stubEnv("PI_EXPERIMENTAL", "1");
		assert.equal(areExperimentalFeaturesEnabled(), true);
	});

	test("ATOMIC_NO_PTY overrides PI_NO_PTY in local bash operations", async () => {
		if (process.platform === "win32") return;
		const dir = createTempDir("atomic-no-pty-");
		vi.stubEnv("ATOMIC_NO_PTY", "1");
		vi.stubEnv("PI_NO_PTY", "0");
		let pipeOutput = "";
		await createLocalBashOperations().exec("[ -t 1 ] && echo tty || echo pipe", dir, {
			pty: true,
			onData: (chunk) => {
				pipeOutput += chunk.toString();
			},
		});
		assert.match(pipeOutput, /pipe/);

		vi.stubEnv("ATOMIC_NO_PTY", "0");
		vi.stubEnv("PI_NO_PTY", "1");
		let ptyOutput = "";
		await createLocalBashOperations().exec("[ -t 1 ] && echo tty || echo pipe", dir, {
			pty: true,
			onData: (chunk) => {
				ptyOutput += chunk.toString();
			},
		});
		assert.match(ptyOutput, /tty/);
	});
});

describe("falsy ATOMIC_OFFLINE and ATOMIC_SKIP_VERSION_CHECK flags", () => {
	test("ATOMIC_OFFLINE=0 and false do not block telemetry, package update checks, or version checks", async () => {
		const checkForPackageUpdates = Reflect.get(InteractiveMode.prototype, "checkForPackageUpdates") as (this: {
			sessionManager: SessionManager;
			settingsManager: SettingsManager;
		}) => Promise<string[]>;
		const reportInstallTelemetry = Reflect.get(InteractiveMode.prototype, "reportInstallTelemetry") as (
			this: { settingsManager: SettingsManager },
			version: string,
		) => void;

		for (const value of ["0", "false"]) {
			vi.stubEnv("ATOMIC_OFFLINE", value);
			vi.stubEnv("PI_OFFLINE", undefined);
			vi.stubEnv("ATOMIC_SKIP_VERSION_CHECK", value);
			vi.stubEnv("PI_SKIP_VERSION_CHECK", undefined);
			vi.stubEnv("ATOMIC_TELEMETRY", "1");

			const fetchMock = vi.fn(async () => Response.json({ version: "9.9.9" }));
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
			const updatesSpy = vi
				.spyOn(DefaultPackageManager.prototype, "checkForAvailableUpdates")
				.mockResolvedValue([{ displayName: "pkg-a", source: "npm:pkg-a" } as never]);

			assert.equal((await getLatestPiRelease())?.version, "9.9.9");
			assert.equal(await checkForNewPiVersion("1.0.0"), "9.9.9");
			reportInstallTelemetry.call({ settingsManager: SettingsManager.inMemory() }, "1.0.0");
			const updates = await checkForPackageUpdates.call({
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory(),
			});

			assert.deepEqual(updates, ["pkg-a"]);
			assert.equal(updatesSpy.mock.calls.length, 1, `expected package update check when flag=${value}`);
			assert.equal(fetchMock.mock.calls.length, 3, `expected network calls when flag=${value}`);
			vi.restoreAllMocks();
		}
	});
});

describe("StorageConfigError CLI handling", () => {
	test("exitOnDecisionConfigError prints StorageConfigError without stack and exits 1", () => {
		const printed: string[] = [];
		const exits: number[] = [];
		const sentinel = new Error("exit");
		const error = new StorageConfigError("cli", "--session-dir", "directory-required");

		assert.throws(
			() =>
				exitOnDecisionConfigError(error, {
					error: (text) => printed.push(text),
					exit: (code) => {
						exits.push(code);
						throw sentinel;
					},
				}),
			(thrown) => thrown === sentinel,
		);
		assert.deepEqual(exits, [1]);
		assert.equal(printed.length, 1);
		assert.match(printed[0] ?? "", /Error: .*--session-dir/);
	});

	test("main catches StorageConfigError from parseArgs for invalid storage flags", async () => {
		const agentDir = createTempDir("atomic-storage-cli-");
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((value?: string) => {
			if (value !== undefined) errors.push(String(value));
		});
		const exitCode: number[] = [];
		const exitSentinel = new Error("process.exit");
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCode.push(code ?? 0);
			throw exitSentinel;
		}) as typeof process.exit);

		for (const argv of [["--session-dir"], ["--session-prefix", "foo"]]) {
			errors.length = 0;
			exitCode.length = 0;
			await assert.rejects(main(argv), (thrown) => thrown === exitSentinel);
			assert.deepEqual(exitCode, [1]);
			assert.equal(errors.length, 1);
			assert.match(errors[0] ?? "", /Error:/);
		}
	});
});

describe("CLI --help and /debug descriptions", () => {
	test("printHelp documents -- as message text and /debug as writing its dump to atomic-debug.log", () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value?: string) => {
			if (value !== undefined) lines.push(String(value));
		});
		printHelp();
		const help = lines.join("\n");
		assert.match(help, /--\s+End option parsing; treat remaining arguments as message text/);
		assert.doesNotMatch(help, /treat remaining arguments as messages\/files/);
		assert.match(help, /atomic-debug\.log, where \/debug writes its render and message dump/);
	});

	test("Debug mode setting description states that /debug writes its dump to atomic-debug.log", () => {
		const callbacks = { onDebugChange: () => {} } as Partial<SettingsCallbacks> as SettingsCallbacks;
		const config = { debug: false, warnings: {} } as Partial<SettingsConfig> as SettingsConfig;
		const item = buildSettingsItems(config, callbacks).find(({ id }) => id === "debug");
		assert.ok(item?.description);
		assert.match(item.description, /~\/\.atomic\/agent\/atomic-debug\.log/);
		assert.match(item.description, /\/debug writes its render and message dump/);
		assert.doesNotMatch(item.description, /\/debug shows/);
	});
});

describe("compactionModel self-validation", () => {
	test("getCompactionModel throws on non-string setting values instead of silently returning empty string", () => {
		const root = createTempDir("atomic-compaction-model-");
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		makeDirectorySync(agentDir, { recursive: true });
		makeDirectorySync(projectDir, { recursive: true });
		writeTextSync(join(agentDir, "settings.json"), JSON.stringify({ compactionModel: 7 }));

		const settings = SettingsManager.create(projectDir, agentDir);
		assert.deepEqual(settings.drainErrors(), []);
		assert.throws(() => settings.getCompactionModel(), /Invalid compactionModel/);
	});
});

describe("case-insensitive :thinking suffixes", () => {
	const catalog: Model<Api>[] = [
		createTestModel({ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" }),
		createTestModel({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }),
	];

	test("resolves uppercase and mixed-case thinking suffixes in references, globs, and fallback entries", () => {
		const exact = resolveModelReference(
			{ text: "anthropic/claude-opus-5:HIGH", thinkingSuffix: "strict", fuzzy: true },
			catalog,
			() => true,
		);
		assert.equal(exact.status, "resolved");
		if (exact.status === "resolved") {
			assert.equal(exact.model.id, "claude-opus-5");
			assert.equal(exact.thinkingLevel, "high");
		}

		const glob = resolveModelScopeFromModels(["claude-*:XHigh"], catalog);
		assert.deepEqual(glob.diagnostics, []);
		assert.deepEqual(
			glob.scopedModels.map(({ model, thinkingLevel }) => `${model.id}:${thinkingLevel}`),
			["claude-opus-5:xhigh", "claude-sonnet-4-5:xhigh"],
		);

		assert.deepEqual(splitFallbackModel("anthropic/claude-opus-5:MEDIUM"), {
			modelId: "anthropic/claude-opus-5",
			thinkingLevel: "medium",
		});
	});
});

describe(".sqlite3 and .db3 selectors in read and search", () => {
	test("isReadResourceSelector recognizes .sqlite3 and .db3 including Windows drive prefixes", () => {
		assert.equal(isReadResourceSelector("data.sqlite3:users"), true);
		assert.equal(isReadResourceSelector("data.db3:users"), true);
		assert.equal(isReadResourceSelector("C:\\data\\app.sqlite3:users"), true);
		assert.equal(isReadResourceSelector("C:/data/app.db3:users"), true);
	});

	test("search tool handles .sqlite3/.db3 databases and treats Windows-prefixed resource selectors as resource selectors", async () => {
		const dir = createTempDir("atomic-sqlite3-search-");
		const { Database } = sqlite();
		for (const fileName of ["store.sqlite3", "store.db3"]) {
			const db = new Database(join(dir, fileName));
			try {
				db.run("create table notes (id integer primary key, body text)");
				db.run("insert into notes values (1, 'needle-value')");
			} finally {
				db.close();
			}
		}

		const searchTool = createSearchToolDefinition(dir);
		for (const target of ["store.sqlite3:notes", "store.db3:notes", `${join(dir, "store.sqlite3")}:notes`]) {
			const result = await searchTool.execute(
				`search-${target}`,
				{ pattern: "needle-value", paths: target },
				undefined,
				undefined,
				{} as never,
			);
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			assert.match(text, /needle-value/);
		}

		const customBackendSearchTool = createSearchToolDefinition(dir, {
			operations: {
				isDirectory: async () => false,
				readFile: async () => "",
			},
		});
		await assert.rejects(
			customBackendSearchTool.execute(
				"missing-sqlite3-in-cwd",
				{ pattern: "needle", paths: `${join(dir, "missing.sqlite3")}:notes` },
				undefined,
				undefined,
				{} as never,
			),
			/Search resource selectors are not supported by this filesystem backend/,
		);
		if (process.platform !== "win32") {
			await assert.rejects(
				customBackendSearchTool.execute(
					"missing-win-sqlite3",
					{ pattern: "needle", paths: "C:\\missing\\app.sqlite3:notes" },
					undefined,
					undefined,
					{} as never,
				),
				/Search resource selectors are not supported by this filesystem backend/,
			);
		}
	});
});

describe("/export argument parsing and case-insensitive .jsonl", () => {
	interface ExportHost {
		session: {
			exportToJsonl: ReturnType<typeof vi.fn<(outputPath: string) => Promise<string>>>;
			exportToHtml: ReturnType<
				typeof vi.fn<(outputPath: string | undefined, options: { themeName?: string }) => Promise<string>>
			>;
		};
		sessionManager: {
			getBranch: () => [];
			getWorktreeSnapshotRecords: () => Map<string, never>;
		};
		showStatus: ReturnType<typeof vi.fn<(message: string) => void>>;
		showError: ReturnType<typeof vi.fn<(message: string) => void>>;
		getPathCommandArgument: (text: string, command: "/export" | "/import") => string | undefined;
	}

	function createExportHost(): ExportHost {
		const getPathCommandArgument = Reflect.get(InteractiveMode.prototype, "getPathCommandArgument") as (
			this: ExportHost,
			text: string,
			command: "/export" | "/import",
		) => string | undefined;
		const host: ExportHost = {
			session: {
				exportToJsonl: vi.fn(async (outputPath: string) => outputPath),
				exportToHtml: vi.fn(async (outputPath: string | undefined) => outputPath ?? "default.html"),
			},
			sessionManager: {
				getBranch: () => [],
				getWorktreeSnapshotRecords: () => new Map<string, never>(),
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			getPathCommandArgument: (text, command) => getPathCommandArgument.call(host, text, command),
		};
		return host;
	}

	const handleExportCommand = Reflect.get(InteractiveMode.prototype, "handleExportCommand") as (
		this: ExportHost,
		text: string,
	) => Promise<void>;

	test("rejects unclosed quotes instead of silently exporting HTML", async () => {
		for (const input of ['/export "foo.jsonl', "/export 'foo.jsonl"]) {
			const host = createExportHost();
			await handleExportCommand.call(host, input);
			assert.equal(host.session.exportToHtml.mock.calls.length, 0);
			assert.equal(host.session.exportToJsonl.mock.calls.length, 0);
			assert.equal(host.showError.mock.calls.length, 1);
			assert.match(host.showError.mock.calls[0]?.[0] ?? "", /Unclosed .* quote/);
		}
	});

	test("exports JSONL case-insensitively for .JSONL paths and keeps bare /export as HTML", async () => {
		const upper = createExportHost();
		await handleExportCommand.call(upper, "/export out.JSONL");
		assert.deepEqual(upper.session.exportToJsonl.mock.calls, [["out.JSONL"]]);
		assert.equal(upper.session.exportToHtml.mock.calls.length, 0);

		const bare = createExportHost();
		await handleExportCommand.call(bare, "/export");
		assert.equal(bare.session.exportToHtml.mock.calls.length, 1);
		assert.equal(bare.showError.mock.calls.length, 0);
	});
});

describe("overflowingBoundary error wording", () => {
	test("reports >= instead of > when post-compaction boundary reaches or exceeds trigger", async () => {
		const root = createTempDir("atomic-overflow-boundary-");
		const agentDir = join(root, "agent");
		makeDirectorySync(agentDir, { recursive: true });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const smallModel = createTestModel({ contextWindow: 20_500 });
		const settingsManager = SettingsManager.inMemory({ compaction: { reserveTokens: 20_000 } });
		const extensionFactory: ExtensionFactory = (atomic) => {
			atomic.on("session_before_compact", () => ({ compactedText: "retained" }));
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			systemPrompt: "x".repeat(3_000),
			extensionFactories: [extensionFactory],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model: smallModel,
			settingsManager,
			sessionManager: SessionManager.inMemory(root),
			resourceLoader,
			builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		try {
			await session.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
			const result = await session.compact();
			assert.equal(result.form, "cleared");
			assert.match(result.fallbackReason ?? "", /output too long for the context \(\d+ >= 500 tokens\)/);
		} finally {
			session.dispose();
		}
	});
});

describe("public exports and extension provider types", () => {
	test("re-exports NativeModuleUnavailableError from package entry", () => {
		const error = new NativeModuleUnavailableError("missing native binary");
		assert.equal(error.name, "NativeModuleUnavailableError");
		assert.equal(error.code, "NativeModuleUnavailable");
		assert.equal(error.message, "missing native binary");
	});

	test("ProviderChatModelConfig and ProviderClassifierModelConfig accept promptCache, samplingParamsByThinkingLevel, and compat", () => {
		const chatModel: ProviderChatModelConfig = {
			id: "custom-chat",
			name: "Custom Chat",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
			promptCache: { short: 300, long: 3_600 },
			samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
		};
		const classifierModel: ProviderClassifierModelConfig = {
			type: "classifier",
			id: "custom-classifier",
			name: "Custom Classifier",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			compat: { imageInput: "assets" },
		};
		assert.equal(chatModel.promptCache?.short, 300);
		assert.equal(classifierModel.compat?.imageInput, "assets");
	});
});

describe("RPC input validation for set_thinking_level and set_scoped_models", () => {
	test("rejects invalid set_thinking_level and malformed set_scoped_models without mutating session", async () => {
		const root = createTempDir("atomic-rpc-validate-");
		const agentDir = join(root, "agent");
		makeDirectorySync(agentDir, { recursive: true });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model: createTestModel(),
			settingsManager,
			sessionManager: SessionManager.inMemory(root),
			resourceLoader,
			builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		try {
			await session.setThinkingLevel("medium");
			const handler = createRpcCommandHandler({
				runtimeHost: {} as never,
				getSession: () => session,
				rebindSession: async () => {},
				output: () => {},
			});

			const badThinking = await handler(
				JSON.parse(
					JSON.stringify({ id: "bad-level", type: "set_thinking_level", level: "bogus", persist: true }),
				) as RpcCommand,
			);
			assert.equal(badThinking?.success, false);
			assert.equal(session.thinkingLevel, "medium");
			assert.equal(settingsManager.getModelThinkingLevel("anthropic", "claude-sonnet-4-5"), undefined);

			const badModels = await handler(
				JSON.parse(
					JSON.stringify({ id: "bad-models", type: "set_scoped_models", models: "not-an-array" }),
				) as RpcCommand,
			);
			assert.equal(badModels?.success, false);

			const badEntry = await handler(
				JSON.parse(JSON.stringify({ id: "bad-entry", type: "set_scoped_models", models: [null] })) as RpcCommand,
			);
			assert.equal(badEntry?.success, false);

			const badEnabled = await handler(
				JSON.parse(
					JSON.stringify({ id: "bad-enabled", type: "set_scoped_models", models: [], enabledModels: [123] }),
				) as RpcCommand,
			);
			assert.equal(badEnabled?.success, false);
			assert.equal(settingsManager.getGlobalSettings().enabledModels, undefined);
		} finally {
			session.dispose();
		}
	});
});

describe("loadSkillsAsync parity with loadSkills", () => {
	test("skips non-skill markdown files without warnings and guards non-string frontmatter fields", async () => {
		const root = createTempDir("atomic-skills-parity-");
		const skillsDir = join(root, "skills");
		makeDirectorySync(join(skillsDir, "valid-skill"), { recursive: true });
		makeDirectorySync(join(skillsDir, "bad-types"), { recursive: true });

		writeTextSync(join(skillsDir, "README.md"), "# Skills\n\nPlain docs without frontmatter.\n");
		writeTextSync(join(skillsDir, "broken.md"), "---\n: [unterminated\n---\nBody\n");
		writeTextSync(
			join(skillsDir, "valid-skill", "SKILL.md"),
			"---\nname: valid-skill\ndescription: Works\n---\nBody\n",
		);
		writeTextSync(join(skillsDir, "bad-types", "SKILL.md"), "---\nname: 123\ndescription: 456\n---\nBody\n");

		const options = { cwd: root, agentDir: join(root, "agent"), skillPaths: [skillsDir], includeDefaults: false };
		const syncResult = loadSkills(options);
		const asyncResult = await loadSkillsAsync(options);

		assert.deepEqual(asyncResult, syncResult);
		assert.deepEqual(
			asyncResult.skills.map((skill) => skill.name),
			["valid-skill"],
		);
		assert.equal(
			asyncResult.diagnostics.some((diagnostic) => diagnostic.path?.endsWith("README.md")),
			false,
		);
		assert.equal(
			asyncResult.diagnostics.some((diagnostic) => diagnostic.path?.endsWith("broken.md")),
			false,
		);
	});
});

describe("theme watcher sourcePath, THEME_KEY_OLD, and hexColorAnsi color mode", () => {
	test("hot-reloads a registered theme outside ~/.atomic/agent/themes with a filename differing from its name", async () => {
		const root = createTempDir("atomic-theme-watch-");
		const projectThemesDir = join(root, "project-themes");
		makeDirectorySync(projectThemesDir, { recursive: true });
		const darkJson = JSON.parse(readTextSync(join(getThemesDir(), "dark.json"), "utf-8")) as {
			name: string;
			colors: Record<string, string | number>;
		};
		const customPath = join(projectThemesDir, "file-name-differs.json");
		const initialThemeJson = {
			...darkJson,
			name: "project-custom",
			colors: { ...darkJson.colors, accent: "#112233" },
		};
		writeTextSync(customPath, JSON.stringify(initialThemeJson));

		const loaded = loadThemeFromPath(customPath, "truecolor");
		setRegisteredThemes([loaded]);
		const watching = vi.spyOn(fsWatch, "watchWithErrorHandlerAsync");
		assert.deepEqual(setTheme("project-custom", true), { success: true });
		assert.equal(theme.getFgAnsi("accent"), "\x1b[38;2;17;34;51m");
		await watching.mock.results.at(-1)?.value;

		const reloaded = new Promise<void>((resolve) => onThemeChange(resolve));
		writeTextSync(
			customPath,
			JSON.stringify({ ...initialThemeJson, colors: { ...initialThemeJson.colors, accent: "#445566" } }),
		);
		await vi.waitFor(() => reloaded, { timeout: 5_000 });
		assert.equal(theme.getFgAnsi("accent"), "\x1b[38;2;68;85;102m");
	});

	test("populates legacy @mariozechner/pi-coding-agent:theme symbol alongside @bastani/atomic:theme", () => {
		initTheme("dark");
		const store = globalThis as Record<symbol, object | undefined>;
		assert.ok(store[Symbol.for("@bastani/atomic:theme")]);
		assert.equal(
			store[Symbol.for("@mariozechner/pi-coding-agent:theme")],
			store[Symbol.for("@bastani/atomic:theme")],
		);
	});

	test("hexColorAnsi respects resolved color mode and NO_COLOR / FORCE_COLOR", () => {
		vi.stubEnv("NO_COLOR", undefined);
		vi.stubEnv("FORCE_COLOR", undefined);
		vi.stubEnv("COLORTERM", "truecolor");
		vi.stubEnv("ATOMIC_TRUE_COLOR", "0");
		refreshColorEnvironment();
		assert.match(hexColorAnsi("#ff0000", "fg"), /^\x1b\[38;5;\d+m$/);

		vi.stubEnv("ATOMIC_TRUE_COLOR", "1");
		refreshColorEnvironment();
		assert.equal(hexColorAnsi("#ff0000", "fg"), "\x1b[38;2;255;0;0m");

		vi.stubEnv("ATOMIC_TRUE_COLOR", undefined);
		vi.stubEnv("PI_TRUE_COLOR", undefined);
		vi.stubEnv("COLORTERM", undefined);
		vi.stubEnv("WT_SESSION", undefined);
		vi.stubEnv("TERM", "dumb");
		refreshColorEnvironment();
		assert.match(hexColorAnsi("#ff0000", "bg"), /^\x1b\[48;5;\d+m$/);

		vi.stubEnv("NO_COLOR", "1");
		refreshColorEnvironment();
		assert.equal(hexColorAnsi("#ff0000", "fg"), "");
	});
});

describe("MCP truncated output hint", () => {
	test("instructs models to read full output using a line range selector instead of offset/limit", async () => {
		const big = Array.from({ length: 3_000 }, (_, index) => `line ${index + 1}`).join("\n");
		const result = await limitMcpContent([{ type: "text", text: big }], async () => "/tmp/mcp-out.txt");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.ok(text.includes("[Full output: /tmp/mcp-out.txt (read it with a line range selector like :1-200)]"));
		assert.equal(text.includes("offset/limit"), false);
	});
});
