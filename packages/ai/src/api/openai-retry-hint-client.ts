import OpenAI, { type APIError } from "openai";
import { getRetryAfterMs } from "../utils/retry-hints.ts";

/**
 * OpenAI client whose status errors carry `retryAfterMs` from the full response:
 * the SDK keeps only the body's `error` field, which drops a top-level Cloudflare
 * `retry_after` whenever the body also has an `error` member.
 */
export class RetryHintOpenAI extends OpenAI {
	protected override makeStatusError(
		status: number,
		error: object,
		message: string | undefined,
		headers: Headers,
	): APIError {
		const statusError = super.makeStatusError(status, error, message, headers);
		// The SDK passes `undefined` here when the body is not JSON.
		const body: object | undefined = error;
		const retryAfterMs = getRetryAfterMs(headers, body === undefined ? message : JSON.stringify(body));
		return retryAfterMs === undefined ? statusError : Object.assign(statusError, { retryAfterMs });
	}
}
