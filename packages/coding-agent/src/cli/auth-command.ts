import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key" | "bearer_token";

export interface AuthCommand {
	kind: AuthCommandKind;
	/** Remaining argv for the normal parser. */
	args: string[];
	json: boolean;
	noRefresh: boolean;
	minExpiryMs?: number;
}

export class AuthCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthCommandError";
	}
}

const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check [--provider <provider>] [--model <model>] [--json] [--no-refresh]`,
	api_key: `${APP_NAME} auth print-api-key --model <model> [--provider <provider>]`,
	bearer_token: `${APP_NAME} auth print-bearer-token --model <model> [--provider <provider>] [--min-expiry <duration>]`,
};

const AUTH_CHECK_INTERNAL_FIELDS: ReadonlySet<string> = new Set([
	"provider",
	"model",
	"messages",
	"fileArgs",
	"unknownFlags",
	"diagnostics",
]);

export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check" ? "auth check" : kind === "api_key" ? "auth print-api-key" : "auth print-bearer-token";
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

export function isAuthCommandHelp(args: string[]): boolean {
	if (args[0] !== "auth") return false;
	if (args[1] === undefined || args[1] === "help" || args[1] === "--help" || args[1] === "-h") return true;
	return args[1] === "check" && (args.includes("--help") || args.includes("-h"));
}

export function printAuthCommandHelp(): void {
	console.error(`Usage:
  ${APP_NAME} auth print-api-key --model <model> [--provider <provider>]
  ${APP_NAME} auth print-bearer-token --model <model> [--provider <provider>] [--min-expiry <duration>]
  ${APP_NAME} auth check [--provider <provider>] [--model <model>] [--json] [--no-refresh]

Credential commands print one configured credential alone on stdout. Everything else —
warnings, provider selection, refresh notices, and help — goes to stderr. --model is
required for credential export, so no ambient model can emit a credential you did not name.

Auth checks require at least one of --provider or --model. They print ready, not_ready,
or invalid on stdout and refresh expired OAuth credentials by default; --no-refresh
prevents a refresh and any auth.json mutation. --json includes the resolved provider,
auth type, and reason when it is not ready.

--min-expiry accepts ms, s, m, or h (for example 30m) and applies only to
print-bearer-token, where it defaults to 30m. A token with less than that
remaining is refreshed first.

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
  2  auth state or command is invalid`);
}

function parseDuration(value: string | undefined): number {
	const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
	if (!match) throw new AuthCommandError("--min-expiry must use a duration such as 30m or 1h");
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

	const commandArgs: string[] = [];
	let json = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		const inlineMinExpiry = arg.startsWith("--min-expiry=") ? arg.slice("--min-expiry=".length) : undefined;
		if (arg === "--min-expiry" || inlineMinExpiry !== undefined) {
			if (kind !== "bearer_token") {
				throw new AuthCommandError("--min-expiry is only supported by print-bearer-token");
			}
			minExpiryMs = parseDuration(inlineMinExpiry ?? args[++index]);
			continue;
		}
		if (arg === "--json" || arg === "--no-refresh") {
			if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
			if (arg === "--json") json = true;
			else noRefresh = true;
			continue;
		}
		commandArgs.push(arg);
	}

	return minExpiryMs === undefined
		? { kind, args: commandArgs, json, noRefresh }
		: { kind, args: commandArgs, json, noRefresh, minExpiryMs };
}

function hasUnsupportedAuthCheckFields(args: Args): boolean {
	for (const [field, value] of Object.entries(args)) {
		if (AUTH_CHECK_INTERNAL_FIELDS.has(field) || value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length > 0) return true;
			continue;
		}
		if (value instanceof Map) {
			if (value.size > 0) return true;
			continue;
		}
		return true;
	}
	return false;
}

export function validateAuthCheckArgs(args: Args): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`Unknown option --${option} for "auth check".`);
	}
	if (
		args.messages.length > 0 ||
		args.fileArgs.length > 0 ||
		args.diagnostics.length > 0 ||
		hasUnsupportedAuthCheckFields(args)
	) {
		throw new AuthCommandError("Auth checks only accept --provider and --model");
	}
	if (!provider && !model) {
		throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
	}
	return { provider, model };
}
