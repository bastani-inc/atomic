import type { AssistantMessage } from "../types.ts";
import { type AssistantMessageDiagnostic, appendAssistantMessageDiagnostic } from "./diagnostics.ts";

/**
 * A request that failed because TLS verification refused the certificate the endpoint (or a proxy on the way) showed
 * (#6114). The certificate does not change between attempts, so such a request is sent once: no retry would succeed.
 */

/**
 * The codes of a certificate TLS verification refused: the host name check's code and Node's documented X509 codes,
 * which Bun reports too, except `OUT_OF_MEM`, which says nothing about the certificate. The PostgreSQL adapter refuses
 * a certificate with the same list (`packages/storage-postgres/proxy.js`).
 */
export const TLS_VERIFICATION_CODES: ReadonlySet<string> = new Set([
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_CRL",
	"UNABLE_TO_DECRYPT_CERT_SIGNATURE",
	"UNABLE_TO_DECRYPT_CRL_SIGNATURE",
	"UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
	"CERT_SIGNATURE_FAILURE",
	"CRL_SIGNATURE_FAILURE",
	"CERT_NOT_YET_VALID",
	"CERT_HAS_EXPIRED",
	"CRL_NOT_YET_VALID",
	"CRL_HAS_EXPIRED",
	"ERROR_IN_CERT_NOT_BEFORE_FIELD",
	"ERROR_IN_CERT_NOT_AFTER_FIELD",
	"ERROR_IN_CRL_LAST_UPDATE_FIELD",
	"ERROR_IN_CRL_NEXT_UPDATE_FIELD",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_CHAIN_TOO_LONG",
	"CERT_REVOKED",
	"INVALID_CA",
	"PATH_LENGTH_EXCEEDED",
	"INVALID_PURPOSE",
	"CERT_UNTRUSTED",
	"CERT_REJECTED",
	"HOSTNAME_MISMATCH",
]);

/**
 * Node and Bun report a verification result outside their table as `UNSPECIFIED`, with OpenSSL's reason for it, such as
 * "key usage does not include certificate signing" for a root that may not sign certificates. These are those reasons
 * that describe the certificate, lowercase, from OpenSSL 3 and BoringSSL. `UNSPECIFIED` with any other message, such as
 * OpenSSL's own failures ("unspecified certificate verification error", "issuer certificate lookup error") or an error
 * that did not come from TLS at all, is not a refused certificate. The PostgreSQL adapter holds the same list.
 */
export const UNSPECIFIED_CERTIFICATE_REASONS: readonly string[] = [
	"authority and issuer serial number mismatch",
	"authority and subject key identifier mismatch",
	"authority key identifier marked critical",
	"basic constraints of ca cert not marked critical",
	"ca cert does not include key usage extension",
	"ca certificate key too weak",
	"ca signature digest algorithm too weak",
	"cannot find certificate signature algorithm",
	"cert info signature and signature algorithm mismatch",
	"certificate public key has explicit ecc parameters",
	"certificate transparency required, but no valid scts found",
	"crl path validation error",
	"different crl scope",
	"ee certificate key too weak",
	"email address mismatch",
	"empty subject alternative name extension",
	"excluded subtree violation",
	"invalid non-ca certificate (has ca markings)",
	"invalid or inconsistent certificate extension",
	"invalid or inconsistent certificate policy extension",
	"ip address mismatch",
	"issuer certificate doesn't have a public key",
	"issuer has name constraints but leaf has no sans",
	"issuer name empty",
	"key usage does not include certificate signing",
	"key usage does not include crl signing",
	"key usage does not include digital signature",
	"key usage keycertsign invalid for non-ca cert",
	"missing authority key identifier",
	"missing subject key identifier",
	"name constraints minimum and maximum not supported",
	"no explicit policy",
	"no matching dane tlsa records",
	"ocsp unknown cert",
	"ocsp verification failed",
	"ocsp verification needed",
	"path length given without key usage keycertsign",
	"path length invalid for non-ca cert",
	"path loop",
	"permitted subtree violation",
	"proxy certificates not allowed, please set the appropriate flag",
	"proxy path length constraint exceeded",
	"proxy subject name violation",
	"raw public key untrusted, no trusted keys configured",
	"rfc 3779 resource not subset of parent's resources",
	"subject empty and subject alt name extension not critical",
	"subject issuer mismatch",
	"subject key identifier marked critical",
	"subject name empty",
	"subject signature algorithm and issuer public key algorithm mismatch",
	"suite b: cannot sign p-384 with p-256",
	"suite b: certificate version invalid",
	"suite b: curve not allowed for this los",
	"suite b: invalid ecc curve",
	"suite b: invalid public key algorithm",
	"suite b: invalid signature algorithm",
	"unable to get crl issuer certificate",
	"unhandled critical crl extension",
	"unhandled critical extension",
	"unsupported extension feature",
	"unsupported name constraint type",
	"unsupported or invalid name constraint syntax",
	"unsupported or invalid name syntax",
	"using cert extension requires at least x509v3",
];

