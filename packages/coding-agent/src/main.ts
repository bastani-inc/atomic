import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { drainPendingOAuthRotations, normalizeProviderId } from "@bastani/atomic-ai";
import { setCapabilityOverrides } from "@bastani/atomic-tui";
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
import { runAuthLogin } from "./cli/auth-login.js";
import { runAuthLogout } from "./cli/auth-logout.js";
import { createProcessLoginTerminal } from "./cli/auth-terminal.js";
import {
	CredentialPrintError,
	emitCredential,
	resolveCredentialForPrint,
	toCredentialPrintError,
	validateCredentialPrintArgs,
} from "./cli/credential-print.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext, ignoredProjectSettingsWarning } from "./cli/project-trust.ts";
import {
	ENV_DEBUG,
	ENV_OFFLINE,
	ENV_SESSION_DIR,
	ENV_SKIP_VERSION_CHECK,
	getAgentDir,
	getEnvValue,
	getPackageDir,
	setEnvValue,
	VERSION,
} from "./config.js";
import type { AgentSession } from "./core/agent-session.js";
import { isSessionQuitting } from "./core/agent-session-events.ts";
import type {
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeOptions,
	CreateAgentSessionRuntimeResult,
} from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	type CreateAgentSessionServicesOptions,
	createUnstartedAgentSessionFromServices,
	prepareAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { inheritsDebugSetting, setDebugSetting } from "./core/debug-setting.ts";
import { DEFAULT_THINKING_LEVEL } from "./core/defaults.ts";
import { startEventLoopMonitor, waitForEventLoopMonitorReady } from "./core/event-loop-monitor.ts";
import { recordFactoryAcquisitions } from "./core/extensions/loader-rollback.ts";
import { watchFirstProjectTrustHandler } from "./core/extensions/startup-trust-inventory.ts";
import type { Extension, LoadExtensionsResult } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { markLifecycleTiming } from "./core/lifecycle-timings.ts";
import { limitMandatoryIntercomToTool } from "./core/mandatory-resource-loader.ts";
import { formatModelLabel } from "./core/model-label.ts";
import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "./core/model-refresh-timeout.ts";
import { findInitialModel, resolveModelScopeWithDiagnostics, uncachedCopilotModelHint } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.js";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "./core/output-guard.ts";
import { registerHostStoragePackages } from "./core/package-manager-storage-adapters.js";
import { formatBorrowedExtensionSourceTrustPrompt, resolveProjectTrusted } from "./core/project-trust.ts";
import { engineExtensionsCanDecide, extensionsCanDecideProjectTrust } from "./core/project-trust-electorate.js";
import {
	pendingProjectResourcesTrusted,
	projectTrustedBeforeExtensions,
	startupProjectTrust,
} from "./core/project-trust-state.ts";
import { holdToolsUntilOwnerBuilt, shareBlueprintBuild } from "./core/resume/blueprint/barrier.ts";
import { resumeFailureMessage } from "./core/resume/failure.ts";
import { type ResumeNotice, resumeStoreDir } from "./core/resume/session-resume.ts";
import { recordResumeTimings } from "./core/resume/timings.ts";
import { findMissingSessionCwdIssue, MissingSessionCwdError } from "./core/session-cwd.ts";
import { sessionLifecycleCreation } from "./core/session-lifecycle-scope.ts";
import { ownedSessionManagerStores, ownedSessionStores, sessionLifetime } from "./core/session-lifecycle-work.ts";
import type { SessionManager } from "./core/session-manager.ts";
import { SESSION_ALREADY_OPEN_EXIT_CODE, SessionAlreadyOpenError } from "./core/session-manager-errors.js";
import {
	canIsolateSessionStore,
	projectSettingsChooseSessionStorage,
	takeEngineSessionStorageArg,
} from "./core/session-storage.js";
import { deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { recordStartupThinkingLevel, savedConversationThinkingLevel } from "./core/startup-thinking-level.ts";
import { isTeamProfileError, StorageConfigError } from "./core/storage/errors.js";
import { takeStorageAdoptionNotice } from "./core/storage/file-identity.js";
import { ThreadConnection } from "./core/storage/node-sqlite-thread.js";
import {
	hasProcessStorageSelection,
	processSharedStorageSelection,
	selectProcessStorage,
	setCliStorageSelection,
} from "./core/storage/process-selection.js";
import { endTimingSpan, printTimings, resetTimings, startTimingSpan, time } from "./core/timings.ts";
import { hasProjectTrustInputs, hasProjectTrustInputsAsync, ProjectTrustStore } from "./core/trust-manager.ts";
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
	computeInteractiveEngineResourceDeferral,
	computeStartupInputCaptureEnabled,
	computeStartupTrustPromptPossible,
	formatScopedModelList,
	resolveDeferredStartupModel,
} from "./main-deferred-startup.ts";
import { type EarlyInputCapture, startEarlyInputCapture } from "./main-early-input.ts";
import { runFirstTimeSetup } from "./main-first-time-setup.ts";
import { applyCliRuntimeApiKey } from "./main-runtime-api-key.ts";
import {
	createResumeProgress,
	openCliSession,
	openSessionInCurrentCwdOrExit,
	promptForDirtyCheckout,
	promptForMissingSessionCwd,
	refreshSessionStorage,
	SessionSelectorConflictError,
	startupResumeDiagnostics,
	validateForkFlags,
	validateImportFlags,
	validateSessionIdFlags,
} from "./main-session.ts";
import { buildSessionOptions, unresolvedFallbackModelDiagnostics } from "./main-session-options.ts";
import {
	isStartupBenchmarkError,
	measureInteractiveStartup,
	resolveStartupBenchmark,
} from "./main-startup-benchmark.js";
import {
	collectSettingsDiagnostics,
	drainProcessStdio,
	isTruthyEnvFlag,
	readPipedStdin,
	reportDiagnostics,
	unreadableTrustSettingsDiagnostics,
} from "./main-stdio.ts";
import type { MainOptions } from "./main-types.ts";
import {
	removeSavedModelRoutingSettings,
	removeSavedModelRoutingSettingsAsync,
	runMigrations,
	runMigrationsAsync,
	showDeprecationWarnings,
} from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { shouldUseFullscreenTui } from "./modes/interactive/fullscreen-environment.ts";
import { isUnknownModel } from "./modes/interactive/interactive-mode-helpers.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { createRuntimeForMode } from "./modes/interactive-engine/create-isolated-runtime.ts";
import { startInteractiveEngineLiveness } from "./modes/interactive-engine/engine-child-liveness.ts";
import { IsolatedInteractiveRuntime } from "./modes/interactive-engine/isolated-runtime.js";
import { announceBlueprintBuildWaits } from "./modes/print-mode.ts";
import { ENGINE_SHUTDOWN_GRACE_MS } from "./modes/rpc/rpc-client-process.js";
import { isRpcTransportFailure } from "./modes/rpc/rpc-transport-error.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { canonicalizePath, canonicalizePathAsync } from "./utils/canonical-path.ts";
import { deferDeprecationWarnings, loadShownDeprecationNotices } from "./utils/deprecation.js";
import {
	readInteractiveEngineBootstrap,
	takeInteractiveEngineBootstrapArg,
} from "./utils/interactive-engine-bootstrap.ts";
import { captureInteractiveEngineStartupEnv, isInteractiveEngineChild } from "./utils/interactive-engine-env.ts";
import { NativeModuleUnavailableError, nativeModuleProblem, nativeModuleUnavailable } from "./utils/native-module.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

export type { AppMode } from "./main-app-mode.ts";
export { resolveExcludedToolsForAppMode } from "./main-app-mode.ts";
export type { MainOptions } from "./main-types.ts";

/** The rest of creating a startup runtime once its services are prepared. */
type RuntimeContinuation = () => Promise<CreateAgentSessionRuntimeResult>;

