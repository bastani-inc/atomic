import { createTimeoutSignal } from "@bastani/atomic-timers";
import { calculateCost } from "../models.ts";
import type {
	ClassifierApi,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ProviderHeaders,
	Usage,
} from "../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { ProviderRetryTransport, retryProviderRequest } from "../utils/provider-retry.ts";
import { getProviderRetryAfterMs } from "../utils/retry-hints.ts";
import { RetryDeadlineError } from "../utils/retry-sleep.ts";
import { findTlsCertificateRefusal, transportFailure } from "../utils/tls-certificate.ts";

export class InvalidClassifierJsonError extends SyntaxError {}

export interface ClassifierHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

function httpError(label: string, response: Response, body: string): ClassifierHttpError {
	const error = new Error(`${label} returned ${response.status}`) as ClassifierHttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): ClassifierHttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as ClassifierHttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

function transportError(cause: Error): ClassifierHttpError {
	const code = (cause as Error & { code?: unknown }).code;
	const detail =
		(typeof code === "string" || typeof code === "number") &&
		cause.cause === undefined &&
		!cause.message.includes(String(code))
			? cause.message
				? `${cause.message} (${code})`
				: String(code)
			: cause.message;
	const error = new Error(detail, { cause }) as ClassifierHttpError;
	error.name = cause.name;
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifierHttpErrorCode(error: Error): string | undefined {
	if (!("body" in error) || typeof error.body !== "string") return undefined;
	try {
		const body: unknown = JSON.parse(error.body);
		if (!isRecord(body)) return undefined;
		const failure = isRecord(body.error) ? body.error : body;
		if (typeof failure.code === "string" && failure.code) return failure.code;
		return typeof failure.type === "string" ? failure.type : undefined;
	} catch {
		return undefined;
	}
}

export function recordClassifierFailure(result: ClassifierResult, error: unknown): void {
	if (!(error instanceof Error) || result.stopReason !== "error") return;
	if ("status" in error && typeof error.status === "number") result.status = error.status;
	// The server-delay-cap error keeps the original HTTP error as its cause.
	const original = "retryAfterMs" in error && error.cause instanceof Error ? error.cause : error;
	const code = classifierHttpErrorCode(original);
	const retryAfterMs = getProviderRetryAfterMs(error);
	if (code !== undefined) result.code = code;
	if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
}

export function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

interface ClassifierRequestRules {
	apiKeyHeader?: string;
	noRetryStatuses?: readonly number[];
	maxRequestBytes?: number;
	noRetry?: (error: Error) => boolean;
}

function requestHeaders(
	model: ClassifierModel<ClassifierApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	apiKeyHeader?: string,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			getIdentityHeaders(model, identity),
			{
				"content-type": "application/json",
				...(apiKeyHeader ? { [apiKeyHeader]: apiKey } : { authorization: `Bearer ${apiKey}` }),
			},
			model.headers,
			optionsHeaders,
		) ?? {}
	);
}

export async function postClassifierRequest(
	label: string,
	url: URL,
	model: ClassifierModel<ClassifierApi>,
	body: unknown,
	options: ClassifierOptions | undefined,
	rules?: ClassifierRequestRules,
): Promise<unknown> {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const apiKey = options.apiKey;
	let payload = body;
	const transformed = await options.onPayload?.(payload, model);
	if (transformed !== undefined) payload = transformed;
	const serialized = JSON.stringify(payload);
	if (
		rules?.maxRequestBytes !== undefined &&
		serialized.length > rules.maxRequestBytes / 3 &&
		(serialized.length > rules.maxRequestBytes || new TextEncoder().encode(serialized).length > rules.maxRequestBytes)
	) {
		throw Object.assign(new Error(`${label} accepts at most ${rules.maxRequestBytes} bytes per request`), {
			code: "request_too_large",
		});
	}
	const retryTransport = ProviderRetryTransport.for(options);
	const requestFetch = retryTransport?.fetch ?? options.fetch ?? globalThis.fetch;
	const { response, json } = await retryProviderRequest(
		async () => {
			const timeout = options.timeoutMs !== undefined ? createTimeoutSignal(options.timeoutMs) : undefined;
			const timeoutSignal = timeout?.signal;
			const signal =
				options.signal && timeoutSignal
					? AbortSignal.any([options.signal, timeoutSignal])
					: (options.signal ?? timeoutSignal);
			try {
				const next = await requestFetch(url, {
					method: "POST",
					headers: requestHeaders(model, apiKey, options.headers, options.identity, rules?.apiKeyHeader),
					body: serialized,
					signal,
				});
				if (!next.ok) throw httpError(label, next, await next.text());
				try {
					return { response: next, json: (await next.json()) as unknown };
				} catch (error) {
					if (error instanceof SyntaxError) throw new InvalidClassifierJsonError(error.message, { cause: error });
					throw error;
				}
			} catch (error) {
				if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs!);
				if (options.signal?.aborted) throw error;
				if (
					error instanceof RetryDeadlineError ||
					(error instanceof Error && error.name === "AbortError") ||
					error instanceof SyntaxError
				) {
					throw error;
				}
				if (error instanceof Error && !("status" in error) && !("headers" in error)) {
					if (findTlsCertificateRefusal(error) !== undefined) throw error;
					const failure = transportFailure(error, url);
					if (findTlsCertificateRefusal(failure) !== undefined) throw failure;
					throw transportError(error);
				}
				throw error;
			} finally {
				timeout?.clear();
			}
		},
		{
			maxRetries: options.maxRetries ?? 2,
			maxRetryDelayMs: options.maxRetryDelayMs,
			signal: options.signal,
			noRetryStatuses: rules?.noRetryStatuses,
			noRetry: rules?.noRetry,
		},
		retryTransport,
	);
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return json;
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseClassifierUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const input = tokenCount(value.input_tokens);
	const output = tokenCount(value.output_tokens);
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
