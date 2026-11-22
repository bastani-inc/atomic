import chalk from "chalk";
import { ENV_DEBUG, getAgentDir, setEnvValue } from "../config.js";
import { AuthStorage, ReadOnlyAuthStorage } from "../core/auth-storage.ts";
import { ModelRuntime } from "../core/model-runtime.js";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "../core/output-guard.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { type Args, parseArgs } from "./args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
	hasExplicitCredentialExportTarget,
} from "./auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCheckArgs,
} from "./auth-command.ts";
import { runAuthLogin } from "./auth-login.js";
import { runAuthLogout } from "./auth-logout.js";
import { createProcessLoginTerminal } from "./auth-terminal.js";
import {
	CredentialPrintError,
	emitCredential,
	resolveCredentialForPrint,
	toCredentialPrintError,
	validateCredentialPrintArgs,
} from "./credential-print.ts";

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

export async function runAuthCommand(args: string[]): Promise<boolean> {
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