/** Whether TLS verification refused a certificate with `code`, whose runtime message is `reason`. */
export function isRefusedCertificate(code: string, reason: string): boolean {
	if (TLS_VERIFICATION_CODES.has(code)) return true;
	if (code !== "UNSPECIFIED") return false;
	const text = reason.toLowerCase();
	return UNSPECIFIED_CERTIFICATE_REASONS.some((known) => text.startsWith(known));
}

/** A certificate TLS verification refused: its code, and the runtime's reason for it ("" when it names none). */
export interface TlsCertificateRefusal {
	readonly code: string;
	readonly reason: string;
}

/** The diagnostic a failed assistant message carries for a refused certificate, so retries decide on it. */
export const TLS_CERTIFICATE_REFUSED_DIAGNOSTIC = "provider_tls_certificate_refused";

const MAX_CAUSE_DEPTH = 5;

/** Whether `value` carries an HTTP status, as an SDK error for a response does. */
function hasHttpStatus(value: object): boolean {
	const fields = value as {
		status?: unknown;
		statusCode?: unknown;
		$metadata?: { httpStatusCode?: unknown };
		$response?: { statusCode?: unknown };
	};
	return (
		typeof fields.status === "number" ||
		typeof fields.statusCode === "number" ||
		typeof fields.$metadata?.httpStatusCode === "number" ||
		typeof fields.$response?.statusCode === "number"
	);
}

/**
 * The refused certificate a failed request's error carries along its cause chain, as Node's fetch (`fetch failed`),
 * Bun's fetch and the provider SDKs (`Connection error.`) wrap it; undefined for any other failure. Only an error's
 * own code counts, never its text, and a failure that got an HTTP response is never one: a status such as a 502 whose
 * body quotes a certificate code is the provider's answer.
 */
export function findTlsCertificateRefusal(error: unknown): TlsCertificateRefusal | undefined {
	let refusal: TlsCertificateRefusal | undefined;
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		// Any link with a status, above or below the code, means the request got an answer.
		if (hasHttpStatus(current)) return undefined;
		const { code, message } = current as { code?: unknown; message?: unknown };
		const text = typeof message === "string" ? message.trim() : "";
		if (refusal === undefined && typeof code === "string" && isRefusedCertificate(code, text)) {
			// Bun's fetch names the code and the URL instead of a reason; the URL can carry credentials.
			refusal = { code, reason: text.startsWith(code) || text.includes("://") ? "" : text };
		}
		current = (current as { cause?: unknown }).cause;
	}
	return refusal;
}

const NAME_MISMATCH_CODES: ReadonlySet<string> = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH"]);

/** The `host[:port]` of `url`, without credentials, path or query; undefined when it is not a URL. */
function hostOf(url: string | undefined): string | undefined {
	if (url === undefined || url.trim() === "") return undefined;
	try {
		return new URL(url).host || undefined;
	} catch {
		return undefined;
	}
}

/**
 * What to tell the user about a refused certificate: the host it was shown for, when known, the code and the runtime's
 * reason, and how to have it accepted.
 */
export function describeTlsCertificateRefusal(refusal: TlsCertificateRefusal, host?: string): string {
	const what = refusal.reason === "" ? refusal.code : `${refusal.code}: ${refusal.reason}`;
	const fix = NAME_MISMATCH_CODES.has(refusal.code)
		? "Use a base URL whose host name the certificate names"
		: "If the endpoint, or a proxy on the way to it, uses a certificate from a private or corporate CA, set NODE_EXTRA_CA_CERTS to a PEM file with that CA and restart";
	const whose = host === undefined ? "" : ` for ${host}`;
	return `The TLS certificate${whose} was not accepted (${what}). ${fix}. The request is not retried`;
}

/**
 * When `error`, a failed request to `url`, is a refused certificate: names it in `output`'s message and records it as
 * a `provider_tls_certificate_refused` diagnostic, so no retry sends the request again. Returns whether it was one.
 */
export function recordTlsCertificateRefusal(output: AssistantMessage, error: unknown, url?: string): boolean {
	if (output.stopReason !== "error") return false;
	const refusal = findTlsCertificateRefusal(error);
	if (refusal === undefined) return false;
	output.errorMessage = describeTlsCertificateRefusal(refusal, hostOf(url));
	appendAssistantMessageDiagnostic(output, {
		type: TLS_CERTIFICATE_REFUSED_DIAGNOSTIC,
		timestamp: Date.now(),
		details: { code: refusal.code, reason: refusal.reason },
	});
	return true;
}

/**
 * The refused certificate a failed assistant message records; undefined when it records none. Accepts a message read
 * back from JSON, whose diagnostics are validated here.
 */
export function getTlsCertificateRefusal(
	message: { readonly diagnostics?: unknown } | undefined,
): TlsCertificateRefusal | undefined {
	const diagnostics = message?.diagnostics;
	if (!Array.isArray(diagnostics)) return undefined;
	for (const diagnostic of diagnostics as readonly (Partial<AssistantMessageDiagnostic> | null)[]) {
		if (diagnostic?.type !== TLS_CERTIFICATE_REFUSED_DIAGNOSTIC) continue;
		const code = diagnostic.details?.code;
		const recorded = diagnostic.details?.reason;
		const reason = typeof recorded === "string" ? recorded : "";
		if (typeof code === "string" && isRefusedCertificate(code, reason)) return { code, reason };
	}
	return undefined;
}