function sessionFallbackModelDiagnostics(
	parsed: Args,
	session: Pick<AgentSession, "settingsManager" | "modelRuntime" | "model">,
): AgentSessionRuntimeDiagnostic[] {
	const model = session.model;
	return unresolvedFallbackModelDiagnostics(
		parsed,
		session.settingsManager,
		session.modelRuntime,
		model && !isUnknownModel(model) ? model.provider : session.settingsManager.getDefaultProvider(),
	);
}

function collectExtensionLoadDiagnostics(
	extensions: LoadExtensionsResult,
	interactive = false,
): AgentSessionRuntimeDiagnostic[] {
	return [
		...extensions.errors.map(({ path, error }) => ({
			type: interactive ? ("warning" as const) : ("error" as const),
			message: `Failed to load extension "${path}": ${error}`,
		})),
		...(extensions.warnings ?? []).map(({ path, warning }) => ({
			type: "warning" as const,
			message: `Extension package "${path}": ${warning}`,
		})),
	];
}

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
async function runAuthLoginCommand(args: string[]): Promise<number> {
	const settingsManager = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });

	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	try {
		return await runAuthLogin(args, {
			modelRuntime,
			terminal: createProcessLoginTerminal(interrupt),
			getDeviceId: () => settingsManager.getOrCreateDeviceId(),
			signal: controller.signal,
		});
	} finally {
		process.off("SIGINT", interrupt);
	}
}

async function runAuthLogoutCommand(args: string[]): Promise<number> {
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	return runAuthLogout(args, {
		modelRuntime,
		terminal: { write: (line) => console.log(line), error: (line) => console.error(line) },
		signal: AbortSignal.timeout(15_000),
	});
}

