/**
 * `atomic auth print-api-key` / `atomic auth print-bearer-token` and the
 * explicit `atomic auth check --credentials` export path.
 *
 * The only door in Atomic whose purpose is emitting a secret. Everything here
 * exists to keep that egress narrow:
 * - the secret leaves as a `Secret`, which cannot be interpolated, serialized,
 *   or inspected, and is consumed exactly once by the stdout writer;
 * - every export has an explicit target: the print commands require `--model`,
 *   and auth checks require `--provider` or an exact `--model` plus
 *   `--credentials`;
 * - there is no `--output <file>` and no clipboard path — stdout only;
 * - every failure is a distinct exit code, and stdout stays empty on all of
 *   them but one — `CredentialTruncated` (exit 9) exists to report the case
 *   where it cannot be, because bytes already left and cannot be recalled;
 * - a failed OAuth refresh never mutates the stored credential.
 *
 * One residual, and it is upstream: when a model infers several eligible
 * providers, each is asked for its credential before the ambiguity is known, so
 * a *successful* refresh can rotate and persist a credential this command then
 * declines to emit (exit 3). See the note on the `getAuth()` call in the
 * candidate loop.
 */

import { inspect } from "node:util";
import type { Api, AuthType, Model } from "@earendil-works/pi-ai";
import { ModelsError } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { flushRawStdout, RawStdoutWriteError, writeRawStdoutOnce } from "../core/output-guard.ts";
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
	| "MinValidityUnreachable"
	| "OAuthUnavailable"
	| "CredentialNotEmitted"
	| "CredentialTruncated";

/**
 * Exported so a test can walk the whole taxonomy: every declared code has to
 * name an exercised path, and the record type makes a new member without an
 * exit code a compile error rather than a review miss.
 *
 * Every one of these leaves stdout empty except `CredentialTruncated`, which
 * exists to report the one case where it cannot be: bytes already went out and
 * cannot be recalled. `STDOUT_EMPTY_ON_EXIT` names that split so the taxonomy
 * test asserts it rather than assuming it.
 */
export const EXIT_CODES: Record<CredentialPrintErrorCode, number> = {
	Usage: 1,
	NoCredentialConfigured: 2,
	ProviderAmbiguous: 3,
	KindUnsupportedForProvider: 4,
	RefreshFailed: 5,
	MinValidityUnreachable: 6,
	OAuthUnavailable: 7,
	CredentialNotEmitted: 8,
	CredentialTruncated: 9,
};

/** The codes whose contract is an empty stdout. See `EXIT_CODES`. */
export const STDOUT_EMPTY_ON_EXIT: ReadonlySet<CredentialPrintErrorCode> = new Set(
	(Object.keys(EXIT_CODES) as CredentialPrintErrorCode[]).filter((code) => code !== "CredentialTruncated"),
);

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

/** Public readiness fields emitted with a credential under `auth check --json --credentials`. */
export interface CredentialJsonFields {
	status: string;
	provider: string;
	authType?: string;
}

/**
 * The only function in `src` that opens a `Secret`.
 *
 * Its two `Secret.take()` calls are the only call sites in `src`, and the
 * source-wide credential-egress test pins that list. This function builds one
 * payload and returns it only to `emitCredential`; no caller receives a plain
 * credential string.
 */
function credentialPayload(secret: Secret, jsonFields: CredentialJsonFields | undefined): string {
	if (jsonFields === undefined) return `${secret.take()}\n`;

	const { status, provider, authType } = jsonFields;
	if (
		typeof status !== "string" ||
		typeof provider !== "string" ||
		(authType !== undefined && typeof authType !== "string")
	) {
		throw new Error("Invalid credential JSON fields");
	}

	// Allowlist the non-secret envelope before opening the Secret. That leaves no
	// formatter, logger, or error path between take() and the guarded stdout write.
	const fields = JSON.stringify({
		status,
		provider,
		...(authType === undefined ? {} : { authType }),
	});
	if (fields === undefined || !fields.startsWith("{") || !fields.endsWith("}")) {
		throw new Error("Invalid credential JSON envelope");
	}
	return `${fields.slice(0, -1)},"credentials":${JSON.stringify(secret.take())}}\n`;
}

