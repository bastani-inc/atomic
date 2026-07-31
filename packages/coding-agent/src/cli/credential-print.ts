/**
 * `atomic auth print-api-key` / `atomic auth print-bearer-token`.
 *
 * The only door in Atomic whose purpose is emitting a secret. Everything here
 * exists to keep that egress narrow:
 *
 * - the secret leaves as a `Secret`, which cannot be interpolated, serialized,
 *   or inspected, and is consumed exactly once by the stdout writer;
 * - `--model` is required, so no ambient "current model" can emit a credential
 *   the caller did not name;
 * - there is no `--output <file>` and no clipboard path — stdout only;
 * - every failure is a distinct exit code, and stdout stays empty on all of them;
 * - a failed OAuth refresh never mutates the stored credential.
 */

import { inspect } from "node:util";
import type { Api, CredentialInfo, Model } from "@earendil-works/pi-ai";
import { ModelsError } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";

export type CredentialPrintKind = "api_key" | "bearer_token";

/** Bearer tokens are refreshed unless they still have this much life left. */
export const DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS = 30 * 60_000;

/**
 * Failure taxonomy. Each member owns one exit code, so a caller can branch on
 * the status without parsing stderr.
 */
export type CredentialPrintErrorCode =
	| "Usage"
	| "NoCredentialConfigured"
	| "ProviderAmbiguous"
	| "KindUnsupportedForProvider"
	| "RefreshFailed"
	| "MinValidityUnreachable";

const EXIT_CODES: Record<CredentialPrintErrorCode, number> = {
	Usage: 1,
	NoCredentialConfigured: 2,
	ProviderAmbiguous: 3,
	KindUnsupportedForProvider: 4,
	RefreshFailed: 5,
	MinValidityUnreachable: 6,
};

export class CredentialPrintError extends Error {
	readonly code: CredentialPrintErrorCode;
	readonly exitCode: number;

	constructor(code: CredentialPrintErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CredentialPrintError";
		this.code = code;
		this.exitCode = EXIT_CODES[code];
	}
}

/**
 * A credential in transit.
 *
 * Every path that would copy the value into a string is closed: `toString`,
 * `toJSON`, and `Symbol.toPrimitive` throw rather than return, so a template
 * literal, `JSON.stringify`, or string concatenation fails loudly instead of
 * leaking into a log line, a transcript, or an error message. `inspect` — which
 * `console.log` and Node's error formatting use — renders a placeholder.
 *
 * `take()` is the single exit, and it works once.
 */
export class Secret {
	#value: string | undefined;

	constructor(value: string) {
		this.#value = value;
	}

	/** Consume the secret. A second call is a bug, not a second read. */
	take(): string {
		const value = this.#value;
		if (value === undefined) {
			throw new Error("Secret has already been consumed");
		}
		this.#value = undefined;
		return value;
	}

	toString(): never {
		throw new Error("A Secret cannot be converted to a string; use take()");
	}

	toJSON(): never {
		throw new Error("A Secret cannot be serialized; use take()");
	}

	[Symbol.toPrimitive](): never {
		throw new Error("A Secret cannot be interpolated; use take()");
	}

	[inspect.custom](): string {
		return "[Secret]";
	}
}

export interface CredentialPrintCommand {
	kind: CredentialPrintKind;
	/** Remaining argv for the normal parser (`--model`, `--provider`). */
	args: string[];
	minExpiryMs?: number;
}

export function isCredentialPrintHelp(args: string[]): boolean {
	return (
		args[0] === "auth" && (args[1] === undefined || args[1] === "help" || args[1] === "--help" || args[1] === "-h")
	);
}

export function printCredentialPrintHelp(): void {
	// Branded through APP_NAME: Atomic's binary is `atomic`, and help output must
	// never render upstream's `pi`.
	console.error(`Usage:
  ${APP_NAME} auth print-api-key --model <model> [--provider <provider>]
  ${APP_NAME} auth print-bearer-token --model <model> [--provider <provider>] [--min-expiry <duration>]

Prints one configured credential alone on stdout. Everything else — warnings,
provider selection, refresh notices — goes to stderr, and stdout stays empty on
any failure.

--model is required: there is no ambient "current model". Provider inference
uses configured credentials; pass --provider to select one explicitly.

--min-expiry accepts ms, s, m, or h (for example 30m) and applies only to
print-bearer-token, where it defaults to 30m. A token with less than that
remaining is refreshed first.

Exit codes:
  0  credential written to stdout
  1  usage error
  2  no credential configured
  3  provider ambiguous
  4  credential kind unsupported for that provider
  5  refresh failed (the stored credential is left untouched)
  6  provider cannot mint a token that lives long enough`);
}

function parseDuration(value: string | undefined): number {
	const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
	if (!match) {
		throw new CredentialPrintError("Usage", "--min-expiry must use a duration such as 30m or 1h");
	}
	const unit = match[2].toLowerCase();
	const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	return Number(match[1]) * scale;
}

/** Parse the `auth` command surface before normal startup. */
export function parseCredentialPrintCommand(args: string[]): CredentialPrintCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind: CredentialPrintKind | undefined =
		args[1] === "print-api-key" ? "api_key" : args[1] === "print-bearer-token" ? "bearer_token" : undefined;
	if (!kind) {
		throw new CredentialPrintError(
			"Usage",
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_NAME} auth print-api-key" or "${APP_NAME} auth print-bearer-token".`,
		);
	}

	const commandArgs: string[] = [];
	let minExpiryMs: number | undefined;
	for (let index = 2; index < args.length; index++) {
		if (args[index] !== "--min-expiry") {
			commandArgs.push(args[index]);
			continue;
		}
		// An API key has no expiry, so the option is an error rather than a
		// silently ignored no-op that would imply a guarantee it cannot give.
		if (kind !== "bearer_token") {
			throw new CredentialPrintError("Usage", "--min-expiry is only supported by print-bearer-token");
		}
		minExpiryMs = parseDuration(args[++index]);
	}

	return minExpiryMs === undefined ? { kind, args: commandArgs } : { kind, args: commandArgs, minExpiryMs };
}

