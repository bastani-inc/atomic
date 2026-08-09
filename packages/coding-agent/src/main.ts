import chalk from "chalk";
import { type Args, parseArgs, printHelp } from "./cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
	hasExplicitCredentialExportTarget,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCheckArgs,
} from "./cli/auth-command.ts";
import {
	CredentialPrintError,
	emitCredential,
	resolveCredentialForPrint,
	toCredentialPrintError,
	validateCredentialPrintArgs,
} from "./cli/credential-print.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import {
	ENV_OFFLINE,
	ENV_SESSION_DIR,
	ENV_SKIP_VERSION_CHECK,
	ENV_STARTUP_BENCHMARK,
	expandTildePath,
	getAgentDir,
	getEnvValue,
	getPackageDir,
	setEnvValue,
	VERSION,
} from "./config.ts";
import type { CreateAgentSessionRuntimeFactory } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { getBuiltinPackagePaths } from "./core/builtin-packages.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "./core/model-refresh-timeout.ts";
import { resolveModelScope, resolveModelScopeWithDiagnostics } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "./core/output-guard.ts";
import { resolveProjectTrusted } from "./core/project-trust.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "./core/session-cwd.ts";
import { SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { endTimingSpan, printTimings, resetTimings, startTimingSpan, time } from "./core/timings.ts";
import { hasProjectTrustInputs, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import {
	type AppMode,
	isPlainRuntimeMetadataCommand,
	prepareInitialMessage,
	resolveAppMode,
	resolveCliPaths,
	resolveExcludedToolsForAppMode,
	shouldStartRpcCatalogRefresh,
	toPrintOutputMode,
} from "./main-app-mode.ts";
import {
	computeDeferExtensions,
	computeStartupInputCaptureEnabled,
	formatScopedModelList,
} from "./main-deferred-startup.ts";
import { type EarlyInputCapture, startEarlyInputCapture } from "./main-early-input.ts";
import { runFirstTimeSetup } from "./main-first-time-setup.ts";
import { applyCliRuntimeApiKey } from "./main-runtime-api-key.ts";
import {
	applyInheritedWorkflowSessionClassification,
	createSessionManager,
	promptForMissingSessionCwd,
	validateForkFlags,
	validateSessionIdFlags,
} from "./main-session.ts";
import { buildSessionOptions } from "./main-session-options.ts";
import {
	collectSettingsDiagnostics,
	drainProcessStdio,
	isTruthyEnvFlag,
	readPipedStdin,
	reportDiagnostics,
} from "./main-stdio.ts";
import type { MainOptions } from "./main-types.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { createRuntimeForMode } from "./modes/interactive-engine/create-isolated-runtime.ts";
import { startInteractiveEngineLiveness } from "./modes/interactive-engine/engine-child-liveness.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import {
	readInteractiveEngineBootstrap,
	takeInteractiveEngineBootstrapArg,
} from "./utils/interactive-engine-bootstrap.ts";
import { captureInteractiveEngineStartupEnv, isInteractiveEngineChild } from "./utils/interactive-engine-env.ts";
import { normalizePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

export type { AppMode } from "./main-app-mode.ts";
export { resolveExcludedToolsForAppMode } from "./main-app-mode.ts";
export type { MainOptions } from "./main-types.ts";

function authCheckErrorMessage(error: unknown): string {
	// Provider and credential-store errors can quote a live credential. Model
	// resolution errors are made only from the named CLI values, so they remain
	// actionable without letting provider-generated text reach stderr.
	return error instanceof AuthCommandError ? error.message : "Failed to check provider readiness";
}

/**
 * `atomic auth …` owns provider-readiness checks and the credential-export
 * door. Its stdout guard routes all ordinary writes to stderr while a command
 * resolves. A readiness result reaches real stdout only as a status record;
 * the opt-in credential branch passes a Secret to emitCredential, the sole
 * code path that can open it and write it to stdout.
 */
async function runAuthCheckCommand(command: AuthCommand, parsed: Args): Promise<void> {
	validateAuthCheckArgs(parsed);
	let result: AuthCheckResult;
	let credentials: AuthStorage | ReadOnlyAuthStorage | undefined;
	let modelRuntime: ModelRuntime | undefined;
	try {
		credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
		modelRuntime = await createAuthCheckModelRuntime(credentials);
		result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh, credentials });
	} catch (error) {
		console.error(chalk.red(`Error: ${authCheckErrorMessage(error)}`));
		result = { status: "invalid", reason: "invalid_state" };
	}

	let credentialEmitted = false;
	if (command.credentials && result.status === "ready" && credentials && modelRuntime) {
		const readyResult = result;
		if (!hasExplicitCredentialExportTarget(parsed, modelRuntime, readyResult.provider)) {
			console.error(chalk.red("Error: Credential export requires --provider or an exact --model target"));
			result = { status: "invalid", provider: readyResult.provider, reason: "invalid_state" };
		} else {
			try {
				const credential = await getProviderCredential(readyResult.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (credential) {
					await emitCredential(
						credential,
						command.json
							? {
									status: readyResult.status,
									provider: readyResult.provider,
									authType: readyResult.authType,
								}
							: undefined,
					);
					credentialEmitted = true;
				} else {
					result = { status: "not_ready", provider: readyResult.provider, reason: "credential_not_available" };
				}
			} catch (error) {
				if (error instanceof CredentialPrintError) throw error;
				// Provider text can quote a credential. Explain the export failure with a
				// constant diagnostic rather than carrying that text into stderr.
				console.error(chalk.red("Error: Failed to resolve credential for export"));
				result = { status: "invalid", provider: readyResult.provider, reason: "invalid_state" };
			}
		}
	}

	if (!credentialEmitted) {
		if (command.credentials && !command.json) {
			// The explicit credential stream is credential-only. A caller assigning
			// it to a shell variable receives no status word on a non-zero exit.
			console.error(result.status);
		} else {
			const output = command.json ? JSON.stringify(result) : result.status;
			writeRawStdout(`${output}\n`);
			await flushRawStdout();
		}
	}
	process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
}
async function runAuthCommand(args: string[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const failure = error instanceof AuthCommandError ? error : new AuthCommandError("Failed to parse auth command");
		console.error(chalk.red(`Error: ${failure.message}`));
		process.exitCode = failure.exitCode;
		return true;
	}
	if (!command) return false;

	takeOverStdout();
	try {
		const parsed = parseArgs(command.args);
		if (command.kind === "check") {
			if (parsed.unknownFlags.size > 0) {
				const option = parsed.unknownFlags.keys().next().value;
				console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
				console.error(chalk.dim(`Use "${getAuthCommandUsage(command.kind)}".`));
				process.exitCode = 2;
				return true;
			}
			const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			if (errors.length > 0) {
				for (const error of errors) console.error(chalk.red(`Error: ${error.message}`));
				process.exitCode = 2;
				return true;
			}
		} else if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			// Preserve the print commands' established parser behavior: any error
			// prints every diagnostic, warnings included, as a guarded stderr error.
			for (const diagnostic of parsed.diagnostics) console.error(chalk.red(`Error: ${diagnostic.message}`));
			process.exitCode = 1;
			return true;
		}

		if (command.kind === "check") {
			try {
				await runAuthCheckCommand(command, parsed);
			} catch (error) {
				if (error instanceof CredentialPrintError) {
					console.error(chalk.red(`Error: ${error.message}`));
					process.exitCode = error.exitCode;
				} else {
					console.error(chalk.red(`Error: ${authCheckErrorMessage(error)}`));
					process.exitCode = 2;
				}
			}
			return true;
		}

		try {
			validateCredentialPrintArgs(parsed);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
			const secret = await resolveCredentialForPrint(parsed, modelRuntime, command.kind, command.minExpiryMs);
			// The Secret arrives unreadable here; emitCredential routes it through
			// credentialPayload, the only source function that can open it.
			await emitCredential(secret, undefined);
		} catch (error) {
			// Every code toCredentialPrintError can produce belongs to a failure
			// that emitted nothing, so the exit code set here never contradicts
			// an empty stdout; a genuinely unclassified error is reported as a
			// credential-resolution failure.
			const failure = toCredentialPrintError(error);
			console.error(chalk.red(`Error: ${failure.message}`));
			process.exitCode = failure.exitCode;
		}
	} finally {
		restoreStdout();
	}
	return true;
}
export async function main(argv: string[], options?: MainOptions) {
	// Consume the private engine handshake before anything else: the bootstrap
	// file carries engine role, host PID, guardian path, and any API key, is read
	// once, and is unlinked immediately. Nothing engine-only ever reaches the
	// child's environment, so no descendant of the engine can inherit it — which
	// deleting variables from `process.env` cannot achieve under Bun.
	const bootstrap = takeInteractiveEngineBootstrapArg(argv);
	const args = bootstrap.args;
	const engineEnv = captureInteractiveEngineStartupEnv(
		bootstrap.path === undefined ? undefined : readInteractiveEngineBootstrap(bootstrap.path),
	);
	resetTimings();
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(getEnvValue(ENV_OFFLINE));
	if (offlineMode) {
		setEnvValue(ENV_OFFLINE, "1");
		setEnvValue(ENV_SKIP_VERSION_CHECK, "1");
	}
	if (process.platform === "win32") cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	const cwd = process.cwd(),
		agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();
	if (await handlePackageCommand(args, { extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		await drainProcessStdio();
		process.exit(exitCode);
		return;
	}
	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}
	if (await runAuthCommand(args)) {
		const exitCode = process.exitCode ?? 0;
		await drainProcessStdio();
		process.exit(exitCode);
		return;
	}
	const parsed = parseArgs(args);
	if (engineEnv.child === "1" && engineEnv.apiKey) parsed.apiKey = engineEnv.apiKey;
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
	let appMode = options?.internalInteractiveHarness?.forceInteractive
		? "interactive"
		: resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const isolateInteractiveHost =
		appMode === "interactive" && !isPlainRuntimeMetadataCommand(parsed) && engineEnv.child !== "1";
	const shouldTakeOverStdout = appMode !== "interactive";
	const shouldRestoreStdoutForMetadata = isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}
	if (engineEnv.child === "1") startInteractiveEngineLiveness(writeRawStdout).ready();
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	const projectTrustStore = new ProjectTrustStore(agentDir);
	const startupHasTrustInputs = hasProjectTrustInputs(cwd);
	const startupStoredProjectTrust = startupHasTrustInputs ? projectTrustStore.get(cwd) : null;
	const startupGlobalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const startupDefaultProjectTrust = startupGlobalSettingsManager.getDefaultProjectTrust();
	const startupProjectTrusted =
		parsed.projectTrustOverride ??
		startupStoredProjectTrust ??
		(!startupHasTrustInputs || startupDefaultProjectTrust === "always");
	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions),
		resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates),
		resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	let startupEarlyInputCapture: EarlyInputCapture | undefined = startEarlyInputCapture({
		enabled: computeStartupInputCaptureEnabled({
			appMode,
			stdinIsTTY: process.stdin.isTTY === true,
			parsed,
			sessionCwd: cwd,
			projectTrustStore,
			resolvedExtensionPathCount: resolvedExtensionPaths?.length ?? 0,
			resolvedResourcePathCount:
				(resolvedSkillPaths?.length ?? 0) +
				(resolvedPromptTemplatePaths?.length ?? 0) +
				(resolvedThemePaths?.length ?? 0),
			deprecationWarningCount: 0,
		}),
	});
	// Run migrations after computing startup project trust so project-local migrations
	// cannot read or mutate untrusted project config before approval.
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd, {
		projectTrusted: startupProjectTrusted,
	});
	time("runMigrations");
	if (deprecationWarnings.length > 0) {
		startupEarlyInputCapture?.consume();
		startupEarlyInputCapture = undefined;
	}

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
	let sessionManager = applyInheritedWorkflowSessionClassification(
		await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager),
	);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		startupEarlyInputCapture?.consume();
		startupEarlyInputCapture = undefined;
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

	const builtinPackagePaths = options?.builtinPackagePaths ?? getBuiltinPackagePaths();
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	const projectTrustByCwd = new Map<string, boolean>();
	const borrowedExtensionSourceTrustByPath = new Map<string, boolean>();
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
		const initialProjectTrusted =
			parsed.projectTrustOverride ?? cachedProjectTrust ?? storedProjectTrust ?? !hasTrustInputs;
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustInputs;
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: initialProjectTrusted });
		const deferExtensions = isolateInteractiveHost
			? false
			: computeDeferExtensions({
					appMode,
					stdinIsTTY: process.stdin.isTTY === true,
					hasSessionStartEvent: sessionStartEvent !== undefined,
					help: parsed.help,
					listModels: parsed.listModels,
					shouldResolveProjectTrust,
					storedProjectTrust,
					resolvedExtensionPathCount: resolvedExtensionPaths?.length ?? 0,
					resolvedResourcePathCount:
						(resolvedSkillPaths?.length ?? 0) +
						(resolvedPromptTemplatePaths?.length ?? 0) +
						(resolvedThemePaths?.length ?? 0),
					hasSystemPromptInput: parsed.systemPrompt !== undefined || (parsed.appendSystemPrompt?.length ?? 0) > 0,
					unknownFlagCount: parsed.unknownFlags.size,
					provider: parsed.provider,
					model: parsed.model,
				});
		if (sessionStartEvent === undefined) {
			deferredExtensionLoad = deferExtensions;
			startupEarlyInputCapture ??= startEarlyInputCapture({
				enabled: deferExtensions && deprecationWarnings.length === 0,
			});
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
			settingsManager: runtimeSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: deferExtensions
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
				additionalExtensionPaths: isolateInteractiveHost ? undefined : resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				builtinPackagePaths,
				noExtensions: isolateInteractiveHost || parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: isolateInteractiveHost ? undefined : extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];
		const modelPatterns = isolateInteractiveHost ? undefined : (parsed.models ?? settingsManager.getEnabledModels());
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? deferredExtensionLoad
					? (await resolveModelScopeWithDiagnostics(modelPatterns, modelRuntime)).scopedModels
					: await resolveModelScope(modelPatterns, modelRuntime)
				: [];
		const sessionArgs = isolateInteractiveHost
			? { ...parsed, provider: undefined, model: undefined, apiKey: undefined, models: undefined }
			: parsed;
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			sessionArgs,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey && !isolateInteractiveHost) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				// Bound the complete CLI key operation—from credential mutation through
				// provider-scoped catalog refresh—with the established model-refresh budget.
				const apiKeySignal = AbortSignal.timeout(INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS);
				await applyCliRuntimeApiKey(modelRuntime, sessionOptions.model.provider, parsed.apiKey, apiKeySignal);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludedTools: resolveExcludedToolsForAppMode(appMode, sessionOptions.excludedTools),
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}
		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntimeFactory");
	const runtimeCreationSpan = startTimingSpan("createAgentSessionRuntime");
	const runtime = await createRuntimeForMode(
		createRuntime,
		sessionManager.getCwd(),
		agentDir,
		sessionManager,
		isolateInteractiveHost,
		(options?.extensionFactories?.length ?? 0) > 0,
		parsed,
		{
			extensions: resolvedExtensionPaths,
			skills: resolvedSkillPaths,
			promptTemplates: resolvedPromptTemplatePaths,
			themes: resolvedThemePaths,
		},
	);
	endTimingSpan(runtimeCreationSpan);
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
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
		await listModels(modelRuntime, searchPattern);
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc" && !options?.internalInteractiveHarness) {
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
	startupEarlyInputCapture = await runFirstTimeSetup(appMode, settingsManager, startupEarlyInputCapture);
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
		startupEarlyInputCapture?.consume();
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		startupEarlyInputCapture?.consume();
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(getEnvValue(ENV_STARTUP_BENCHMARK));
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red(`Error: ${ENV_STARTUP_BENCHMARK} only supports interactive mode`));
		startupEarlyInputCapture?.consume();
		process.exit(1);
	}

	if (appMode === "rpc") {
		// Standalone RPC preserves its eager catalog refresh. The isolated
		// interactive engine does not: /model owns its bounded refresh, while an
		// eager unbounded refresh can hold credential locks and lend its in-flight
		// promise to later cache-only or timed refreshes.
		if (shouldStartRpcCatalogRefresh(offlineMode, isInteractiveEngineChild())) {
			void modelRuntime.refresh().catch(() => {});
		}
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
			startupInputCapture: startupEarlyInputCapture,
			deferredModelScopePatterns: deferredExtensionLoad
				? (parsed.models ?? settingsManager.getEnabledModels())
				: undefined,
			deferredModelScopePreserveThinking: parsed.thinking !== undefined,
			terminal: options?.internalInteractiveHarness?.terminal,
		});
		options?.internalInteractiveHarness?.onMode?.(interactiveMode);
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			await interactiveMode.ensureDeferredStartupComplete();
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
