/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawn, spawnSync } from "child_process";
import { createChildProcessEnvironment } from "../utils/child-process.ts";
import { getShellConfig, getShellConfigAsync } from "../utils/shell.ts";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();
/** The asynchronous runs of commands not cached yet, so concurrent resolutions run each command once. */
const commandRuns = new Map<string, Promise<string | undefined>>();
// Last observed uncached result, used only for privacy screening, never auth resolution.
const observedCommandResults = new Map<string, string>();
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const LEGACY_ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarName(config: string): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

/** Atomic migration compatibility for pre-template bare environment variable names. */
export function isLegacyEnvVarNameConfigValue(config: string): boolean {
	return LEGACY_ENV_VAR_NAME_RE.test(config);
}
export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/** {@link resolveConfigValue} without blocking the event loop: a command runs asynchronously, with the same cache. */
export async function resolveConfigValueAsync(
	config: string,
	env?: Record<string, string>,
): Promise<string | undefined> {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandAsync(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/** Inspect only known values: never execute a command just to screen routing context. */
export function containsConfiguredValue(serialized: string, config: string, env?: Record<string, string>): boolean {
	const reference = parseConfigValueReference(config);
	const values =
		reference.type === "command"
			? [commandResultCache.get(config), observedCommandResults.get(config)]
			: [
					resolveTemplate(reference.parts, env),
					...getTemplateEnvVarNames(reference.parts).map((name) => resolveEnvConfigValue(name, env)),
				];
	return values.some((value) => {
		if (!value?.trim()) return false;
		const token = authorizationCredential(value);
		return [value, token].some(
			(candidate) => !!candidate && serialized.includes(JSON.stringify(candidate).slice(1, -1)),
		);
	});
}

const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * What `/^(?:Bearer|Basic)\s+(.+)$/i` captures, in one pass: that pattern backtracks quadratically over a long run of
 * whitespace. The credential follows the whitespace after the scheme; when only whitespace follows, it is the last of
 * at least two whitespace characters, as `.+` takes the last one back from `\s+`.
 */
function authorizationCredential(value: string): string | undefined {
	const scheme = /^(?:Bearer|Basic)/i.exec(value);
	if (scheme === null) return undefined;
	let end = scheme[0].length;
	while (end < value.length && /\s/.test(value[end] as string)) end++;
	const whitespace = end - scheme[0].length;
	if (whitespace === 0) return undefined;
	const credential = value.slice(end);
	if (credential.length > 0) {
		for (const character of credential) if (LINE_TERMINATORS.has(character)) return undefined;
		return credential;
	}
	const last = value[end - 1] as string;
	return whitespace >= 2 && !LINE_TERMINATORS.has(last) ? last : undefined;
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: 10000,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
			env: createChildProcessEnvironment(),
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
			env: createChildProcessEnvironment(),
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	const result =
		process.platform === "win32"
			? (() => {
					const configuredResult = executeWithConfiguredShell(command);
					return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
				})()
			: executeWithDefaultShell(command);
	if (result) observedCommandResults.set(commandConfig, result);
	return result;
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/** How long a configured command may run, as for the synchronous resolution. */
const COMMAND_TIMEOUT_MS = 10_000;
/** The output a command may print before it is stopped: the `maxBuffer` the synchronous resolution has. */
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

interface CommandOutcome {
	/** Why the command could not run, or was stopped. */
	readonly error?: NodeJS.ErrnoException;
	/** Its exit status; null when a signal ended it. */
	readonly status: number | null;
	readonly stdout: string;
}

/** Runs `file` as `spawnSync` runs it here, with stderr ignored, without blocking the event loop. */
function runCommand(
	file: string,
	args: readonly string[],
	options: { readonly shell: boolean; readonly windowsHide: boolean; readonly input?: string },
): Promise<CommandOutcome> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let error: NodeJS.ErrnoException | undefined;
		const child = spawn(file, args, {
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
			timeout: COMMAND_TIMEOUT_MS,
			shell: options.shell,
			windowsHide: options.windowsHide,
			env: createChildProcessEnvironment(),
		});
		child.on("error", (failure: NodeJS.ErrnoException) => {
			error ??= failure;
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= MAX_COMMAND_OUTPUT_BYTES) {
				chunks.push(chunk);
				return;
			}
			error ??= Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" });
			child.kill();
		});
		child.on("close", (status) => resolve({ error, status, stdout: Buffer.concat(chunks).toString("utf-8") }));
		if (options.input !== undefined) {
			// A command that exits without reading its input closes the pipe; that is its own outcome.
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.input);
		}
	});
}

async function executeWithConfiguredShellAsync(
	command: string,
): Promise<{ executed: boolean; value: string | undefined }> {
	try {
		const { shell, args, commandTransport } = await getShellConfigAsync();
		const commandFromStdin = commandTransport === "stdin";
		const result = await runCommand(shell, commandFromStdin ? args : [...args, command], {
			shell: false,
			windowsHide: true,
			input: commandFromStdin ? command : undefined,
		});
		if (result.error) {
			return { executed: result.error.code !== "ENOENT", value: undefined };
		}
		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}
		const value = result.stdout.trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

async function executeWithDefaultShellAsync(command: string): Promise<string | undefined> {
	try {
		// `execSync` runs the command through the default shell with stdin ignored, and fails unless it exits with 0.
		const result = await runCommand(command, [], { shell: true, windowsHide: false });
		if (result.error || result.status !== 0) return undefined;
		return result.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function executeCommandUncachedAsync(commandConfig: string): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	let result: string | undefined;
	if (process.platform === "win32") {
		const configuredResult = await executeWithConfiguredShellAsync(command);
		result = configuredResult.executed ? configuredResult.value : await executeWithDefaultShellAsync(command);
	} else {
		result = await executeWithDefaultShellAsync(command);
	}
	if (result) observedCommandResults.set(commandConfig, result);
	return result;
}

/** {@link executeCommand} without blocking the event loop. */
async function executeCommandAsync(commandConfig: string): Promise<string | undefined> {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}
	let run = commandRuns.get(commandConfig);
	if (run === undefined) {
		run = executeCommandUncachedAsync(commandConfig).then((result) => {
			if (commandRuns.get(commandConfig) === run) {
				commandResultCache.set(commandConfig, result);
				commandRuns.delete(commandConfig);
			}
			return result;
		});
		commandRuns.set(commandConfig, run);
	}
	return run;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/** {@link resolveConfigValueUncached} without blocking the event loop. */
export async function resolveConfigValueUncachedAsync(
	config: string,
	env?: Record<string, string>,
): Promise<string | undefined> {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncachedAsync(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const resolvedValue = resolveConfigValueUncached(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}
	throw unresolvedConfigValueError(config, description, env);
}

/** {@link resolveConfigValueOrThrow} without blocking the event loop. */
export async function resolveConfigValueOrThrowAsync(
	config: string,
	description: string,
	env?: Record<string, string>,
): Promise<string> {
	const resolvedValue = await resolveConfigValueUncachedAsync(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}
	throw unresolvedConfigValueError(config, description, env);
}

function unresolvedConfigValueError(config: string, description: string, env?: Record<string, string>): Error {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			return new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			return new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	return new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, env);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** {@link resolveHeadersOrThrow} without blocking the event loop. */
export async function resolveHeadersOrThrowAsync(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = await resolveConfigValueOrThrowAsync(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	observedCommandResults.clear();
	commandRuns.clear();
}