async function runAuthCommand(args: string[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}
	if (args[0] === "auth" && args[1] === "login") {
		// main() already applied --offline.
		process.exitCode = await runAuthLoginCommand(args.slice(2).filter((arg) => arg !== "--offline"));
		return true;
	}
	if (args[0] === "auth" && args[1] === "logout") {
		process.exitCode = await runAuthLogoutCommand(args.slice(2).filter((arg) => arg !== "--offline"));
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
		if (parsed.debug) setEnvValue(ENV_DEBUG, "1");
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
/**
 * Ends a one-shot command. A model refresh or credential print may have started an OAuth token exchange whose caller
 * already gave up; the provider may have rotated the login, so its result is persisted if it arrives within the bound.
 */
async function exitAfterCommand(): Promise<void> {
	const exitCode = process.exitCode ?? 0;
	await drainPendingOAuthRotations();
	await drainProcessStdio();
	process.exit(exitCode);
}
export async function main(argv: string[], options?: MainOptions) {
	markLifecycleTiming("main-entry");
	// Consume the private engine handshake before anything else: the bootstrap
	// file carries engine role, host PID, guardian path, and any API key, is read
	// once, and is unlinked immediately. Nothing engine-only ever reaches the
	// child's environment, so no descendant of the engine can inherit it — which
	// deleting variables from `process.env` cannot achieve under Bun.
	const bootstrap = takeInteractiveEngineBootstrapArg(argv);
	const { args, sessionStorage } = takeEngineSessionStorageArg(bootstrap.args);
	const engineEnv = captureInteractiveEngineStartupEnv(
		bootstrap.path === undefined ? undefined : readInteractiveEngineBootstrap(bootstrap.path),
	);
	resetTimings();
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	// Whether everything the loader takes for bundled is Atomic's own: no custom builtin packages or bundled factories.
	const onlyAtomicMarksBundled =
		options?.builtinPackagePaths === undefined &&
		!(options?.extensionFactories ?? []).some((input) => typeof input !== "function" && input.bundled === true);
	// The same mapping as applyOfflineEnvironment in utils/startup-environment.ts, which applies it before a prewarmed
	// engine starts. Written here again so that main's code imports no new name from code an earlier session holds.
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(getEnvValue(ENV_OFFLINE));
	if (offlineMode) {
		setEnvValue(ENV_OFFLINE, "1");
		setEnvValue(ENV_SKIP_VERSION_CHECK, "1");
	}
	if (process.platform === "win32") cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	let cwd: string;
	try {
		cwd = process.cwd();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		console.error(
			chalk.red(
				"Error: The current working directory no longer exists. Change to an existing directory and try again.",
			),
		);
		process.exit(1);
	}
	const agentDir = getAgentDir();
	loadShownDeprecationNotices(agentDir);
	// The interactive engine sends its warnings to the host, which shows them, rather than writing them to its stderr.
	if (engineEnv.child === "1") deferDeprecationWarnings();
	// Before the first settings load, so a removed routing setting is not also reported as ignored. When another process
	// holds the file, its migration below tries again, and the load's "ignored" warning waits for that.
	removeSavedModelRoutingSettings(cwd, { retryLater: true });
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	if (!inheritsDebugSetting()) setDebugSetting(bootstrapSettingsManager.getDebug());
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();
	if (await handlePackageCommand(args, { extensionFactories })) {
		await exitAfterCommand();
		return;
	}
	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}
	if (await runAuthCommand(args)) {
		await exitAfterCommand();
		return;
	}
	if (args[0] === "mcp") {
		const { loadMcpCommand } = await import("./extensions/mcp/cli.lazy.js");
		const { runMcpCommand } = await loadMcpCommand();
		process.exitCode = await runMcpCommand(args.slice(1), { cwd, agentDir });
		await drainProcessStdio();
		return;
	}
	if (args[0] === "storage") {
		const { runStorageCommand } = await import("./cli/storage-command.js");
		process.exitCode = await runStorageCommand(args.slice(1), { cwd, agentDir });
		await exitAfterCommand();
		return;
	}
	if (args[0] === "blueprint") {
		const { runBlueprintCommand } = await import("./cli/blueprint-command.js");
		process.exitCode = await runBlueprintCommand(args.slice(1), { cwd, agentDir });
		await exitAfterCommand();
		return;
	}
	if (args[0] === "team") {
		const { runTeamCommand } = await import("./cli/team-command.js");
		process.exitCode = await runTeamCommand(args.slice(1), { cwd, agentDir });
		await exitAfterCommand();
		return;
	}
	if (args[0] === "intercom") {
		const { runIntercomCommand } = await import("./cli/intercom-command.js");
		process.exitCode = await runIntercomCommand(args.slice(1), { agentDir });
		await exitAfterCommand();
		return;
	}
	const parsed = parseArgs(args);
	if (parsed.debug) setEnvValue(ENV_DEBUG, "1");
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
	let isolateInteractiveHost =
		appMode === "interactive" && !isPlainRuntimeMetadataCommand(parsed) && engineEnv.child !== "1";
	const monitorStarted =
		engineEnv.child === "1"
			? startEventLoopMonitor("engine")
			: appMode === "interactive" && !isPlainRuntimeMetadataCommand(parsed)
				? startEventLoopMonitor("host")
				: false;
	if (monitorStarted) await waitForEventLoopMonitorReady();
	let startupBenchmark: boolean;
	try {
		startupBenchmark = resolveStartupBenchmark(appMode, engineEnv);
	} catch (error) {
		if (!isStartupBenchmarkError(error)) throw error;
		console.error(chalk.red(`Error: ${error.message}`));
		process.exit(1);
	}
	const shouldTakeOverStdout = appMode !== "interactive";
	const shouldRestoreStdoutForMetadata = isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout({ nonBlockingPipe: appMode === "rpc" });
	}
	const engineLiveness = engineEnv.child === "1" ? startInteractiveEngineLiveness(writeRawStdout) : undefined;
	engineLiveness?.ready();
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	try {
		validateImportFlags(parsed);
	} catch (error) {
		if (!(error instanceof SessionSelectorConflictError)) throw error;
		console.error(chalk.red(`Error: ${error.message}`));
		process.exit(1);
	}
	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	const projectTrustStore = new ProjectTrustStore(agentDir);
	const startupHasTrustInputs = hasProjectTrustInputs(cwd);
	const startupStoredProjectTrust = startupHasTrustInputs ? projectTrustStore.get(cwd) : null;
	const startupGlobalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const startupDefaultProjectTrust = startupGlobalSettingsManager.getDefaultProjectTrust();
	// Read once from the configuration: whether an extension that loads before a folder's trust is decided could answer
	// `project_trust` ahead of its saved decision. Until the decision, such a folder is not trusted yet (#5693). An engine
	// started for the folder its host checked uses the host's answer, so both decide with the same extensions.
	let extensionsCanDecideTrust: Promise<boolean> | undefined;
	const extensionsCanDecide = (): Promise<boolean> =>
		(extensionsCanDecideTrust ??= engineExtensionsCanDecide(engineEnv.startupExtensionCheck, cwd, () =>
			extensionsCanDecideProjectTrust({
				cliExtensionPaths: parsed.extensions,
				sdkExtensionFactoryCount: options?.extensionFactories?.length ?? 0,
				customBuiltinPackagePaths: options?.builtinPackagePaths,
				noExtensions: parsed.noExtensions === true,
				globalExtensions: startupGlobalSettingsManager.getGlobalSettings().extensions,
				globalPackages: startupGlobalSettingsManager.getGlobalSettings().packages,
				agentDir,
			}),
		));
	const trustedBeforeExtensions = async (folder: { hasTrustInputs: boolean; saved: boolean | null }) => {
		const savedPositive = folder.saved ?? startupDefaultProjectTrust === "always";
		return projectTrustedBeforeExtensions({
			override: parsed.projectTrustOverride,
			hasTrustInputs: folder.hasTrustInputs,
			saved: folder.saved,
			defaultProjectTrust: startupDefaultProjectTrust,
			// Only a folder a saved decision trusts needs the census.
			extensionsCanDecide:
				parsed.projectTrustOverride === undefined && folder.hasTrustInputs && savedPositive
					? await extensionsCanDecide()
					: false,
		});
	};
	// An interactive session (its host and its engine) decides the folder's trust after the extensions load. Print, JSON
	// and RPC runs and metadata commands keep reading the saved decision.
	const interactiveStartup =
		engineEnv.child === "1" ||
		(appMode === "interactive" &&
			!isPlainRuntimeMetadataCommand(parsed) &&
			!parsed.help &&
			parsed.listModels === undefined);
	// An engine started to replace one that stopped carries this session's decisions; one for this folder is final.
	const carriedStartupTrust = Object.entries(engineEnv.trustDecisions?.projects ?? {}).find(
		([path]) => canonicalizePath(path) === canonicalizePath(cwd),
	)?.[1];
	const startupProjectTrusted = interactiveStartup
		? (parsed.projectTrustOverride ??
			carriedStartupTrust ??
			(await trustedBeforeExtensions({ hasTrustInputs: startupHasTrustInputs, saved: startupStoredProjectTrust })))
		: (parsed.projectTrustOverride ??
			startupStoredProjectTrust ??
			(!startupHasTrustInputs || startupDefaultProjectTrust === "always"));
	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions),
		resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	// Storage opens before the extensions load, and may select an adapter by the name of a package passed here.
	registerHostStoragePackages(resolvedExtensionPaths, cwd);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates),
		resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const beginStartupInputCapture = (
		sessionCwd: string,
		sessionSelectionComplete = false,
		deprecationWarningCount = 0,
	): EarlyInputCapture | undefined =>
		startEarlyInputCapture({
			enabled: computeStartupInputCaptureEnabled({
				appMode,
				stdinIsTTY: process.stdin.isTTY === true,
				parsed,
				sessionCwd,
				resolvedExtensionPathCount: resolvedExtensionPaths?.length ?? 0,
				resolvedResourcePathCount:
					(resolvedSkillPaths?.length ?? 0) +
					(resolvedPromptTemplatePaths?.length ?? 0) +
					(resolvedThemePaths?.length ?? 0),
				deprecationWarningCount,
				sessionSelectionComplete,
			}),
		});
	let startupEarlyInputCapture = beginStartupInputCapture(cwd);
	// Run migrations after computing startup project trust so project-local migrations
	// cannot read or mutate untrusted project config before approval.
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd, {
		projectTrusted: startupProjectTrusted,
	});
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: startupProjectTrusted });
	setCapabilityOverrides(startupSettingsManager.getTerminalCapabilityOverrides());
	const startupSettingsDiagnostics = [
		...unreadableTrustSettingsDiagnostics(startupGlobalSettingsManager, parsed.projectTrustOverride),
		...collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"),
	];

	// --use-theme steers this run only: the override lives in the startup
	// manager's effective settings and never reaches its global settings file.
	// The interactive controller applies the same value through
	// initialThemeSetting, so nothing here persists the selection.
	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	if (parsed.help || parsed.listModels !== undefined) {
		const completeServices = await prepareAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: startupSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				builtinPackagePaths: options?.builtinPackagePaths,
				noExtensions: parsed.noExtensions,
				disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				extensionFactories,
			},
		});
		const { modelRuntime, resourceLoader, diagnostics } = await completeServices();
		// Report extension warnings such as a configured package that failed to install, as normal startup does.
		reportDiagnostics(
			deduplicateDiagnostics([
				...startupSettingsDiagnostics,
				...diagnostics,
				...collectExtensionLoadDiagnostics(resourceLoader.getExtensions()),
			]),
		);
		if (shouldRestoreStdoutForMetadata) restoreStdout();
		if (parsed.help) {
			printHelp(
				resourceLoader.getExtensions().extensions.flatMap((extension) => Array.from(extension.flags.values())),
			);
		} else {
			await listModels(
				modelRuntime,
				typeof parsed.listModels === "string" ? parsed.listModels : undefined,
				startupSettingsManager,
			);
		}
		process.exit(0);
	}

	// Process-level storage comes from the launching process, so it is validated before any session
	// starts and is never subject to project trust. An invalid selection prints its message and exits 1.
	try {
		setCliStorageSelection(parsed.storage, cwd);
		selectProcessStorage("shared", agentDir, cwd);
		if (engineEnv.child !== "1") {
			const { assertTeamAdapterInstalled } = await import("./core/storage/team.js");
			await assertTeamAdapterInstalled(agentDir);
		}
	} catch (error) {
		if (!(error instanceof StorageConfigError || isTeamProfileError(error))) throw error;
		console.error(chalk.red(`Error: ${error.message}`));
		process.exit(1);
	}
	// The Intercom broker loads the shared storage adapter in its own process and only logs a failure, so a session
	// warns when this executable cannot load it. Load-only, concurrent with startup; the engine child leaves it to its host.
	const globalStorage = bootstrapSettingsManager.getGlobalSettings().storage;
	const sharedStorageWarning =
		engineEnv.child !== "1" &&
		(processSharedStorageSelection() !== undefined || (globalStorage !== undefined && "adapter" in globalStorage))
			? import("./core/storage/storage-status.js")
					.then(({ checkSharedStorageAdapter }) => checkSharedStorageAdapter(agentDir, globalStorage))
					.catch(() => undefined)
			: undefined;

	const builtinPackagePaths = options?.builtinPackagePaths;
	const trustPromptMode: AppMode = appMode;
	// Decisions made in this host session. An engine the host started to replace one that stopped is handed the
	// decisions of the one it replaces, so nobody is asked twice.
	const projectTrustByCwd = new Map<string, boolean>(Object.entries(engineEnv.trustDecisions?.projects ?? {}));
	const borrowedExtensionSourceTrustByPath = new Map<string, boolean>(
		Object.entries(engineEnv.trustDecisions?.extensionSources ?? {}),
	);
	let deferredExtensionLoad = false;
	let deferredStartupThinkingLevel: ThinkingLevel | undefined;
	let deferredSavedThinkingLevel: ThinkingLevel | undefined;
	const eagerRetrySavedThinkingLevels = new WeakMap<SessionManager, ThinkingLevel | undefined>();
	let forceEagerInteractiveEngineResources = false;
	// Settles once the startup session's own trust decision is made, or will not be: a restored worktree's blueprint
	// build that waits for it starts then (#5693).
	const { promise: startupTrustDecided, resolve: settleStartupTrust } = Promise.withResolvers<void>();
	let startupRuntime: AgentSessionRuntime | undefined;
	// A startup that decides its folder's trust before it opens the session prepares that folder's services first, with
	// only the extensions that can decide it, and binds them to the session it then opens there, so the extensions load
	// once (#5693). A session it opens in another folder gets that folder's own extensions; the ones that decided are
	// shut down first.
	let preparedBeforeOpen:
		| {
				readonly cwd: string;
				readonly bind: (sessionManager: SessionManager) => RuntimeContinuation;
				/**
				 * Shuts the extensions down, waiting up to the bound. Resolves with what was still shutting down then: the
				 * extension whose cleanup had begun, if one had.
				 */
				readonly discard: (
					sessionManager: SessionManager,
				) => Promise<{ readonly extension?: Extension } | undefined>;
		  }
		| undefined;
	// Shown with the resumed session's notices: what the startup folder's extensions left when a session in another folder
	// opened.
	const preOpenNotices: ResumeNotice[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const prepared = preparedBeforeOpen;
		preparedBeforeOpen = undefined;
		if (prepared && options.sessionStartEvent === undefined) {
			if ((await canonicalizePathAsync(options.cwd)) === (await canonicalizePathAsync(prepared.cwd)))
				return prepared.bind(options.sessionManager)();
			const unfinished = await prepared.discard(options.sessionManager);
			if (unfinished) {
				const seconds = Math.round(ENGINE_SHUTDOWN_GRACE_MS / 1000);
				const what = unfinished.extension
					? `Extension "${unfinished.extension.path}" did not`
					: "The extensions that decided its trust did not";
				preOpenNotices.push({
					type: "warning",
					message: `${what} finish shutting down for ${prepared.cwd} within ${seconds} seconds; this session opened without waiting for it.`,
				});
			}
		}
		return (await prepareRuntime(options))();
	};
	const prepareRuntime: NonNullable<CreateAgentSessionRuntimeFactory["prepareResume"]> = async (options) =>
		(await prepareRuntimeServices(options, options.sessionManager))(options.sessionManager);
	const prepareRuntimeServices = async (
		{
			cwd,
			agentDir,
			sessionStartEvent,
			projectTrustContext,
		}: Omit<CreateAgentSessionRuntimeOptions, "sessionManager">,
		// The session these services are for, when it is already open. A startup that decides first binds it later.
		openedSessionManager: SessionManager | undefined,
		decideBeforeOpen = false,
	): Promise<(sessionManager: SessionManager) => RuntimeContinuation> => {
		// Bound when the session opens: at once, or after a startup that decides before it opens one.
		let sessionManager = openedSessionManager as SessionManager;
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustInputs = await hasProjectTrustInputsAsync(cwd);
		const storedProjectTrust = await projectTrustStore.getAsync(cwd);
		const startupTrust = startupProjectTrust({
			override: parsed.projectTrustOverride,
			sessionDecision: cachedProjectTrust,
			saved: storedProjectTrust,
			hasTrustInputs,
		});
		// A saved "Trust" that an extension's project_trust handler could still overturn is not trusted yet (#5693).
		const checkedExtensions =
			startupTrust.decide &&
			interactiveStartup &&
			(storedProjectTrust ?? startupDefaultProjectTrust === "always") === true;
		const extensionsCouldDecide = checkedExtensions && (await extensionsCanDecide());
		const initialProjectTrusted = startupTrust.trusted && !extensionsCouldDecide;
		// A startup that trusted the folder because the check found no extension decides with what the check found: an
		// extension added since then loads after the decision, and does not vote on it.
		const electorateFromStartupCheck = checkedExtensions && !extensionsCouldDecide && sessionStartEvent === undefined;
		const shouldResolveProjectTrust = !isolateInteractiveHost && startupTrust.decide;
		const runtimeSettingsManager = await SettingsManager.createAsync(cwd, agentDir, {
			projectTrusted: initialProjectTrusted,
		});
		let existingSession!: ReturnType<SessionManager["buildSessionContext"]>;
		if (openedSessionManager) existingSession = openedSessionManager.buildSessionContext();
		const deferStartupTrust =
			!decideBeforeOpen &&
			sessionStartEvent === undefined &&
			!isolateInteractiveHost &&
			(trustPromptMode === "interactive" || engineEnv.child === "1") &&
			(shouldResolveProjectTrust || (resolvedExtensionPaths?.length ?? 0) > 0);
		// Only the CLI that prepared these settings owns startup edits. An unbound engine transport need not have
		// any local settings to deliver trust-prompt events.
		if (
			(isolateInteractiveHost && sessionStartEvent === undefined) ||
			(deferStartupTrust && shouldResolveProjectTrust)
		)
			runtimeSettingsManager.trackEditsWhileProjectTrustPending(true);
		let completeStartupReload: (() => Promise<void>) | undefined;
		let startupTrustContext: typeof projectTrustContext;
		// While a deferred startup decision is still to come, the settings read the project untrusted to load only what
		// the decision itself needs. That is no decision, so no one may report it as one.
		let startupTrustPending = deferStartupTrust;
		let hasStartupTrustHook: boolean | undefined;
		let stopWatchingTrustHandlers: (() => void) | undefined;
		const closeTrustInventory = () => {
			stopWatchingTrustHandlers?.();
			stopWatchingTrustHandlers = undefined;
		};
		const resolvedExtensionPathCount = resolvedExtensionPaths?.length ?? 0;
		const hasSystemPromptInput = parsed.systemPrompt !== undefined || (parsed.appendSystemPrompt?.length ?? 0) > 0;
		const resolvedResourcePathCount =
			(resolvedSkillPaths?.length ?? 0) +
			(resolvedPromptTemplatePaths?.length ?? 0) +
			(resolvedThemePaths?.length ?? 0);
		const deferInteractiveEngineResources = computeInteractiveEngineResourceDeferral({
			interactiveEngineChild: engineEnv.child === "1" && !forceEagerInteractiveEngineResources,
			hasSessionStartEvent: sessionStartEvent !== undefined,
			shouldResolveProjectTrust,
			storedProjectTrust,
			resolvedExtensionPathCount,
			resolvedResourcePathCount,
			hasSystemPromptInput,
			unknownFlagCount: parsed.unknownFlags.size,
		});
		const deferExtensions =
			!decideBeforeOpen &&
			!deferStartupTrust &&
			!isolateInteractiveHost &&
			(deferInteractiveEngineResources ||
				computeDeferExtensions({
					appMode,
					stdinIsTTY: process.stdin.isTTY === true,
					hasSessionStartEvent: sessionStartEvent !== undefined,
					help: parsed.help,
					listModels: parsed.listModels,
					shouldResolveProjectTrust,
					storedProjectTrust,
					resolvedExtensionPathCount,
					resolvedResourcePathCount,
					hasSystemPromptInput,
					unknownFlagCount: parsed.unknownFlags.size,
					provider: parsed.provider,
					model: parsed.model,
				}));
		if (sessionStartEvent === undefined) {
			deferredExtensionLoad = deferExtensions || deferStartupTrust;
		}
		const getProjectTrustContext = () =>
			startupTrustContext ??
			projectTrustContext ??
			createProjectTrustContext({
				cwd,
				mode: sessionStartEvent === undefined ? trustPromptMode : appMode,
				settingsManager: runtimeSettingsManager,
				hasUI: sessionStartEvent === undefined && trustPromptMode === "interactive",
			});
		let migrateAfterTrust = false;
		let startupSession: AgentSession | undefined;
		let storageFinalized = false;
		const finalizeStartupStorage = async () => {
			// A decision made before the session opened chose its store; the binding below finishes it.
			if (sessionStartEvent !== undefined || storageFinalized || !sessionManager) return;
			const store = await refreshSessionStorage(sessionManager, parsed, runtimeSettingsManager, sessionStorage);
			if (store && startupSession) {
				ownedSessionManagerStores.delete(sessionManager);
				ownedSessionStores.set(startupSession, store);
			}
			if (parsed.name !== undefined) await sessionManager.appendSessionInfo(parsed.name.trim());
			storageFinalized = true;
		};
		// Only the startup session's own decision opens the build gate, not one made for a folder it did not open.
		const settleBoundStartupTrust = () => {
			if (sessionStartEvent === undefined && sessionManager) settleStartupTrust();
		};
		const serviceOptions: CreateAgentSessionServicesOptions = {
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: deferExtensions
				? { deferExtensions: true, deferResources: true }
				: shouldResolveProjectTrust || (!isolateInteractiveHost && (resolvedExtensionPaths?.length ?? 0) > 0)
					? {
							...(electorateFromStartupCheck
								? { preTrustExtensions: "bundled" as const }
								: decideBeforeOpen && onlyAtomicMarksBundled
									? { preTrustExtensions: "voters" as const }
									: {}),
							deferProjectTrust: deferStartupTrust
								? (complete) => {
										completeStartupReload = complete;
									}
								: undefined,
							onProjectTrustResolved: async () => {
								startupTrustPending = false;
								runtimeSettingsManager.trackEditsWhileProjectTrustPending(false);
								await finalizeStartupStorage();
								engineLiveness?.projectTrustResolved();
								settleBoundStartupTrust();
							},
							resolveProjectTrust: shouldResolveProjectTrust
								? async ({ extensionsResult }) => {
										const trusted = await resolveProjectTrusted({
											cwd,
											trustStore: projectTrustStore,
											defaultProjectTrust: runtimeSettingsManager.getDefaultProjectTrust(),
											extensionsResult,
											projectTrustContext: getProjectTrustContext(),
											onHandlerSnapshot:
												deferStartupTrust && storedProjectTrust === true
													? (hasHandlers) => {
															// Only this snapshot votes; even a handler which removes itself can still decline.
															hasStartupTrustHook ||= hasHandlers;
															closeTrustInventory();
														}
													: undefined,
											onExtensionError: (message) => console.error(chalk.yellow(`Warning: ${message}`)),
										});
										closeTrustInventory();
										projectTrustByCwd.set(cwd, trusted);
										engineLiveness?.trustDecision("projects", cwd, trusted);
										if (trusted && !initialProjectTrusted) {
											migrateAfterTrust = true;
											// Before the project's settings load, so its removed routing settings are not also reported as ignored.
											await removeSavedModelRoutingSettingsAsync(cwd, {
												projectTrusted: true,
												retryLater: true,
											});
										}
										// Print, JSON and RPC modes cannot ask, so say what an untrusted project loses (#4223).
										const ignored = ignoredProjectSettingsWarning(cwd, {
											trusted,
											appMode,
											interactiveEngineChild: engineEnv.child === "1",
										});
										if (ignored) console.error(chalk.yellow(`Warning: ${ignored}`));
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
									promptMessage: formatBorrowedExtensionSourceTrustPrompt(source),
									onExtensionError: (message) => console.error(chalk.yellow(`Warning: ${message}`)),
								});
								borrowedExtensionSourceTrustByPath.set(source, trusted);
								engineLiveness?.trustDecision("extensionSources", source, trusted);
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
				disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: isolateInteractiveHost ? undefined : extensionFactories,
			},
		};
		const completeServices = await prepareAgentSessionServices(
			serviceOptions,
			deferStartupTrust ? () => startupSession !== undefined && isSessionQuitting(startupSession) : undefined,
		);
		const continuation: RuntimeContinuation = async () => {
			if (migrateAfterTrust) await runMigrationsAsync(cwd, { projectTrusted: true });
			const services = await completeServices();
			if (!deferStartupTrust) await finalizeStartupStorage();
			if (isolateInteractiveHost) limitMandatoryIntercomToTool(services.resourceLoader);
			const { settingsManager, modelRuntime, resourceLoader } = services;
			const diagnostics: AgentSessionRuntimeDiagnostic[] = [
				...services.diagnostics,
				...collectSettingsDiagnostics(settingsManager, "runtime creation"),
				...collectExtensionLoadDiagnostics(
					resourceLoader.getExtensions(),
					appMode === "interactive" || engineEnv.child === "1",
				),
			];
			const modelPatterns = isolateInteractiveHost
				? undefined
				: (parsed.models ?? settingsManager.getEnabledModels());
			const deferModelScopeDiagnostics = deferExtensions || deferStartupTrust;
			const { scopedModels, diagnostics: modelScopeDiagnostics } =
				modelPatterns && modelPatterns.length > 0
					? await resolveModelScopeWithDiagnostics(modelPatterns, modelRuntime)
					: { scopedModels: [], diagnostics: [] };
			if (!deferModelScopeDiagnostics) {
				diagnostics.push(...modelScopeDiagnostics);
			}
			const sessionArgs = isolateInteractiveHost
				? { ...parsed, provider: undefined, model: undefined, apiKey: undefined, models: undefined }
				: parsed;
			const sessionContext = sessionManager.buildSessionContext();
			const continuingConversation = sessionContext.messages.length > 0;
			const {
				options: sessionOptions,
				cliThinkingFromModel,
				diagnostics: sessionOptionDiagnostics,
			} = buildSessionOptions(sessionArgs, scopedModels, continuingConversation, modelRuntime, settingsManager);
			if (!deferStartupTrust) diagnostics.push(...sessionOptionDiagnostics);
			const retriedEagerly = eagerRetrySavedThinkingLevels.has(sessionManager);
			const savedThinkingLevel = retriedEagerly
				? eagerRetrySavedThinkingLevels.get(sessionManager)
				: sessionStartEvent === undefined
					? savedConversationThinkingLevel(sessionManager, sessionContext)
					: undefined;
			eagerRetrySavedThinkingLevels.delete(sessionManager);
			if (sessionStartEvent === undefined) {
				deferredStartupThinkingLevel =
					(parsed.thinking !== undefined || cliThinkingFromModel ? sessionOptions.thinkingLevel : undefined) ??
					savedThinkingLevel;
				deferredSavedThinkingLevel = savedThinkingLevel;
			}

			if (parsed.apiKey && !isolateInteractiveHost && !deferStartupTrust) {
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

			const created = await createUnstartedAgentSessionFromServices(
				{
					services,
					sessionManager,
					sessionStartEvent,
					model: sessionOptions.model,
					thinkingLevel:
						sessionOptions.thinkingLevel ??
						(retriedEagerly && continuingConversation && savedThinkingLevel === undefined
							? (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL)
							: undefined),
					scopedModels: sessionOptions.scopedModels,
					fallbackModels: sessionOptions.fallbackModels,
					tools: sessionOptions.tools,
					// The isolated host runs no tools: the engine it starts gets `--no-mcp` and loads the builtins.
					builtins: parsed.noMcp && !isolateInteractiveHost ? { mcp: false } : undefined,
					excludedTools: resolveExcludedToolsForAppMode(appMode, sessionOptions.excludedTools),
					noTools: sessionOptions.noTools,
					customTools: sessionOptions.customTools,
				},
				!isolateInteractiveHost && !deferStartupTrust,
				appMode === "print" &&
					!offlineMode &&
					!parsed.model &&
					!parsed.provider &&
					!parsed.models &&
					!parsed.apiKey,
			);
			startupSession = created.session;
			services.projectTrust = {
				get pending() {
					return startupTrustPending;
				},
				get resourcesTrusted() {
					return pendingProjectResourcesTrusted({
						decide: startupTrust.decide,
						startedTrusted: initialProjectTrusted,
						// Without a session decision when startup began, one in the cache now was made by this startup.
						decided: startupTrust.decide ? projectTrustByCwd.get(cwd) : undefined,
						saved: storedProjectTrust,
						get hasTrustHook() {
							if (hasStartupTrustHook === undefined) {
								const inventory = services.resourceLoader.getExtensions();
								hasStartupTrustHook = inventory.extensions.some(
									(ext) => (ext.handlers.get("project_trust")?.length ?? 0) > 0,
								);
								if (!hasStartupTrustHook && engineEnv.projectResourceWithdrawals && engineLiveness) {
									stopWatchingTrustHandlers = watchFirstProjectTrustHandler(
										inventory,
										sessionLifetime(created.session),
										() => {
											hasStartupTrustHook = true;
											stopWatchingTrustHandlers = undefined;
											engineLiveness.withholdProjectResources(cwd);
										},
									);
								}
							}
							return hasStartupTrustHook;
						},
					});
				},
				abandon() {
					// No decision is coming any more: the session stays as untrusted as its settings read.
					closeTrustInventory();
					startupTrustPending = false;
					runtimeSettingsManager.trackEditsWhileProjectTrustPending(false);
					settleBoundStartupTrust();
				},
				decisions: projectTrustByCwd,
				extensionSourceDecisions: borrowedExtensionSourceTrustByPath,
			};
			if (completeStartupReload) {
				const completeReload = completeStartupReload;
				let completion: Promise<void> | undefined;
				services.completeStartup = (context) =>
					(completion ??= (async () => {
						startupTrustContext = context;
						await completeReload();
						if (migrateAfterTrust) await runMigrationsAsync(cwd, { projectTrusted: true });
						const finalServices = await completeServices();
						const extensionErrors = finalServices.resourceLoader.getExtensions().errors;
						if (extensionErrors.length > 0 && appMode !== "interactive" && engineEnv.child !== "1") {
							throw new Error(
								`Failed to load extensions: ${extensionErrors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`,
							);
						}
						services.resourceLoader = finalServices.resourceLoader;
						services.diagnostics = finalServices.diagnostics;
						finalServices.diagnostics.push(
							...collectExtensionLoadDiagnostics(finalServices.resourceLoader.getExtensions(), true),
						);
						const patterns = parsed.models ?? settingsManager.getEnabledModels();
						const { scopedModels: finalScope, diagnostics: finalScopeDiagnostics } = patterns?.length
							? await resolveModelScopeWithDiagnostics(patterns, modelRuntime)
							: { scopedModels: [], diagnostics: [] };
						finalServices.diagnostics.push(...finalScopeDiagnostics);
						const finalSelection = buildSessionOptions(
							parsed,
							finalScope,
							existingSession.messages.length > 0,
							modelRuntime,
							settingsManager,
						);
						finalServices.diagnostics.push(...finalSelection.diagnostics);
						const finalModel = await resolveDeferredStartupModel({
							selected: finalSelection.options.model,
							isContinuing: existingSession.messages.length > 0,
							savedModel: existingSession.model,
							settingsManager,
							modelRuntime,
						});
						if (parsed.apiKey && finalModel)
							await applyCliRuntimeApiKey(
								modelRuntime,
								finalModel.provider,
								parsed.apiKey,
								AbortSignal.timeout(INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS),
							);
						created.session.setScopedModels(finalScope);
						if (finalModel) {
							const savedModel = existingSession.model;
							if (
								!finalSelection.options.model &&
								existingSession.messages.length > 0 &&
								savedModel &&
								(normalizeProviderId(savedModel.provider) !== normalizeProviderId(finalModel.provider) ||
									savedModel.modelId !== finalModel.id)
							) {
								finalServices.diagnostics.push({
									type: "warning",
									message: `Could not restore model ${formatModelLabel({ provider: savedModel.provider, id: savedModel.modelId })}. Using ${finalModel.provider}/${finalModel.id}`,
								});
							}
							runtime.replaceModelFallback();
							created.session.agent.state.model = finalModel;
							await sessionManager.appendModelChange(finalModel.provider, finalModel.id);
							const continuedThinkingLevel =
								existingSession.messages.length > 0
									? (savedThinkingLevel ?? settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL)
									: undefined;
							await created.session.setThinkingLevel(
								finalSelection.options.thinkingLevel ??
									continuedThinkingLevel ??
									settingsManager.getModelThinkingLevel(finalModel.provider, finalModel.id) ??
									settingsManager.getDefaultThinkingLevel() ??
									DEFAULT_THINKING_LEVEL,
							);
						} else {
							const savedModel = existingSession.model;
							const restoreLabel =
								existingSession.messages.length > 0 && savedModel
									? formatModelLabel({ provider: savedModel.provider, id: savedModel.modelId })
									: undefined;
							const copilotHint =
								restoreLabel && savedModel
									? uncachedCopilotModelHint(savedModel.provider, savedModel.modelId, modelRuntime)
									: undefined;
							const unavailable = copilotHint
								? undefined
								: await findInitialModel({
										scopedModels: [],
										isContinuing: existingSession.messages.length > 0,
										defaultProvider: settingsManager.getDefaultProvider(),
										defaultModelId: settingsManager.getDefaultModel(),
										modelRuntime,
									});
							if (copilotHint) {
								runtime.replaceModelFallback(
									`Could not restore model ${restoreLabel}: ${copilotHint}, or choose another model with /model.`,
									"configured-provider-unsupported",
								);
							} else if (unavailable?.fallbackReason === "configured-provider-unsupported") {
								runtime.replaceModelFallback(unavailable.fallbackMessage, unavailable.fallbackReason);
							} else if (restoreLabel) {
								runtime.replaceModelFallback(`Could not restore model ${restoreLabel}`, "session-restore");
							} else {
								runtime.replaceModelFallback(
									unavailable?.fallbackMessage ?? formatNoModelsAvailableMessage(),
									unavailable?.fallbackReason ?? "no-models-available",
								);
							}
							const finalFallbackMessage = runtime.modelFallbackMessage;
							if (appMode !== "interactive" && finalFallbackMessage) {
								finalServices.diagnostics.push({ type: "warning", message: finalFallbackMessage });
							}
						}
						await recordStartupThinkingLevel(sessionManager, savedThinkingLevel, created.session.thinkingLevel);
						await created.session.completeStartupResources(finalServices.resourceLoader);
						if (appMode !== "interactive") {
							finalServices.diagnostics.push(...sessionFallbackModelDiagnostics(parsed, created.session));
						}
						const completedDiagnostics = deduplicateDiagnostics(finalServices.diagnostics);
						services.diagnostics = completedDiagnostics;
						if (appMode !== "interactive") {
							reportDiagnostics(completedDiagnostics);
						}
					})().catch((error) => {
						completion = undefined;
						// No decision is coming any more: the session stays as untrusted as its settings read.
						closeTrustInventory();
						startupTrustPending = false;
						settleBoundStartupTrust();
						throw error;
					}));
			}
			if (
				deferInteractiveEngineResources &&
				!services.completeStartup &&
				(!created.session.model ||
					isUnknownModel(created.session.model) ||
					created.modelFallbackMessage !== undefined ||
					(!continuingConversation && modelScopeDiagnostics.some((diagnostic) => diagnostic.code === "no-match")))
			) {
				const store = ownedSessionStores.get(created.session);
				if (store) {
					ownedSessionStores.delete(created.session);
					ownedSessionManagerStores.set(sessionManager, store);
				}
				await created.session.dispose();
				forceEagerInteractiveEngineResources = true;
				eagerRetrySavedThinkingLevels.set(sessionManager, savedThinkingLevel);
				return createRuntime({ cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext });
			}
			if (retriedEagerly && continuingConversation) {
				await recordStartupThinkingLevel(sessionManager, savedThinkingLevel, created.session.thinkingLevel);
			}
			const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
			if (!isolateInteractiveHost && created.session.model && cliThinkingOverride) {
				await created.session.setThinkingLevel(created.session.thinkingLevel);
			}
			if (!deferModelScopeDiagnostics && !isolateInteractiveHost) {
				diagnostics.push(...sessionFallbackModelDiagnostics(parsed, created.session));
			}
			return {
				...created,
				services,
				diagnostics,
			};
		};
		return (opened) => {
			if (!openedSessionManager) existingSession = opened.buildSessionContext();
			sessionManager = opened;
			return continuation;
		};
	};
	createRuntime.prepareResume = prepareRuntime;
	time("createRuntimeFactory");
	// A session cannot run without the native module: say why it cannot load and stop, before the session opens (which
	// loads it) and before the interactive host starts its engine.
	const nativeProblem = nativeModuleProblem();
	if (nativeProblem !== undefined) {
		const error = await nativeModuleUnavailable(nativeProblem).catch((failure: unknown) => failure);
		if (!(error instanceof NativeModuleUnavailableError)) throw error;
		startupEarlyInputCapture?.consume();
		console.error(chalk.red(`Error: ${error.message}`));
		// A pipe may not have taken the message yet: exiting now would lose it.
		await drainProcessStdio();
		process.exit(1);
	}
	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// storage selection before loading the selected session's resources.
	// A store selected only by settings can change after trust approval. Explicit
	// CLI/environment selections are already final and retain engine isolation.
	const storagePinned =
		sessionStorage !== undefined ||
		parsed.noSession ||
		parsed.sessionDir !== undefined ||
		parsed.sessionStorePath !== undefined ||
		!!getEnvValue(ENV_SESSION_DIR) ||
		hasProcessStorageSelection("sessions");
	// A saved "Trust" that an extension could still overturn is no decision (#5693). When the folder's own settings
	// choose where its sessions are stored, this process decides the folder's trust itself before it opens one: it keeps
	// the services it decided with for a session it opens in this folder, and a new session waits in the store the
	// global settings choose and moves once the folder is trusted.
	if (
		interactiveStartup &&
		engineEnv.child !== "1" &&
		!storagePinned &&
		parsed.projectTrustOverride === undefined &&
		startupHasTrustInputs &&
		!startupProjectTrusted &&
		(startupStoredProjectTrust ?? startupDefaultProjectTrust === "always") &&
		projectSettingsChooseSessionStorage(cwd, startupGlobalSettingsManager.getGlobalSettings())
	) {
		isolateInteractiveHost = false;
		if (parsed.continue || parsed.resume || parsed.session !== undefined || parsed.fork !== undefined) {
			// The factories the decision runs are recorded, so the ones a session in another folder does not use can be
			// shut down as a failed creation's are.
			const {
				result: bind,
				release,
				rollback,
			} = await recordFactoryAcquisitions(() =>
				sessionLifecycleCreation.run({ scope: {} }, () =>
					prepareRuntimeServices({ cwd, agentDir }, undefined, true),
				),
			);
			preparedBeforeOpen = {
				cwd,
				// The session in this folder keeps them.
				bind: (opened) => {
					release();
					return bind(opened);
				},
				// They shut down before the session's own extensions load, but a cleanup that hangs holds the session back
				// only for as long as a quit waits for one.
				discard: async (opened) => {
					let cleaning: Extension | undefined;
					const shutDown = rollback({ reason: "resume", targetSessionId: opened.getSessionId() }, (extension) => {
						cleaning = extension;
					});
					let bound: NodeJS.Timeout | undefined;
					const failures = await Promise.race([
						shutDown,
						new Promise<undefined>((resolve) => {
							bound = setTimeout(() => resolve(undefined), ENGINE_SHUTDOWN_GRACE_MS);
							bound.unref?.();
						}),
					]);
					clearTimeout(bound);
					// What fails later is part of the shutdown already reported as unfinished.
					if (failures === undefined) return cleaning ? { extension: cleaning } : {};
					for (const failure of failures) console.error(chalk.yellow(`Warning: ${String(failure)}`));
					return undefined;
				},
			};
			await startupSettingsManager.setProjectTrustedAsync(projectTrustByCwd.get(cwd) === true);
		}
	}
	// A restored worktree that the saved decision trusts but an extension could still decline builds only once the
	// session has decided its trust; it builds behind the first turn, and a worktree the session does not decide stays
	// unbuilt (#5693).
	const savedBlueprintTrust = async (root: string): Promise<boolean> =>
		parsed.projectTrustOverride ??
		(await projectTrustStore.getAsync(root)) ??
		startupDefaultProjectTrust === "always";
	const blueprintTrustDecidedLater = async (root: string): Promise<boolean> =>
		interactiveStartup &&
		engineEnv.child !== "1" &&
		parsed.projectTrustOverride === undefined &&
		(await savedBlueprintTrust(root)) &&
		(await extensionsCanDecide());
	const blueprintTrusted = async (root: string): Promise<boolean> => {
		if (!(await blueprintTrustDecidedLater(root))) return savedBlueprintTrust(root);
		const decisions: Readonly<Record<string, boolean>> = isolateInteractiveHost
			? (startupRuntime?.trustDecisions().projects ?? {})
			: Object.fromEntries(projectTrustByCwd);
		const target = await canonicalizePathAsync(root);
		for (const [path, trusted] of Object.entries(decisions)) {
			if ((await canonicalizePathAsync(path)) === target) return trusted;
		}
		return false;
	};
	let sessionManager: SessionManager;
	let worktreeRestoreDiagnostics: readonly ResumeNotice[] = [];
	const startupProgress = createResumeProgress(appMode, engineEnv.child === "1", process.stderr);
	// Without a UI, a resume that waits for another build of its worktree says so while it waits (#4748).
	const stopAnnouncingWaits =
		appMode !== "interactive" && engineEnv.child !== "1"
			? announceBlueprintBuildWaits(appMode !== "print")
			: undefined;
	try {
		const opened = await openCliSession(parsed, cwd, startupSettingsManager, {
			agentDir,
			sessionStorage,
			trusted: blueprintTrusted,
			trustDecidedLater: { applies: blueprintTrustDecidedLater, decided: startupTrustDecided },
			blueprints: engineEnv.child === "1" ? "skip" : "build",
			// Without a UI (-p, json, rpc), the first turn starts while the blueprint build runs (#4748).
			interactive: appMode === "interactive" || engineEnv.child === "1",
			claim: engineEnv.child !== "1",
			progress: startupProgress,
			chooseDirtyCheckout:
				appMode === "interactive" ? (prompt) => promptForDirtyCheckout(prompt, startupSettingsManager) : undefined,
		});
		stopAnnouncingWaits?.();
		if (opened === "cancelled") process.exit(0);
		sessionManager = opened.sessionManager;
		// The session the host started for this engine is the engine's new session, not one it resumed.
		if (engineEnv.startedSessionId !== undefined && sessionManager.getSessionId() === engineEnv.startedSessionId)
			sessionManager.markSessionStarted();
		worktreeRestoreDiagnostics = opened.notices;
		// The host that started this engine may still be building the resumed session's blueprints.
		if (engineEnv.child === "1" && engineEnv.hostPid !== undefined) {
			const resumed = sessionManager;
			holdToolsUntilOwnerBuilt(
				resumeStoreDir(agentDir),
				Number(engineEnv.hostPid),
				resumed.getSessionId(),
				(timings) => recordResumeTimings(resumed, timings),
			);
		}
	} catch (error) {
		// Another live process resumed this session (#5135): nothing was changed.
		const held = error instanceof SessionAlreadyOpenError;
		const message = held ? error.message : resumeFailureMessage(error);
		if (message === undefined) throw error;
		startupEarlyInputCapture?.consume();
		console.error(chalk.red(`Error: ${message}`));
		process.exit(held ? SESSION_ALREADY_OPEN_EXIT_CODE : 1);
	}
	const missingSessionCwdIssue = findMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const choice = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			sessionManager = await openSessionInCurrentCwdOrExit(sessionManager, missingSessionCwdIssue, choice);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = parsed.name.trim();
		if (!name) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			startupEarlyInputCapture?.consume();
			process.exit(1);
		}
	}
	time("createSessionManager");
	markLifecycleTiming("session-opened");
	isolateInteractiveHost &&= canIsolateSessionStore(sessionManager.getSessionStore());

	const sessionCwd = sessionManager.getCwd();
	const selectedProjectTrusted =
		parsed.projectTrustOverride ??
		(hasProjectTrustInputs(sessionCwd) ? projectTrustStore.get(sessionCwd) : true) ??
		startupDefaultProjectTrust === "always";
	isolateInteractiveHost &&= storagePinned || selectedProjectTrusted;
	startupEarlyInputCapture ??= beginStartupInputCapture(sessionCwd, true, deprecationWarnings.length);
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasProjectTrustInputs(sessionCwd) ? sessionCwd : undefined;

	// The engine runs the session's tools, so it waits for a blueprint build this host still runs behind the first turn.
	if (isolateInteractiveHost) await shareBlueprintBuild(resumeStoreDir(agentDir), sessionManager.getSessionId());
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
		appMode === "interactive" || engineEnv.child === "1",
		// When this startup used the check, the engine decides the folder's trust with the extensions it found.
		async () =>
			extensionsCanDecideTrust && {
				cwd: sessionManager.getCwd(),
				extensionsCanDecide: await extensionsCanDecideTrust,
			},
	);
	endTimingSpan(runtimeCreationSpan);
	markLifecycleTiming("runtime-created");
	// The session's database is open by now; a connection thread started for it that nothing took is not needed.
	ThreadConnection.releaseSpare();
	startupRuntime = runtime;
	const settleWhenDecided = () => {
		if (!runtime.isProjectTrustPending()) settleStartupTrust();
	};
	settleWhenDecided();
	if (runtime instanceof IsolatedInteractiveRuntime) runtime.onProjectTrustChanged(settleWhenDecided);
	const { services, session, modelFallbackMessage } = runtime;
	if (engineEnv.child === "1" && services.completeStartup) runtime.replaceModelFallback();
	const { settingsManager, modelRuntime } = services;
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc" && !options?.internalInteractiveHarness) {
		stdinContent = await readPipedStdin({ hasPrompt: parsed.messages.length > 0 || parsed.fileArgs.length > 0 });
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
	time("prepareInitialMessage");
	startupEarlyInputCapture = await runFirstTimeSetup(appMode, settingsManager, startupEarlyInputCapture);
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}
	startupEarlyInputCapture ??= beginStartupInputCapture(sessionCwd, true);

	const scopedModels = [...session.scopedModels];
	time("resolveModelScope");
	const storageWarning = await sharedStorageWarning;
	const storageAdoptionNotice =
		engineEnv.child === "1" ? undefined : takeStorageAdoptionNotice(agentDir, startupSettingsManager.getSettings());
	const startupDiagnostics = deduplicateDiagnostics([
		...startupSettingsDiagnostics,
		...startupResumeDiagnostics(appMode, worktreeRestoreDiagnostics, engineEnv.child === "1"),
		...runtime.diagnostics,
		...(storageAdoptionNotice === undefined ? [] : [{ type: "info" as const, message: storageAdoptionNotice }]),
		...(storageWarning === undefined ? [] : [{ type: "warning" as const, message: storageWarning }]),
	]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) reportDiagnostics(startupDiagnostics);
	if (hasRuntimeErrors) {
		startupEarlyInputCapture?.consume();
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model && !(engineEnv.child === "1" && services.completeStartup)) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
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
		await runRpcMode(runtime, {
			deferInteractiveEngineResources: deferredExtensionLoad,
			onStartupReload: deferredExtensionLoad
				? async (reloadedSession) => {
						const fallbackDiagnostics = sessionFallbackModelDiagnostics(parsed, reloadedSession);
						const patterns = parsed.models ?? reloadedSession.settingsManager.getEnabledModels();
						if (!patterns || patterns.length === 0) {
							reportDiagnostics(fallbackDiagnostics);
							return;
						}
						const { scopedModels: deferredScope, diagnostics: deferredScopeDiagnostics } =
							await resolveModelScopeWithDiagnostics(patterns, reloadedSession.modelRuntime);
						reloadedSession.setScopedModels(deferredScope);
						reportDiagnostics(deduplicateDiagnostics([...deferredScopeDiagnostics, ...fallbackDiagnostics]));
					}
				: undefined,
		});
	} else if (appMode === "interactive") {
		const modelScopeNotice =
			scopedModels.length > 0 && (parsed.verbose || settingsManager.getQuietStartup() === false)
				? `Model scope: ${formatScopedModelList(scopedModels)} (ctrl+p cycle)`
				: undefined;
		// Fullscreen paints on the alternate screen, so a line printed here would stay in the shell after exit
		// (upstream #11508); the interactive mode shows it in the header instead.
		if (modelScopeNotice && !shouldUseFullscreenTui(options?.internalInteractiveHarness?.terminal !== undefined)) {
			console.log(chalk.dim(`Model scope: ${formatScopedModelList(scopedModels)} ${chalk.gray("(ctrl+p cycle)")}`));
		}

		const startupTrustPromptPossible = computeStartupTrustPromptPossible({
			projectTrustOverride: parsed.projectTrustOverride,
			hasTrustInputs: hasProjectTrustInputs(sessionCwd),
			storedProjectTrust: projectTrustStore.get(sessionCwd),
			defaultProjectTrust: startupDefaultProjectTrust,
		});
		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			startupDiagnostics,
			resumeNotices: [...worktreeRestoreDiagnostics, ...preOpenNotices],
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			holdTuiForStartupTrust: isolateInteractiveHost && startupTrustPromptPossible,
			startupTrustPromptPossible,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			modelScopeNotice,
			initialThemeSetting: parsed.useTheme,
			deferredExtensionLoad,
			startupInputCapture: startupEarlyInputCapture,
			deferredModelScopePatterns: deferredExtensionLoad
				? (parsed.models ?? settingsManager.getEnabledModels())
				: undefined,
			deferredStartupThinkingLevel,
			deferredSavedThinkingLevel,
			deferredFallbackModelCheck:
				deferredExtensionLoad && !isolateInteractiveHost
					? (session) => sessionFallbackModelDiagnostics(parsed, session)
					: undefined,
			terminal: options?.internalInteractiveHarness?.terminal,
		});
		options?.internalInteractiveHarness?.onMode?.(interactiveMode);
		try {
			if (startupBenchmark) {
				await measureInteractiveStartup(interactiveMode, runtime);
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
		} catch (error) {
			if (isRpcTransportFailure(error)) {
				stopThemeWatcher();
				// The TUI starts before engine binding marks the mode initialized, so
				// mode.stop() can skip it here. Restore before the CLI prints the error;
				// TUI.stop() also unregisters the last-resort process exit restore.
				interactiveMode.stopInteractiveTui("resume-hint");
			}
			throw error;
		}
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
		// runPrintMode disposed the runtime, which already waited the bounded OAuth drain. A token exchange still
		// running is hung and would keep the process alive, so end it instead of waiting for the provider.
		if (!(await drainPendingOAuthRotations(0))) {
			await drainProcessStdio();
			process.exit(process.exitCode ?? 0);
		}
		return;
	}
}