/**
 * The single credential egress in `src`.
 *
 * `credentialPayload` opens the secret only while building this one payload,
 * and this guarded write is the only path that hands it to real stdout. A
 * caller — `main.ts` included — receives a `Secret` it cannot read, print, or
 * serialize, so it cannot add a second export path without crossing this door.
 * `test/credential-print.test.ts` pins both the `take()` sites and every
 * data-bearing real-stdout write in `packages/coding-agent/src`.
 *
 * A failed payload write is answered from the stream rather than from the shape
 * of the error, because `bytesWritten` says how much of the credential actually
 * left and the right report differs for each amount.
 *
 * Nothing left — the write call threw, or the callback failed with the counter
 * unmoved — is `CredentialNotEmitted` (exit 8) with stdout provably empty,
 * which is what that exit promises. It must not fall through to the caller's
 * credential-resolution catch, which would report exit 2.
 *
 * All of it left and the failure came after: the caller holds the credential it
 * asked for, so this is reported on stderr with the exit code left at 0, for
 * the same reason the trailing drain is. A non-zero exit over a stream carrying
 * a whole credential is the thing this door never produces.
 *
 * Part of it left is neither. Those bytes cannot be recalled, so stdout is not
 * empty and cannot be made empty; but they are a fragment, not a credential,
 * and reporting success over them would hand a caller a truncated secret it
 * cannot tell from a whole one. That case gets `CredentialTruncated` (exit 9),
 * the one code in this taxonomy whose contract is *not* an empty stdout —
 * stated as such in `EXIT_CODES` and asserted through `STDOUT_EMPTY_ON_EXIT`,
 * rather than left for a caller to discover.
 */
