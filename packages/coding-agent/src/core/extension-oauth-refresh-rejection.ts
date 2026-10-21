import {
	isOAuthRefreshRejectedError,
	isPermanentRefreshRejection,
	type OAuthCredentials,
	type OAuthErrorDetail,
	OAuthRefreshRejectedError,
	parseOAuthErrorBody,
} from "@bastani/pi-ai";

/** RFC 6749 §5.2: a token endpoint answers an invalid refresh token with HTTP 400 and `invalid_grant`. */
const OAUTH_ERROR_STATUS = 400;
const MAX_CAUSE_DEPTH = 5;

/** The fields of an OAuth error response, flat (`error`, `error_description`) or nested (`error.code`, `error.message`). */
const OAUTH_BODY_KEYS = ["error", "error_description", "code", "message"] as const;
/** On the thrown error itself `message` is the error's own summary, not the provider's description. */
const THROWN_ERROR_KEYS = ["error", "error_description", "code"] as const;

type ThrownFields = { readonly [key: string]: unknown };

function fieldsOf(value: unknown): ThrownFields | undefined {
	return typeof value === "object" && value !== null ? (value as ThrownFields) : undefined;
}

function numberField(fields: ThrownFields | undefined, key: string): number | undefined {
	const value = fields?.[key];
	return typeof value === "number" ? value : undefined;
}

/** An OAuth error response's code and description, from an object or JSON text. */
function oauthErrorDetail(value: unknown, keys: readonly string[]): OAuthErrorDetail {
	if (typeof value === "string") return parseOAuthErrorBody(value);
	const fields = fieldsOf(value);
	if (fields === undefined) return {};
	try {
		return parseOAuthErrorBody(JSON.stringify(Object.fromEntries(keys.map((key) => [key, fields[key]]))));
	} catch {
		// A circular or BigInt value is not an OAuth error response.
		return {};
	}
}

function hasPermanentCode(detail: OAuthErrorDetail): boolean {
	return detail.code !== undefined && isPermanentRefreshRejection({ status: OAUTH_ERROR_STATUS, code: detail.code });
}

/**
 * Maps a rejected login reported by an extension's `refreshToken` in a common error shape onto
 * {@link OAuthRefreshRejectedError}, so it gets the same `/login` guidance as a built-in provider. Recognised on the
 * error or its `cause` chain: an OAuth error code that the built-in providers treat as a rejected login (such as
 * `invalid_grant`), in the error's `error` or `code` property or in an OAuth error response (flat or nested
 * `error.code`) in `body`, `data`, `response.data`, or `response.body`; or HTTP 401 in `status`, `statusCode`,
 * `response.status`, or `response.statusCode`. Errors that already are an `OAuthRefreshRejectedError` are left as
 * thrown.
 */
export function extensionRefreshRejection(
	error: unknown,
	credential: OAuthCredentials,
	providerName: string,
): OAuthRefreshRejectedError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (current instanceof Error && isOAuthRefreshRejectedError(current)) return undefined;
		const fields = fieldsOf(current);
		const response = fieldsOf(fields?.response);
		const status =
			numberField(fields, "status") ??
			numberField(fields, "statusCode") ??
			numberField(response, "status") ??
			numberField(response, "statusCode");
		const thrown = oauthErrorDetail(fields, THROWN_ERROR_KEYS);
		const bodies = [fields?.body, fields?.data, response?.data, response?.body].map((body) =>
			oauthErrorDetail(body, OAUTH_BODY_KEYS),
		);
		// The thrown error's `code` is often a transport code (`ECONNRESET`, `ERR_BAD_REQUEST`), so it is shown only
		// when it is itself a rejected-login code; a response body's code is the provider's own.
		const detail = [thrown, ...bodies].find(hasPermanentCode) ?? bodies.find((body) => body.code !== undefined) ?? {};
		const rejection = { status: status ?? OAUTH_ERROR_STATUS, ...detail };
		if (isPermanentRefreshRejection(rejection)) {
			return new OAuthRefreshRejectedError(`${providerName} token refresh failed`, rejection, [
				credential.refresh,
				credential.access,
			]);
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return undefined;
}
