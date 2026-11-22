import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Args, parseArgs } from "../cli/args.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getEnvNames } from "../config.js";
import { parseConfigCommand } from "../config-command-parser.ts";
import { previewProcessStorageSelection, previewSessionSettingSelection } from "../core/storage/process-selection.js";
import { parsePackageCommand } from "../package-manager-cli-parser.ts";
import { INTERACTIVE_ENGINE_PREWARM_NO_DATABASE } from "./interactive-engine-bootstrap.ts";
import { type InvocationTerminal, isPlainInteractiveSessionInvocation } from "./interactive-invocation.ts";
import { normalizePath } from "./paths.ts";
import { stripBom } from "./text.ts";

const DIRECT_SUBCOMMANDS = new Set(["auth", "mcp", "storage", "blueprint", "team", "intercom"]);

function nonEmptyEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	return value === undefined || value.length === 0 ? undefined : value;
}

function isTopLevelSubcommand(args: readonly string[]): boolean {
	if (args.length === 0) return false;
	if (parsePackageCommand([...args]) !== undefined) return true;
	if (parseConfigCommand(args) !== undefined) return true;
	return DIRECT_SUBCOMMANDS.has(args[0]!);
}

function hasSessionSelectorConflict(parsed: Args): boolean {
	if (
		parsed.import !== undefined &&
		(parsed.session !== undefined ||
			parsed.fork !== undefined ||
			parsed.sessionId !== undefined ||
			parsed.continue ||
			parsed.resume)
	) {
		return true;
	}
	if (
		parsed.fork !== undefined &&
		(parsed.session !== undefined || parsed.continue || parsed.resume || parsed.noSession)
	) {
		return true;
	}
	if (parsed.sessionId !== undefined && (parsed.session !== undefined || parsed.continue || parsed.resume)) {
		return true;
	}
	return false;
}

function resolveAgentDirFromEnv(env: NodeJS.ProcessEnv): string | undefined {
	for (const name of getEnvNames(ENV_AGENT_DIR)) {
		const value = nonEmptyEnv(env, name);
		if (value !== undefined) return normalizePath(value);
	}
	const home = nonEmptyEnv(env, "HOME") ?? nonEmptyEnv(env, "USERPROFILE");
	return home !== undefined ? join(home, CONFIG_DIR_NAME, "agent") : undefined;
}

function settingsSelectSqlite(agentDir: string): boolean {
	let text: string;
	try {
		text = readFileSync(join(agentDir, "settings.json"), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	let raw: unknown;
	try {
		raw = JSON.parse(stripBom(text));
	} catch {
		return true;
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return true;
	const settings = raw as { readonly sessions?: unknown; readonly storage?: unknown };
	if (
		settings.sessions !== undefined &&
		(settings.sessions === null || typeof settings.sessions !== "object" || Array.isArray(settings.sessions))
	) {
		return false;
	}
	const sessionsStorage = (settings.sessions as { readonly storage?: unknown } | undefined)?.storage;
	const value = sessionsStorage !== undefined ? sessionsStorage : settings.storage;
	if (value === undefined) return true;
	const field = sessionsStorage !== undefined ? "sessions.storage" : "storage";
	try {
		return previewSessionSettingSelection(value, field, agentDir).kind === "sqlite";
	} catch {
		return false;
	}
}

/**
 * Whether `cli.ts` should warm the spare SQLite worker thread while modules load.
 * Uses the same subcommand, argument (`parseArgs`), and storage selection
 * (`previewProcessStorageSelection` / `previewSessionSettingSelection`) resolvers
 * as `main`, returning `true` only when the invocation will open a SQLite store.
 */
export function shouldStartSpareDatabaseThread(
	args: readonly string[],
	prewarmedEngine: boolean,
	terminal: InvocationTerminal,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): boolean {
	if (prewarmedEngine) {
		return args[1] !== INTERACTIVE_ENGINE_PREWARM_NO_DATABASE;
	}
	if (isTopLevelSubcommand(args)) return false;

	let parsed: Args;
	try {
		parsed = parseArgs([...args]);
	} catch {
		return false;
	}

	if (parsed.diagnostics.some((d) => d.type === "error")) return false;
	if (parsed.version || parsed.help || parsed.export !== undefined || parsed.listModels !== undefined) return false;
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) return false;
	if (hasSessionSelectorConflict(parsed)) return false;

	const qualifies =
		isPlainInteractiveSessionInvocation(args, terminal) || parsed.print === true || parsed.mode !== undefined;
	if (!qualifies) return false;

	// Mirrors selectSessionStorageBeforeSettingsSteps in core/session-storage.ts.
	if (parsed.sessionStorePath !== undefined) return true;
	if (parsed.noSession) return false;
	if (parsed.sessionDir !== undefined) return false;
	if (nonEmptyEnv(env, "ATOMIC_SESSION_DIR") !== undefined) return false;

	const agentDir = resolveAgentDirFromEnv(env);
	try {
		const processSelection = previewProcessStorageSelection("sessions", {
			cliStorage: parsed.storage,
			env,
			cwd,
			agentDir: agentDir ?? cwd,
		});
		if (processSelection !== undefined) {
			return processSelection.kind === "sqlite";
		}
	} catch {
		return false;
	}

	return agentDir === undefined ? true : settingsSelectSqlite(agentDir);
}