export async function emitCredential(secret: Secret, jsonFields: CredentialJsonFields | undefined): Promise<void> {
	const payload = credentialPayload(secret, jsonFields);
	try {
		await writeRawStdoutOnce(payload);
	} catch (error) {
		if (error instanceof RawStdoutWriteError && error.emitted === "all") {
			// The caller holds the whole credential. Exiting non-zero here would be
			// a non-zero exit over a stream carrying it, which this door never does.
			console.error(
				`Warning: the credential reached stdout but the write did not complete cleanly: ${error.message}`,
			);
			return;
		}
		if (error instanceof RawStdoutWriteError && error.emitted === "partial") {
			throw new CredentialPrintError(
				"CredentialTruncated",
				"Only part of the credential reached stdout; discard the output, it is not a usable credential",
				{ cause: error },
			);
		}
		throw new CredentialPrintError(
			"CredentialNotEmitted",
			"Failed to write the credential to stdout; nothing was emitted",
			{ cause: error },
		);
	}
	try {
		await flushRawStdout();
	} catch (error) {
		console.error(
			`Warning: the credential was written to stdout but the stream did not drain cleanly: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * The single place a thrown value becomes an exit code for this door.
 *
 * `main.ts` routes every failure through here. Every code it can produce leaves
 * stdout empty, so an exit code from this door never contradicts the stream.
 */
export function toCredentialPrintError(error: unknown): CredentialPrintError {
	if (error instanceof CredentialPrintError) return error;
	return new CredentialPrintError(
		"NoCredentialConfigured",
		error instanceof Error ? error.message : "Failed to resolve credential",
		{ cause: error },
	);
}

/**
 * The only two fields of `Args` this door accepts.
 *
 * Validation is an allowlist rather than a list of refusals, because the
 * refusal list only held while the dispatcher happened to ignore every other
 * flag. `--export <path>`, `--session-dir <path>`, `--print`, and `--help` are
 * all parsed by `parseArgs`; under an exclusion check they passed silently and
 * the door's "no file sink" guarantee rested on a downstream accident.
 */
const ACCEPTED_ARG_FIELDS: ReadonlySet<string> = new Set(["model", "provider"]);

/** Names every field of a parsed `Args` that the caller actually set. */
function populatedArgFields(args: Args): string[] {
	const populated: string[] = [];
	for (const [field, value] of Object.entries(args)) {
		if (ACCEPTED_ARG_FIELDS.has(field) || value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length > 0) populated.push(field);
		} else if (value instanceof Map) {
			if (value.size > 0) populated.push(field);
		} else {
			populated.push(field);
		}
	}
	return populated;
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
	const refused = populatedArgFields(args);
	if (refused.length > 0) {
		throw new CredentialPrintError(
			"Usage",
			`Credential printing only accepts --provider and --model (refused: ${refused.join(", ")})`,
		);
	}
}

/**
 * Provider-supplied text with anything credential-bearing masked.
 *
 * A failed refresh is reported on stderr, and the provider composes that
 * message. Most describe the failure; some quote the request they sent or the
 * body they got back, either of which can carry the very value this door exists
 * to keep off every stream except stdout. Masking keeps the diagnosis — which
 * is what makes the exit code actionable — without putting the secret in a log,
 * a terminal scrollback, or a CI transcript.
 *
 * Two passes, because either alone leaves a gap. Shape catches a value wherever
 * it appears, but only for the formats that announce themselves. Context
 * catches an opaque value — an `x-api-key`, which is just bytes — by the name it
 * is filed under, in the header, JSON, and query spellings a quoted request or
 * response body uses.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
	// `Authorization: Bearer <token>`, the form an echoed request header takes.
	/\bBearer\s+[\w.~+/-]+=*/giu,
	// JWTs, which several providers return verbatim in an error body.
	/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/gu,
	// Prefixed API keys: sk-…, sk_live_…, api-key-…, and the same shapes again.
	/\b(?:sk|pk|rk|api|key|tok|token|secret)[-_][\w-]{12,}/giu,
];

/**
 * Field names whose value is the credential, however opaque that value looks.
 * `x-api-key` is the case shape-matching cannot reach: the value is just bytes.
 */
const CREDENTIAL_FIELD_NAME =
	"(?:x-)?(?:api[-_]?key|apikey|auth(?:orization)?|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|session[-_]?key|password|passwd|token|secret|key)";

/**
 * Auth schemes that stand between the field name and the value it introduces.
 *
 * Without them the header matcher stops at the space after `Bearer`: it redacts
 * the scheme and leaves the token, and having consumed the `Bearer` the shape
 * pass depends on, that pass can no longer reach the token either. An opaque
 * `Authorization: Bearer <token>` then survives both passes.
 */
const CREDENTIAL_AUTH_SCHEME = "(?:Bearer|Basic|Digest|Token|ApiKey|OAuth)";

const CREDENTIAL_CONTEXTS: readonly RegExp[] = [
	// Header or YAML-ish: `x-api-key: abc123`, to end of line, and the scheme
	// form `Authorization: Bearer abc123` with it.
	new RegExp(String.raw`\b${CREDENTIAL_FIELD_NAME}\s*:\s*(?:${CREDENTIAL_AUTH_SCHEME}\s+)?[^\s,;}"']+`, "giu"),
	// JSON: `"api_key": "abc123"` / `'token':'abc123'`, quoted value.
	new RegExp(String.raw`(["']?)${CREDENTIAL_FIELD_NAME}\1\s*:\s*(["'])(?:(?!\2).)*\2`, "giu"),
	// Query string or form body: `?api_key=abc123&…`.
	new RegExp(String.raw`\b${CREDENTIAL_FIELD_NAME}\s*=\s*[^\s&,;}"']+`, "giu"),
];

export function redactCredentialShapes(text: string): string {
	const byContext = CREDENTIAL_CONTEXTS.reduce(
		(masked, context) =>
			masked.replace(context, (match) => {
				// Keep the field name so the diagnosis still says which one failed;
				// replace only what follows the separator.
				const separator = /[:=]/u.exec(match);
				return separator ? `${match.slice(0, separator.index + 1)} [redacted]` : "[redacted]";
			}),
		text,
	);
	return CREDENTIAL_SHAPES.reduce((masked, shape) => masked.replace(shape, "[redacted]"), byContext);
}

/**
 * The literal phrase pi-ai throws when a refresh itself failed, from inside
 * `credentials.modify` and therefore before anything is persisted. This is the
 * only oauth-coded error that can claim the stored credential was left alone.
 */
export const OAUTH_REFRESH_FAILED_PHRASE = "OAuth refresh failed for";

/**
 * The literal phrase pi-ai throws when a refresh succeeded but the rotated
 * token still expires inside the requested window. It is the only signal that
 * separates exit 6 from exit 5.
 */
export const OAUTH_EXPIRES_TOO_SOON_PHRASE = "expires too soon";

/**
 * pi-ai raises three different `oauth`-coded failures from
 * `dist/auth/resolve.js`, and only one of them is a failed refresh.
 *
 * `OAuth auth derivation failed for <provider>` is thrown after
 * `credentials.modify` has already persisted a rotated credential, and also on
 * the branch where no refresh was attempted at all — so it gets its own code
 * and a message that makes no claim about the stored credential. Treating it as
 * `RefreshFailed` asserted a rollback the command never verified.
 *
 * Classification reads the raw message, because redaction could rewrite the
 * phrase it matches on; only the text that becomes a user-facing message is
 * redacted. The unredacted error stays reachable as `cause`, which this door
 * never logs.
 *
 * `test/credential-print.test.ts` pins both phrases against the installed
 * pi-ai build, so an upstream rewording fails the suite rather than silently
 * collapsing exit 6 into exit 5.
 */
export function classifyOAuthFailure(error: ModelsError): CredentialPrintError {
	const detail = redactCredentialShapes(error.message);
	if (error.message.includes(OAUTH_EXPIRES_TOO_SOON_PHRASE)) {
		return new CredentialPrintError(
			"MinValidityUnreachable",
			`The provider refreshed the token but it still expires sooner than requested: ${detail}`,
			{ cause: error },
		);
	}
	if (error.message.startsWith(OAUTH_REFRESH_FAILED_PHRASE)) {
		return new CredentialPrintError("RefreshFailed", `${detail} (the stored credential was left untouched)`, {
			cause: error,
		});
	}
	return new CredentialPrintError("OAuthUnavailable", detail, { cause: error });
}

/**
 * Providers whose credential the caller could have meant.
 *
 * With `--provider` the caller named one, so failing to resolve it is an error.
 * Without it, eligibility is *not* narrowed to providers holding a persisted
 * credential: a provider authenticated by an environment variable or a custom
 * resolver has nothing in `auth.json`, and filtering on that list dropped it
 * before `getAuth()` could produce its working key. Candidacy is therefore
 * "offers the named model", and `getAuth()` — the same call a real request
 * makes — decides which candidate actually authenticates.
 */
function candidateModels(args: Args, modelRuntime: ModelRuntime): Model<Api>[] {
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
		const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: args.model, modelRuntime });
		if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
			models.push(resolved.model);
		}
	}
	if (models.length === 0) {
		throw new CredentialPrintError(
			"NoCredentialConfigured",
			`Model "${args.model}" not found among the available providers. Use --list-models to see available models.`,
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

	// The effective auth type per candidate provider, taken from the runtime
	// rather than from auth.json.
	//
	// `checkAuth` reports what a provider would actually authenticate with,
	// including a credential supplied by an environment variable or a custom
	// resolver that persists nothing, and it answers without refreshing OAuth.
	// `listCredentials()` sees only what was stored, which both hid working
	// credentials and — for a provider offering an API key *and* OAuth — could not
	// say which of the two a request would use. Provider capability cannot say
	// either: several providers send an API key as `Authorization: Bearer`, so
	// neither that header nor `apiKey` identifies the credential's kind on its own.
	const wantedAuthType: AuthType = kind === "api_key" ? "api_key" : "oauth";
	const resolvedAuthTypes = new Map<string, AuthType | undefined>();
	const models = candidateModels(args, modelRuntime);
	for (const { provider } of models) {
		if (resolvedAuthTypes.has(provider)) continue;
		resolvedAuthTypes.set(provider, (await modelRuntime.checkAuth(provider))?.type);
	}
	// A named provider, or a single candidate, is the one the caller meant, so its
	// authentication failure is reported with its own exit code. Among several
	// inferred candidates a failure only means "not this one" — reporting it would
	// let an unrelated provider that happens to offer the model decide the exit
	// code for a request another candidate can satisfy.
	const authFailureIsFatal = args.provider !== undefined || models.length === 1;

	const credentials: Array<{ providerId: string; value: string }> = [];
	// The classified diagnosis from a candidate that could not authenticate.
	// Skipping a candidate must not discard why it failed: a refresh that failed,
	// or a token that cannot reach the requested validity, is the real answer if
	// nothing else produces a credential, and keeping it is what leaves exits 5
	// and 6 reachable instead of collapsing every inferred failure into exit 2.
	// It holds a `CredentialPrintError`, never a credential — the provider's text
	// is redacted on the way in.
	let deferredDiagnosis: CredentialPrintError | undefined;
	for (const model of models) {
		const type = resolvedAuthTypes.get(model.provider);
		if (type !== wantedAuthType) continue;

		// Every eligible candidate is asked here, before `ProviderAmbiguous` is
		// known, so an ambiguous export can refresh and persist credentials it
		// emits nothing for. Deciding eligibility earlier is not available:
		// `checkAuth()` is the only non-mutating probe and cannot tell a candidate
		// that will authenticate from one that will fail, which is what keeps
		// exits 5 and 6 reachable. Nor does resolving without refreshing exist —
		// `resolveStoredOAuth` in `@earendil-works/pi-ai` refreshes whenever the
		// token falls inside `max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS,
		// minOAuthValidityMs ?? 0)`, so omitting `minOAuthValidityMs` only lowers
		// that window to five minutes and drops the post-refresh check exit 6 is
		// decided by. Bounded: the refresh rotates a valid credential, it does not
		// invalidate one. Closing it needs a non-mutating probe upstream.
		let auth: Awaited<ReturnType<ModelRuntime["getAuth"]>>;
		try {
			auth = await modelRuntime.getAuth(
				model,
				kind === "bearer_token" ? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS } : {},
			);
		} catch (error) {
			const diagnosis =
				error instanceof ModelsError && error.code === "oauth" ? classifyOAuthFailure(error) : undefined;
			if (!authFailureIsFatal) {
				deferredDiagnosis ??= diagnosis;
				continue;
			}
			if (diagnosis) throw diagnosis;
			throw new CredentialPrintError(
				"NoCredentialConfigured",
				redactCredentialShapes(error instanceof Error ? error.message : String(error)),
				{ cause: error },
			);
		}

		const value =
			kind === "bearer_token" ? (auth?.auth.apiKey ?? bearerFromHeaders(auth?.auth.headers)) : auth?.auth.apiKey;
		if (value) credentials.push({ providerId: model.provider, value });
	}

	if (credentials.length === 1) return new Secret(credentials[0].value);

	if (credentials.length === 0) {
		if (deferredDiagnosis) throw deferredDiagnosis;
		const providerId = models[0]?.provider;
		const type = providerId ? resolvedAuthTypes.get(providerId) : undefined;
		if (args.provider && kind === "api_key" && type === "oauth") {
			throw new CredentialPrintError(
				"KindUnsupportedForProvider",
				`Provider "${providerId}" is configured with OAuth, not an API key`,
			);
		}
		if (args.provider && kind === "bearer_token" && type === "api_key") {
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
