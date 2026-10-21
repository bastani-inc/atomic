import { isOAuthRefreshRejectedError, type OAuthCredentials, OAuthRefreshRejectedError } from "@bastani/pi-ai";

/** RFC 6749 §5.2: a token endpoint answers an invalid refresh token with HTTP 400 and `invalid_grant`. */
const OAUTH_ERROR_STATUS = 400;
/** HTTP 401 from a token endpoint: the provider no longer accepts this login. */
const UNAUTHORIZED_STATUS = 401;
const REJECTED_GRANT_CODE = "invalid_grant";
const MAX_CAUSE_DEPTH = 5;

type ThrownFields = { readonly [key: string]: unknown };

function fieldsOf(value: unknown): ThrownFields | undefined {
	return typeof value === "object" && value !== null ? (value as ThrownFields) : undefined;
}

function stringField(fields: ThrownFields | undefined, key: string): string | undefined {
	const value = fields?.[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(fields: ThrownFields | undefined, key: string): number | undefined {
	const value = fields?.[key];
	return typeof value === "number" ? value : undefined;
}

function jsonFields(text: string): ThrownFields | undefined {
	try {
		const parsed: string | number | boolean | null | object = JSON.parse(text);
		return fieldsOf(parsed);
	} catch {
		return undefined;
	}
}

/** An OAuth error response (`{ "error": ..., "error_description": ... }`), as an object or JSON text. */
function oauthErrorResponse(body: unknown): { code: string; description?: string } | undefined {
	const fields = typeof body === "string" ? jsonFields(body) : fieldsOf(body);
	const code = stringField(fields, "error");
	return code === undefined ? undefined : { code, description: stringField(fields, "error_description") };
}

/**
 * Maps a rejected login reported by an extension's `refreshToken` in a common error shape onto
 * {@link OAuthRefreshRejectedError}, so it gets the same `/login` guidance as a built-in provider. Recognised on the
 * error or its `cause` chain: an `error` or `code` property of `invalid_grant`; an OAuth error response with
 * `invalid_grant` in `body`, `data`, `response.data`, or `response.body`; or HTTP 401 in `status`, `statusCode`, or
 * `response.status`. Errors that already are an `OAuthRefreshRejectedError` are left as thrown.
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
			numberField(fields, "status") ?? numberField(fields, "statusCode") ?? numberField(response, "status");
		const body = [fields, fields?.body, fields?.data, response?.data, response?.body]
			.map(oauthErrorResponse)
			.find((candidate) => candidate !== undefined);
		// A `code` property is often a transport code (`ECONNRESET`, `ERR_BAD_REQUEST`); only `invalid_grant` is OAuth's.
		const codeProperty = stringField(fields, "code");
		const code = body?.code ?? (codeProperty?.toLowerCase() === REJECTED_GRANT_CODE ? codeProperty : undefined);
		if (code?.toLowerCase() === REJECTED_GRANT_CODE || status === UNAUTHORIZED_STATUS) {
			return new OAuthRefreshRejectedError(
				`${providerName} token refresh failed`,
				{ status: status ?? OAUTH_ERROR_STATUS, code, description: body?.description },
				[credential.refresh, credential.access],
			);
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return undefined;
}
