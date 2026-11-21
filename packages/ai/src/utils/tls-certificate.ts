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

/**
 * The runtime's own reasons for each code TLS verification refuses a certificate with, lowercase: OpenSSL 3's and
 * BoringSSL's, and Node.js's and Bun's for a certificate that does not name the host. A runtime may add to them, as
 * Node.js 24 adds a hint to some, so each is a prefix.
 */
const VERIFICATION_REASONS: Readonly<Record<string, readonly string[]>> = {
	ERR_TLS_CERT_ALTNAME_INVALID: ["hostname/ip does not match certificate's altnames"],
	UNABLE_TO_GET_ISSUER_CERT: ["unable to get issuer certificate"],
	UNABLE_TO_GET_CRL: ["unable to get certificate crl"],
	UNABLE_TO_DECRYPT_CERT_SIGNATURE: ["unable to decrypt certificate's signature"],
	UNABLE_TO_DECRYPT_CRL_SIGNATURE: ["unable to decrypt crl's signature"],
	UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: ["unable to decode issuer public key"],
	CERT_SIGNATURE_FAILURE: ["certificate signature failure"],
	CRL_SIGNATURE_FAILURE: ["crl signature failure"],
	CERT_NOT_YET_VALID: ["certificate is not yet valid"],
	CERT_HAS_EXPIRED: ["certificate has expired"],
	CRL_NOT_YET_VALID: ["crl is not yet valid"],
	CRL_HAS_EXPIRED: ["crl has expired"],
	ERROR_IN_CERT_NOT_BEFORE_FIELD: ["format error in certificate's notbefore field"],
	ERROR_IN_CERT_NOT_AFTER_FIELD: ["format error in certificate's notafter field"],
	ERROR_IN_CRL_LAST_UPDATE_FIELD: ["format error in crl's lastupdate field"],
	ERROR_IN_CRL_NEXT_UPDATE_FIELD: ["format error in crl's nextupdate field"],
	DEPTH_ZERO_SELF_SIGNED_CERT: ["self-signed certificate", "self signed certificate"],
	SELF_SIGNED_CERT_IN_CHAIN: [
		"self-signed certificate in certificate chain",
		"self signed certificate in certificate chain",
	],
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: ["unable to get local issuer certificate"],
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: ["unable to verify the first certificate"],
	CERT_CHAIN_TOO_LONG: ["certificate chain too long"],
	CERT_REVOKED: ["certificate revoked"],
	INVALID_CA: ["invalid ca certificate"],
	PATH_LENGTH_EXCEEDED: ["path length constraint exceeded"],
	INVALID_PURPOSE: ["unsuitable certificate purpose", "unsupported certificate purpose"],
	CERT_UNTRUSTED: ["certificate not trusted"],
	CERT_REJECTED: ["certificate rejected"],
	HOSTNAME_MISMATCH: ["hostname mismatch"],
	UNSPECIFIED: UNSPECIFIED_CERTIFICATE_REASONS,
};

/**
 * Whether `message` is the runtime's own text for a certificate it refused with `code`, as Node's and Bun's TLS give
 * it, or Bun's fetch (`<code> fetching "<url>"`), rather than a provider's: a gateway can relay an upstream's
 * certificate code in its own words, which says nothing about the certificate this request was shown.
 */
function isVerificationMessage(code: string, message: string): boolean {
	const text = message.toLowerCase();
	if (text.startsWith(`${code.toLowerCase()} fetching `)) return true;
	return (VERIFICATION_REASONS[code] ?? []).some((reason) => text.startsWith(reason));
}

/**
 * Whether `value` came from a response: an HTTP status as SDK errors carry it, including pi-messages' recorded one, or
 * the response headers an SDK error for an error event inside a successful response keeps.
 */
function isResponseError(value: object): boolean {
	const fields = value as {
		status?: unknown;
		statusCode?: unknown;
		headers?: unknown;
		$metadata?: { httpStatusCode?: unknown };
		$response?: { statusCode?: unknown };
		diagnosticDetails?: { status?: unknown };
	};
	return (
		typeof fields.status === "number" ||
		typeof fields.statusCode === "number" ||
		(typeof fields.headers === "object" && fields.headers !== null) ||
		typeof fields.$metadata?.httpStatusCode === "number" ||
		typeof fields.$response?.statusCode === "number" ||
		typeof fields.diagnosticDetails?.status === "number"
	);
}

/**
 * The refused certificate a failed request's error carries along its cause chain, as Node's fetch (`fetch failed`),
 * Bun's fetch and the provider SDKs (`Connection error.`) wrap it; undefined for any other failure. It takes an error's
 * own code with the runtime's own reason for it, and a failure that got a response is never one: a 502, or an error
 * event in a stream, whose body names a certificate code is the provider's answer.
 */
export function findTlsCertificateRefusal(error: unknown): TlsCertificateRefusal | undefined {
	let refusal: TlsCertificateRefusal | undefined;
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		// Any link from a response, above or below the code, means the request got an answer.
		if (isResponseError(current)) return undefined;
		const { code, message } = current as { code?: unknown; message?: unknown };
		const text = typeof message === "string" ? message.trim() : "";
		if (
			refusal === undefined &&
			typeof code === "string" &&
			isRefusedCertificate(code, text) &&
			isVerificationMessage(code, text)
		) {
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
