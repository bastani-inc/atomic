import { INTERACTIVE_ENGINE_PREWARM_NO_DATABASE } from "./interactive-engine-bootstrap.ts";
import { type InvocationTerminal, isPlainInteractiveSessionInvocation } from "./interactive-invocation.ts";

const METADATA_OR_EXIT_FLAGS = new Set(["-h", "--help", "-v", "--version", "--list-models", "--export"]);

const SUBCOMMANDS = new Set([
	"auth",
	"blueprint",
	"config",
	"install",
	"intercom",
	"list",
	"mcp",
	"remove",
	"storage",
	"team",
	"update",
]);

const VALUE_FLAGS = new Set([
	"--mode",
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--name",
	"-n",
	"--session",
	"--import",
	"--session-id",
	"--fork",
	"--session-dir",
	"--session-store",
	"--session-prefix",
	"--storage",
	"--storage-file",
	"--models",
	"--fallback-models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--export",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--use-theme",
	"--internal-engine-bootstrap",
	"--internal-engine-session-storage",
]);

function isNonSqliteStorageValue(value: string | undefined): boolean {
	if (!value) return false;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return false;
	return (
		trimmed === "memory" ||
		trimmed === "jsonl" ||
		trimmed.startsWith("postgres") ||
		trimmed.startsWith("libsql:") ||
		trimmed.startsWith("http://") ||
		trimmed.startsWith("https://")
	);
}

/**
 * Whether `cli.ts` should warm the spare SQLite worker thread while modules load.
 * Covers prewarmed engines (unless marked no-database), plain interactive sessions,
 * and `-p`/`--print`/`--mode rpc|json|text` runs that may open a SQLite session store.
 */
export function shouldStartSpareDatabaseThread(
	args: readonly string[],
	prewarmedEngine: boolean,
	terminal: InvocationTerminal,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (prewarmedEngine) {
		return args[1] !== INTERACTIVE_ENGINE_PREWARM_NO_DATABASE;
	}
	if (args.length > 0 && SUBCOMMANDS.has(args[0]!)) return false;

	const envStorage = env.ATOMIC_SESSIONS_STORAGE || env.PI_SESSIONS_STORAGE || env.ATOMIC_STORAGE || env.PI_STORAGE;
	if (isNonSqliteStorageValue(envStorage)) return false;

	let hasPrintOrMode = false;
	let storageArg: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--") break;
		if (arg === "--no-session") return false;
		if (METADATA_OR_EXIT_FLAGS.has(arg)) return false;
		if (arg === "-p" || arg === "--print") {
			hasPrintOrMode = true;
			continue;
		}
		if (arg === "--mode") {
			hasPrintOrMode = true;
			if (i + 1 < args.length) i += 1;
			continue;
		}
		if (arg.startsWith("--mode=")) {
			hasPrintOrMode = true;
			continue;
		}
		if (arg === "--storage" && i + 1 < args.length) {
			storageArg = args[++i];
			continue;
		}
		if (arg.startsWith("--storage=")) {
			storageArg = arg.slice("--storage=".length);
			continue;
		}
		if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
			i += 1;
		}
	}

	if (isNonSqliteStorageValue(storageArg)) return false;
	if (hasPrintOrMode) return true;
	return isPlainInteractiveSessionInvocation(args, terminal);
}