export function validateCredentialPrintArgs(args: Args): void {
	if (!args.model?.trim()) {
		throw new CredentialPrintError("Usage", "Credential printing requires --model <model>");
	}
	if (args.apiKey !== undefined) {
		throw new CredentialPrintError(
			"Usage",
			"Credential printing reads configured credentials; --api-key is not supported",
		);
	}
	if (args.messages.length > 0 || args.fileArgs.length > 0 || args.unknownFlags.size > 0) {
		throw new CredentialPrintError("Usage", "Credential printing only accepts --provider and --model");
	}
}

/**
 * pi-ai reports both refresh outcomes as `ModelsError` with code `oauth`. The
 * post-refresh validity failure is the only one that carries this phrase, and it
 * is the only signal available to separate exit 6 from exit 5.
 */
function classifyOAuthFailure(error: ModelsError): CredentialPrintError {
	return /expires too soon/iu.test(error.message)
		? new CredentialPrintError(
				"MinValidityUnreachable",
				`The provider refreshed the token but it still expires sooner than requested: ${error.message}`,
				{ cause: error },
			)
		: new CredentialPrintError("RefreshFailed", `${error.message} (the stored credential was left untouched)`, {
				cause: error,
			});
}

function candidateModels(args: Args, modelRuntime: ModelRuntime, configured: ReadonlySet<string>): Model<Api>[] {
	if (args.provider) {
		const resolved = resolveCliModel({ cliProvider: args.provider, cliModel: args.model, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new CredentialPrintError(
				"NoCredentialConfigured",
				resolved.error ?? "Unable to resolve the requested provider/model",
			);
		}
		return [resolved.model];
	}

	const models: Model<Api>[] = [];
	for (const provider of modelRuntime.getProviders()) {
		if (!configured.has(provider.id)) continue;
		const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: args.model, modelRuntime });
		if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
			models.push(resolved.model);
		}
	}
	if (models.length === 0) {
		throw new CredentialPrintError(
			"NoCredentialConfigured",
			`Model "${args.model}" not found among providers with configured credentials. Use --list-models to see available models.`,
		);
	}
	return models;
}

function bearerFromHeaders(headers: Record<string, unknown> | undefined): string | undefined {
	const authorization = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}

/**
 * Resolve exactly one credential for a named provider/model pair.
 *
 * Goes through `ModelRuntime.getAuth()`, the same request-auth path a real
 * model call uses, so an OAuth credential is refreshed and persisted by the one
 * implementation that already handles concurrent refresh under a lock.
 */
export async function resolveCredentialForPrint(
	args: Args,
	modelRuntime: ModelRuntime,
	kind: CredentialPrintKind,
	minExpiryMs?: number,
): Promise<Secret> {
	validateCredentialPrintArgs(args);

	const credentialTypes = new Map<string, CredentialInfo["type"]>(
		(await modelRuntime.listCredentials()).map((credential) => [credential.providerId, credential.type]),
	);
	const models = candidateModels(args, modelRuntime, new Set(credentialTypes.keys()));

	const credentials: Array<{ providerId: string; value: string }> = [];
	for (const model of models) {
		const type = credentialTypes.get(model.provider);
		if (kind === "api_key" && type === "oauth") continue;
		if (kind === "bearer_token" && type !== "oauth") continue;

		let auth: Awaited<ReturnType<ModelRuntime["getAuth"]>>;
		try {
			auth = await modelRuntime.getAuth(
				model,
				kind === "bearer_token" ? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS } : {},
			);
		} catch (error) {
			if (error instanceof ModelsError && error.code === "oauth") throw classifyOAuthFailure(error);
			throw new CredentialPrintError(
				"NoCredentialConfigured",
				error instanceof Error ? error.message : String(error),
				{ cause: error },
			);
		}

		const value =
			kind === "bearer_token" ? (auth?.auth.apiKey ?? bearerFromHeaders(auth?.auth.headers)) : auth?.auth.apiKey;
		if (value) credentials.push({ providerId: model.provider, value });
	}

	if (credentials.length === 1) return new Secret(credentials[0].value);

	if (credentials.length === 0) {
		const providerId = models[0]?.provider;
		const type = providerId ? credentialTypes.get(providerId) : undefined;
		if (args.provider && kind === "api_key" && type === "oauth") {
			throw new CredentialPrintError(
				"KindUnsupportedForProvider",
				`Provider "${providerId}" is configured with OAuth, not an API key`,
			);
		}
		if (args.provider && kind === "bearer_token" && type !== "oauth") {
			throw new CredentialPrintError(
				"KindUnsupportedForProvider",
				`Provider "${providerId}" is not configured with an OAuth bearer token`,
			);
		}
		throw new CredentialPrintError(
			"NoCredentialConfigured",
			`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`,
		);
	}

	throw new CredentialPrintError(
		"ProviderAmbiguous",
		`Model "${args.model}" has multiple configured providers (${credentials
			.map(({ providerId }) => providerId)
			.join(", ")}). Specify --provider.`,
	);
}
