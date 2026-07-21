import { createHash } from "node:crypto";
import { CursorError } from "./errors.js";

export interface CursorHostOAuthCredential {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
}

interface CursorJwtIdentity {
	readonly issuer: string;
	readonly subject: string;
}

const ACCOUNT_SCOPE_DOMAIN = "atomic.cursor.account-scope.v1";
const ACCOUNT_SCOPE_PREFIX = "cursor-account-v1:";

/** Validate host authentication without requiring credentials to expose stable identity claims. */
export function validateCursorHostOAuthCredential(credential: CursorHostOAuthCredential, now = Date.now()): void {
	if (
		credential.type !== "oauth" ||
		typeof credential.access !== "string" || credential.access.length === 0 ||
		typeof credential.refresh !== "string" || credential.refresh.length === 0 ||
		typeof credential.expires !== "number" || !Number.isFinite(credential.expires)
	) throw authError("AuthenticationMalformed", "Cursor host OAuth credentials are malformed.", credential);
	if (credential.expires <= now) {
		throw authError("AuthenticationExpired", "Cursor host OAuth credentials are expired; authenticate again.", credential);
	}
}

/** Return a stable non-secret scope when provable; opaque credentials safely return undefined. */
export function deriveCursorAccountScope(credential: CursorHostOAuthCredential, now = Date.now()): string | undefined {
	validateCursorHostOAuthCredential(credential, now);
	const accessIdentity = tryParseCursorJwtIdentity(credential.access);
	if (!accessIdentity) return undefined;
	const refreshIdentity = tryParseCursorJwtIdentity(credential.refresh);
	if (refreshIdentity && (accessIdentity.issuer !== refreshIdentity.issuer || accessIdentity.subject !== refreshIdentity.subject)) {
		throw authError("AuthenticationMalformed", "Cursor OAuth access and refresh identities do not match.", credential);
	}
	const digest = createHash("sha256")
		.update(ACCOUNT_SCOPE_DOMAIN).update("\0")
		.update(accessIdentity.issuer).update("\0")
		.update(accessIdentity.subject)
		.digest("base64url");
	return `${ACCOUNT_SCOPE_PREFIX}${digest}`;
}

function tryParseCursorJwtIdentity(token: string): CursorJwtIdentity | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { readonly iss?: unknown; readonly sub?: unknown };
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		if (typeof parsed.iss !== "string" || parsed.iss.length === 0 || typeof parsed.sub !== "string" || parsed.sub.length === 0) return undefined;
		if (!isCursorIssuer(parsed.iss)) return undefined;
		return { issuer: parsed.iss, subject: parsed.sub };
	} catch {
		return undefined;
	}
}

function isCursorIssuer(issuer: string): boolean {
	try {
		const url = new URL(issuer);
		const hostname = url.hostname.toLowerCase();
		return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0 &&
			(hostname === "cursor.sh" || hostname.endsWith(".cursor.sh") || hostname === "cursor.com" || hostname.endsWith(".cursor.com"));
	} catch {
		return false;
	}
}

function authError(
	code: "AuthenticationMalformed" | "AuthenticationExpired",
	message: string,
	credential: CursorHostOAuthCredential,
): CursorError {
	return new CursorError(code, message, { operation: "authentication", secrets: [credential.access, credential.refresh] });
}
