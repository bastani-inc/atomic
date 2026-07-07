/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import chalk from "chalk";
import { parseArgs, printHelp } from "./cli/args.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { ENV_OFFLINE, ENV_SESSION_DIR, ENV_SKIP_VERSION_CHECK, ENV_STARTUP_BENCHMARK, expandTildePath, getAgentDir, getEnvValue, setEnvValue, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import { type AgentSessionRuntimeDiagnostic, createAgentSessionFromServices, createAgentSessionServices } from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { getBuiltinPackagePaths } from "./core/builtin-packages.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { resolveModelScope, resolveModelScopeWithDiagnostics } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { resolveProjectTrusted } from "./core/project-trust.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "./core/session-cwd.ts";
import { SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { endTimingSpan, printTimings, resetTimings, startTimingSpan, time } from "./core/timings.ts";
import { hasProjectTrustInputs, ProjectTrustStore } from "./core/trust-manager.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { type AppMode, isPlainRuntimeMetadataCommand, isReadOnlyRuntimeMetadataCommand, prepareInitialMessage, resolveAppMode, resolveCliPaths, resolveExcludedToolsForAppMode, toPrintOutputMode } from "./main-app-mode.ts";
import { computeDeferExtensions, formatScopedModelList } from "./main-deferred-startup.ts";
import { createSessionManager, promptForMissingSessionCwd, validateForkFlags, validateSessionIdFlags } from "./main-session.ts";
import { buildSessionOptions } from "./main-session-options.ts";
import { collectSettingsDiagnostics, drainProcessStdio, isTruthyEnvFlag, readPipedStdin, reportDiagnostics } from "./main-stdio.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { normalizePath } from "./utils/paths.ts";

export type { AppMode } from "./main-app-mode.ts"; export { resolveExcludedToolsForAppMode } from "./main-app-mode.ts";

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
	builtinPackagePaths?: string[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(getEnvValue(ENV_OFFLINE));
	if (offlineMode) {
		setEnvValue(ENV_OFFLINE, "1");
		setEnvValue(ENV_SKIP_VERSION_CHECK, "1");
	}

	if (await handlePackageCommand(args, { extensionFactories: options?.extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		await drainProcessStdio();
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(args, { extensionFactories: options?.extensionFactories })) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			const { exportFromFile } = await import("./core/export-html/index.ts");
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive";
	const shouldRestoreStdoutForMetadata = isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const projectTrustStore = new ProjectTrustStore(agentDir);
	const startupHasTrustInputs = hasProjectTrustInputs(cwd);
	const startupStoredProjectTrust = startupHasTrustInputs ? projectTrustStore.get(cwd) : null;
	const startupGlobalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const startupDefaultProjectTrust = startupGlobalSettingsManager.getDefaultProjectTrust();
	const startupProjectTrusted = parsed.projectTrustOverride ?? startupStoredProjectTrust ?? (!startupHasTrustInputs || startupDefaultProjectTrust === "always");

	// Run migrations after computing startup project trust so project-local migrations
	// cannot read or mutate untrusted project config before approval.
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd, {
		projectTrusted: startupProjectTrusted,
	});
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: startupProjectTrusted });
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = getEnvValue(ENV_SESSION_DIR);
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = parsed.name.trim();
		if (!name) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const sessionCwd = sessionManager.getCwd();
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasProjectTrustInputs(sessionCwd) ? sessionCwd : undefined;

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const builtinPackagePaths = options?.builtinPackagePaths ?? getBuiltinPackagePaths();
	const authStorage = AuthStorage.create();
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	const projectTrustByCwd = new Map<string, boolean>();
	const borrowedExtensionSourceTrustByPath = new Map<string, boolean>();
	// When true, the initial runtime was created without loading extension code so the
	// TUI can paint immediately; InteractiveMode completes the load in the background.
	let deferredExtensionLoad = false;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustInputs = hasProjectTrustInputs(cwd);
		const storedProjectTrust = hasTrustInputs ? projectTrustStore.get(cwd) : null;
		const initialProjectTrusted = parsed.projectTrustOverride ?? cachedProjectTrust ?? storedProjectTrust ?? !hasTrustInputs;
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustInputs;
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: initialProjectTrusted });
		// Defer extension loading to after first paint only when nothing before the TUI
		// starts needs extensions. Model scopes can be resolved again after extensions load.
		const deferExtensions = computeDeferExtensions({
			appMode,
			stdinIsTTY: process.stdin.isTTY === true,
			hasSessionStartEvent: sessionStartEvent !== undefined,
			help: parsed.help,
			listModels: parsed.listModels,
			shouldResolveProjectTrust,
			storedProjectTrust,
			resolvedExtensionPathCount: resolvedExtensionPaths?.length ?? 0,
			resolvedResourcePathCount: (resolvedSkillPaths?.length ?? 0) + (resolvedPromptTemplatePaths?.length ?? 0) + (resolvedThemePaths?.length ?? 0),
			hasSystemPromptInput: parsed.systemPrompt !== undefined || (parsed.appendSystemPrompt?.length ?? 0) > 0,
			unknownFlagCount: parsed.unknownFlags.size,
			provider: parsed.provider,
			model: parsed.model,
		});
		if (sessionStartEvent === undefined) {
			deferredExtensionLoad = deferExtensions;
		}
		const getProjectTrustContext = () =>
			projectTrustContext ??
			createProjectTrustContext({
				cwd,
				mode: sessionStartEvent === undefined ? trustPromptMode : appMode,
				settingsManager: runtimeSettingsManager,
				hasUI: sessionStartEvent === undefined && trustPromptMode === "interactive",
			});
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			settingsManager: runtimeSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions:
				deferExtensions
					? { deferExtensions: true, deferResources: true }
					: shouldResolveProjectTrust || (resolvedExtensionPaths?.length ?? 0) > 0
					? {
							resolveProjectTrust: shouldResolveProjectTrust
								? async ({ extensionsResult }) => {
										const trusted = await resolveProjectTrusted({
											cwd,
											trustStore: projectTrustStore,
											defaultProjectTrust: runtimeSettingsManager.getDefaultProjectTrust(),
											extensionsResult,
											projectTrustContext: getProjectTrustContext(),
											onExtensionError: (message) => console.error(chalk.yellow(`Warning: ${message}`)),
										});
										projectTrustByCwd.set(cwd, trusted);
										if (trusted && !initialProjectTrusted) {
											runMigrations(cwd, { projectTrusted: true });
										}
										return trusted;
									}
								: undefined,
							resolveBorrowedProjectTrust: async ({ source, extensionsResult }) => {
								const cachedTrust = borrowedExtensionSourceTrustByPath.get(source);
								if (cachedTrust !== undefined) {
									return cachedTrust;
								}
								const trusted = await resolveProjectTrusted({
									cwd: source,
									trustStore: projectTrustStore,
									trustOverride: parsed.projectTrustOverride,
									defaultProjectTrust: runtimeSettingsManager.getDefaultProjectTrust(),
									extensionsResult,
									projectTrustContext: getProjectTrustContext(),
									promptMessage: `Trust extension source?\n${source}\n\nThis allows Atomic to load project-local .atomic/.pi resources and .agents/skills from this -e source, including extensions and workflows that can execute code.`,
									onExtensionError: (message) => console.error(chalk.yellow(`Warning: ${message}`)),
								});
								borrowedExtensionSourceTrustByPath.set(source, trusted);
								return trusted;
							},
						}
					: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				builtinPackagePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		const { settingsManager, modelRegistry, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? deferredExtensionLoad
					? (await resolveModelScopeWithDiagnostics(modelPatterns, modelRegistry)).scopedModels
					: await resolveModelScope(modelPatterns, modelRegistry)
				: [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRegistry,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			contextWindow: sessionOptions.contextWindow,
			contextWindowStrict: sessionOptions.contextWindowStrict,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludedTools: resolveExcludedToolsForAppMode(appMode, sessionOptions.excludedTools),
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		if (created.contextWindowWarning) {
			diagnostics.push({ type: "warning", message: created.contextWindowWarning });
		}
		if (created.contextWindowError) {
			diagnostics.push({ type: "error", message: created.contextWindowError });
		}

		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}
		const hasFatalDiagnostics = diagnostics.some((diagnostic) => diagnostic.type === "error");
		if (
			created.session.model &&
			parsed.contextWindow !== undefined &&
			!created.contextWindowError &&
			!hasFatalDiagnostics &&
			!isReadOnlyRuntimeMetadataCommand(parsed)
		) {
			created.session.setContextWindow(parsed.contextWindow, { persistDefault: true });
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntimeFactory");
	const runtimeCreationSpan = startTimingSpan("createAgentSessionRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	endTimingSpan(runtimeCreationSpan);
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRegistry, resourceLoader } = services;
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	if (parsed.help) {
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		if (shouldRestoreStdoutForMetadata) {
			restoreStdout();
		}
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		if (shouldRestoreStdoutForMetadata) {
			restoreStdout();
		}
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	const scopedModels = [...session.scopedModels];
	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(getEnvValue(ENV_STARTUP_BENCHMARK));
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red(`Error: ${ENV_STARTUP_BENCHMARK} only supports interactive mode`));
		process.exit(1);
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			console.log(chalk.dim(`Model scope: ${formatScopedModelList(scopedModels)} ${chalk.gray("(ctrl+p cycle)")}`));
		}

		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			deferredExtensionLoad,
			deferredModelScopePatterns: deferredExtensionLoad ? (parsed.models ?? settingsManager.getEnabledModels()) : undefined,
			deferredModelScopePreserveThinking: parsed.thinking !== undefined,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			await interactiveMode.deferredStartupPromise;
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
