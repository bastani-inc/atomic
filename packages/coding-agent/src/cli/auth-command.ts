import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key" | "bearer_token";

export interface AuthCommand {
	kind: AuthCommandKind;
	/** Remaining argv for the normal parser. */
	args: string[];
	json: boolean;
	/** `auth check` emits a resolved credential only with this explicit opt-in. */
	credentials: boolean;
	noRefresh: boolean;
	minExpiryMs?: number;
}

export class AuthCommandError extends Error {
	// Declared and assigned explicitly rather than as a constructor parameter
	// property: `tsconfig.base.json` sets `erasableSyntaxOnly`, under which a
	// parameter property is TS1294. Root `tsc --noEmit` does not surface it,
	// but the shipped build does.
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
		this.name = "AuthCommandError";
	}
}

const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]`,
	api_key: `${APP_NAME} auth print-api-key --model <model> [--provider <provider>]`,
	bearer_token: `${APP_NAME} auth print-bearer-token --model <model> [--provider <provider>] [--min-expiry <duration>]`,
};

export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check" ? "auth check" : kind === "api_key" ? "auth print-api-key" : "auth print-bearer-token";
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

export function isAuthCommandHelp(args: string[]): boolean {
	if (args[0] !== "auth") return false;
	if (args[1] === undefined || args[1] === "help" || args[1] === "--help" || args[1] === "-h") return true;
	const terminator = args.indexOf("--", 2);
	const flags = args.slice(2, terminator === -1 ? undefined : terminator);
	// Checks accept direct help flags. The print commands reserve every extra
	// parser flag, including --help, as a usage error to keep their export stream narrow.
	return args[1] === "check" && (flags.includes("--help") || flags.includes("-h"));
}

export function printAuthCommandHelp(): void {
	console.error(`Usage:
  ${APP_NAME} auth print-api-key --model <model> [--provider <provider>]
  ${APP_NAME} auth print-bearer-token --model <model> [--provider <provider>] [--min-expiry <duration>]
  ${APP_NAME} auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

Credential print commands write one configured credential alone on stdout. Everything else —
warnings, provider selection, refresh notices, and help — goes to stderr. --model is
required for these exports, so no ambient model can emit a credential you did not name.

Auth checks require at least one of --provider or --model. They print ready, not_ready,
or invalid on stdout and refresh expired OAuth credentials by default; --no-refresh
prevents a refresh and any auth.json mutation. --json includes the resolved provider
when one is found, plus auth type and a reason when it is not ready. --credentials is
an explicit export that needs --provider or an exact --model target; on a ready check
it writes the credential, or includes it in JSON. A non-ready raw export leaves stdout
empty and reports status on stderr.

--min-expiry accepts ms, s, m, or h (for example 30m) and applies only to
print-bearer-token, where it defaults to 30m. A token with less than that
remaining is refreshed first. It remains reserved after --, so print-api-key
still rejects it in either spelling.

Credential-export exit codes:
  0  credential written to stdout
  1  usage error
  2  no credential configured
  3  provider ambiguous
  4  credential kind unsupported for that provider
  5  refresh failed (the stored credential is left untouched)
  6  provider cannot mint a token that lives long enough
  7  the provider's OAuth credential could not be used
  8  the credential could not be written (nothing was emitted)
  9  the credential was written only in part; stdout holds an unusable
     fragment, which the caller must discard rather than use

Auth-check exit codes:
  0  provider is ready
  1  provider is not ready
  2  auth state or command is invalid
  8  with --credentials, the credential could not be written
  9  with --credentials, only part of the credential was written`);
}

function parseDuration(value: string | undefined, exitCode: number): number {
	const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
	if (!match) throw new AuthCommandError("--min-expiry must use a duration such as 30m or 1h", exitCode);
	const unit = match[2].toLowerCase();
	const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	return Number(match[1]) * scale;
}

/** Parse the `atomic auth` command surface before normal startup. */
export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind: AuthCommandKind | undefined =
		args[1] === "check"
			? "check"
			: args[1] === "print-api-key"
				? "api_key"
				: args[1] === "print-bearer-token"
					? "bearer_token"
					: undefined;
	if (!kind) {
		throw new AuthCommandError(
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_NAME} auth print-api-key", "${APP_NAME} auth print-bearer-token", or "${APP_NAME} auth check".`,
		);
	}

	const exitCode = kind === "check" ? 2 : 1;
	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	let optionsEnded = false;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			optionsEnded = true;
			commandArgs.push(arg);
			continue;
		}
		const inlineMinExpiry = arg.startsWith("--min-expiry=") ? arg.slice("--min-expiry=".length) : undefined;
		if (arg === "--min-expiry" || inlineMinExpiry !== undefined) {
			if (kind !== "bearer_token") {
				throw new AuthCommandError("--min-expiry is only supported by print-bearer-token", exitCode);
			}
			minExpiryMs = parseDuration(inlineMinExpiry ?? args[++index], exitCode);
			continue;
		}
		if (!optionsEnded && (arg === "--json" || arg === "--credentials" || arg === "--no-refresh")) {
			if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`, exitCode);
			if (arg === "--json") json = true;
			else if (arg === "--credentials") credentials = true;
			else noRefresh = true;
			continue;
		}
		commandArgs.push(arg);
	}

	return minExpiryMs === undefined
		? { kind, args: commandArgs, json, credentials, noRefresh }
		: { kind, args: commandArgs, json, credentials, noRefresh, minExpiryMs };
}

export function validateAuthCheckArgs(args: Args): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`Unknown option --${option} for "auth check".`);
	}
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError("Auth checks only accept --provider and --model");
	}
	if (!provider && !model) {
		throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
	}
	return { provider, model };
}
