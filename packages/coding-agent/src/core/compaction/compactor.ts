import { lookup } from "node:dns/promises";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { CompactorApi } from "@bastani/atomic-ai";
import type { Usage } from "@bastani/atomic-ai/compat";
import { redactCredentialShapes } from "../../utils/credential-redaction.js";
import { messageIsLlmVisible } from "../messages.ts";
import { CompactionCancelledError, CompactorFailure } from "./errors.js";

export { CompactorFailure };

/** Default wall-clock bound on one compactor request unless overridden by model `timeoutMs`; past it the context is cleared instead. */
export const COMPACTOR_REQUEST_TIMEOUT_MS = 120_000;
/** Lines longer than this are wrapped before they are sent, so the compactor can keep or drop parts of them. */
export const COMPACTOR_LINE_WIDTH = 2_000;
/** Default upper bound on compacted text, in estimated tokens, unless overridden by model `maxTokens`. Longer output is a failure and the context is cleared. */
export const COMPACTED_OUTPUT_MAX_TOKENS = 32_000;
/** Compacted text never fills more than this share of the context the automatic trigger allows. */
export const COMPACTED_OUTPUT_MAX_TRIGGER_SHARE = 0.5;

const DEFAULT_COMPACTOR_ENDPOINT_PATH = "/compact";
const HTTP_ERROR_EXCERPT_MAX_CHARS = 500;
const HTTP_ERROR_BODY_MAX_BYTES = 8192;
const SENSITIVE_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"]);

export interface CompactorMessage {
	role: "user" | "assistant";
	content: string;
}

/** Splits every line longer than `width` characters into parts of at most `width` characters. */
export function wrapLongLines(text: string, width = COMPACTOR_LINE_WIDTH): string {
	return text
		.split(/\r?\n/u)
		.flatMap((line) => {
			const parts: string[] = [];
			for (let start = 0; start < line.length; start += width) parts.push(line.slice(start, start + width));
			return parts.length > 0 ? parts : [""];
		})
		.join("\n");
}

interface TextLikeBlock {
	readonly type: string;
	readonly text?: string;
	readonly mimeType?: string;
	readonly name?: string;
	readonly arguments?: Record<string, string | number | boolean | null | object>;
}

function blockText(block: TextLikeBlock): string | undefined {
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "image") {
		return `[Image omitted from text compaction${typeof block.mimeType === "string" ? ` (${block.mimeType})` : ""}]`;
	}
	return undefined;
}

function contentText(content: string | readonly TextLikeBlock[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => blockText(block) ?? []).join("\n");
}

function toolArguments(args: TextLikeBlock["arguments"]): string {
	if (!args) return "";
	return Object.entries(args)
		.map(([key, value]) => `${key}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`)
		.join("\n");
}

function assistantText(content: readonly TextLikeBlock[]): string {
	return content
		.flatMap((block) => {
			if (block.type === "text" && typeof block.text === "string") return [block.text];
			if (block.type === "toolCall")
				return [`[Tool call: ${block.name ?? "unknown"}]\n${toolArguments(block.arguments)}`];
			return [];
		})
		.join("\n\n");
}

function framed(role: CompactorMessage["role"], label: string, body: string): CompactorMessage {
	const text = wrapLongLines(body.trim());
	return { role, content: `<keepContext>\n${label}\n</keepContext>${text ? `\n${text}` : ""}` };
}

function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ");
}

/** Whether a message is a compaction boundary's text rather than conversation. */
export type IsBoundaryMessage = (message: AgentMessage) => boolean;

function compactorMessage(message: AgentMessage, isBoundary: IsBoundaryMessage): CompactorMessage | undefined {
	switch (message.role) {
		case "user":
			return framed("user", "[User]", contentText(message.content as string | readonly TextLikeBlock[]));
		case "assistant":
			return framed("assistant", "[Assistant]", assistantText(message.content as readonly TextLikeBlock[]));
		case "toolResult":
			return framed(
				"user",
				`[Tool result: ${singleLine(message.toolName)}${message.isError ? " (error)" : ""}]`,
				contentText(message.content as readonly TextLikeBlock[]),
			);
		case "bashExecution": {
			const exit = typeof message.exitCode === "number" ? `\nExit code: ${message.exitCode}` : "";
			return framed("user", "[Shell execution]", `$ ${message.command}\n${message.output}${exit}`);
		}
		case "custom": {
			const text = contentText(message.content as string | readonly TextLikeBlock[]);
			return isBoundary(message)
				? framed("user", "[Previously compacted history]", text)
				: framed("user", `[Extension context: ${singleLine(message.customType)}]`, text);
		}
		case "branchSummary":
			return framed("user", "[Previous branch summary]", message.summary);
		default:
			return undefined;
	}
}

/**
 * Frame every message of the current context window for the compactor: the previous boundary's text first, then each
 * message since, labelled by kind. The labels sit in `<keepContext>` tags so the compactor keeps them; images become an
 * omission marker, thinking is left out, and very long lines are wrapped.
 */
export function buildCompactorMessages(
	messages: readonly AgentMessage[],
	isBoundary: IsBoundaryMessage,
): CompactorMessage[] {
	const boundaries = messages.filter((message) => message.role === "custom" && isBoundary(message));
	const rest = messages.filter((message) => !(message.role === "custom" && isBoundary(message)));
	return [...boundaries, ...rest].flatMap((message) =>
		messageIsLlmVisible(message) ? (compactorMessage(message, isBoundary) ?? []) : [],
	);
}

/** Largest compacted text, in estimated tokens, for a model whose automatic trigger fires above `triggerTokens`. */
export function compactedOutputTokenCap(triggerTokens: number, maxOutputTokens = COMPACTED_OUTPUT_MAX_TOKENS): number {
	const limit =
		Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : COMPACTED_OUTPUT_MAX_TOKENS;
	return Math.max(0, Math.min(limit, Math.floor(triggerTokens * COMPACTED_OUTPUT_MAX_TRIGGER_SHARE)));
}

/** A conservative token estimate for text: four characters per token, one per character outside ASCII. */
export function estimateTextTokens(text: string): number {
	let dense = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) dense++;
	return Math.ceil((text.length - dense) / 4) + dense;
}

function collectSecrets(apiKey: string | undefined, headers: Record<string, string> | undefined): string[] {
	const secrets: string[] = [];
	if (apiKey) secrets.push(apiKey);
	if (headers) {
		for (const [name, value] of Object.entries(headers)) {
			if (!value) continue;
			if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
				secrets.push(value);
				const trimmed = value.trim();
				if (trimmed.slice(0, 7).toLowerCase() === "bearer ") {
					const token = trimmed.slice(7).trim();
					if (token) secrets.push(token);
				}
			}
		}
	}
	return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

function redact(text: string, secrets: readonly string[]): string {
	let cleaned = text;
	for (const secret of secrets) {
		if (secret) cleaned = cleaned.replaceAll(secret, "[redacted]");
	}
	return redactCredentialShapes(cleaned);
}

async function readHttpErrorBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (bytes < HTTP_ERROR_BODY_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			const remaining = HTTP_ERROR_BODY_MAX_BYTES - bytes;
			text += decoder.decode(value.subarray(0, remaining), { stream: true });
			bytes += value.length;
		}
		const completeLinesEnd = Math.max(0, text.lastIndexOf("\n"));
		return text.slice(0, completeLinesEnd);
	} catch {
		return "";
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function httpErrorMessage(response: Response, secrets: readonly string[]): Promise<string> {
	const body = await readHttpErrorBody(response);
	const excerpt = redact(body, secrets)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, HTTP_ERROR_EXCERPT_MAX_CHARS);
	return `HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`;
}

interface CompactorResponse {
	output?: string;
	messages?: { content?: string }[];
	usage?: { input_tokens?: number; output_tokens?: number };
}

function compactorUsage(usage: CompactorResponse["usage"]): Usage | undefined {
	const input = usage?.input_tokens;
	const output = usage?.output_tokens;
	if (typeof input !== "number" || typeof output !== "number") return undefined;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function responseText(body: CompactorResponse): string {
	const parts = Array.isArray(body.messages)
		? body.messages.flatMap((message) =>
				typeof message?.content === "string" && message.content.trim() ? [message.content.trim()] : [],
			)
		: [];
	return (parts.length > 0 ? parts.join("\n\n") : typeof body.output === "string" ? body.output : "").trim();
}

export interface CompactorRequest {
	readonly apiKey: string | undefined;
	/** Compactor API identifier. */
	readonly api?: CompactorApi;
	/** The compactor model's id, sent as `model`. */
	readonly modelId: string;
	/** The compactor model's base URL; the request goes to `<baseUrl><endpointPath>`. */
	readonly baseUrl: string;
	/** Path appended to `baseUrl` (default `"/compact"`). Pass `""` to POST directly to `baseUrl`. */
	readonly endpointPath?: string;
	/** Additional or overridden API-specific request body parameters. */
	readonly params?: Record<string, unknown>;
	/** Optional resolved headers merged into the request (supporting custom auth headers or metadata). */
	readonly headers?: Record<string, string>;
	readonly messages: readonly CompactorMessage[];
	readonly query: string;
	/** Aborts when the compaction itself is cancelled; that is a cancel, not a failure. */
	readonly signal: AbortSignal;
	/** Stops this request only; that is a failure (`request aborted`) and the context is cleared instead. */
	readonly stop?: AbortSignal;
	readonly timeoutMs?: number;
	readonly fetchFn?: typeof fetch;
	/** Resolves a host name to its addresses; used only to explain a network failure. */
	readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

const SINKHOLE_ADDRESSES = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);
const HOST_RESOLVE_MAX_WAIT_MS = 2_000;
const CAUSE_CHAIN_MAX_DEPTH = 4;

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
	const addresses = await lookup(hostname, { all: true });
	return addresses.map((entry) => entry.address);
}

interface ErrorWithCause {
	readonly message?: unknown;
	readonly code?: unknown;
	readonly cause?: unknown;
}

/** `fetch failed` alone names no reason; the reason is on the cause chain (`ENOTFOUND`, a TLS alert, a refused connection). */
function describeWithCauses(error: Error): string {
	const parts = [error.message || error.name];
	let cause: unknown = error.cause;
	for (let depth = 0; depth < CAUSE_CHAIN_MAX_DEPTH && typeof cause === "object" && cause !== null; depth++) {
		const { message, code, cause: next } = cause as ErrorWithCause;
		const text = typeof message === "string" ? (message.trim().split("\n")[0] ?? "") : "";
		const label = typeof code === "string" && !text.includes(code) ? `${code}: ${text}` : text;
		if (label && !parts.includes(label)) parts.push(label);
		cause = next;
	}
	return parts.join(": ");
}

/** Names a DNS filter as the reason when the endpoint's host resolves only to an unroutable sinkhole address. */
async function sinkholeHint(
	url: string,
	resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<string> {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return "";
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const addresses = await Promise.race([
			resolveHost(hostname),
			new Promise<readonly string[]>((resolve) => {
				timer = setTimeout(() => resolve([]), HOST_RESOLVE_MAX_WAIT_MS);
				timer.unref?.();
			}),
		]);
		if (addresses.length === 0 || !addresses.every((address) => SINKHOLE_ADDRESSES.has(address))) return "";
		return ` (${hostname} resolves to ${addresses[0]}, the address DNS filters such as NextDNS, Pi-hole or AdGuard return for blocked domains; allow ${hostname} in the resolver)`;
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

function trimTrailingSlashes(url: string): string {
	let end = url.length;
	while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
	return url.slice(0, end);
}

function resolveCompactorUrl(baseUrl: string, endpointPath: string | undefined): string {
	const base = trimTrailingSlashes(baseUrl);
	const path = endpointPath === undefined ? DEFAULT_COMPACTOR_ENDPOINT_PATH : endpointPath.trim();
	if (!path) return base;
	return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, target: string): boolean {
	const lower = target.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function buildCompactorPayload(request: CompactorRequest): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	if (request.params) {
		for (const [key, value] of Object.entries(request.params)) {
			if (value !== undefined) payload[key] = value;
		}
	}
	payload.messages = request.messages;
	payload.query = request.query;
	payload.model = request.modelId;
	return payload;
}

/**
 * Send the framed conversation to a compactor endpoint and return its text. Throws {@link CompactorFailure} (a
 * {@link CompactionError}) naming the reason for every failure (missing baseUrl, no credentials, HTTP error, malformed
 * or empty output, timeout), and {@link CompactionCancelledError} when `signal` aborts. Credentials never appear in a
 * thrown message.
 */
export async function requestCompactorOutput(request: CompactorRequest): Promise<{ text: string; usage?: Usage }> {
	if (request.signal.aborted) throw new CompactionCancelledError({ reason: "aborted" });
	const baseUrl = request.baseUrl?.trim();
	if (!baseUrl) {
		throw new CompactorFailure("no baseUrl configured for compactor model", {
			code: "missing-base-url",
			model: request.modelId,
		});
	}
	const apiKey = request.apiKey;
	const customHeaders = request.headers;
	const hasCustomHeaders = customHeaders !== undefined && Object.keys(customHeaders).length > 0;
	if (!apiKey && !hasCustomHeaders) {
		throw new CompactorFailure("no credentials (use /login or the provider's API key variable)", {
			code: "missing-credentials",
			model: request.modelId,
		});
	}
	const secrets = collectSecrets(apiKey, customHeaders);
	const timeoutMs =
		request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
			? request.timeoutMs
			: COMPACTOR_REQUEST_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([request.signal, timeout, ...(request.stop ? [request.stop] : [])]);
	const failure = (
		error: Error | string,
		options?: { code?: "http-error" | "network-error"; status?: number },
	): never => {
		if (request.signal.aborted) throw new CompactionCancelledError({ reason: "aborted" });
		if (request.stop?.aborted) {
			throw new CompactorFailure("request aborted", { code: "request-aborted", model: request.modelId });
		}
		if (timeout.aborted) {
			throw new CompactorFailure(`timed out after ${timeoutMs} ms`, {
				code: "timeout",
				timeoutMs,
				model: request.modelId,
			});
		}
		const message = typeof error === "string" ? error : error.message || error.name;
		throw new CompactorFailure(redact(message, secrets), {
			code: options?.code ?? "network-error",
			...(options?.status !== undefined ? { status: options.status } : {}),
			model: request.modelId,
		});
	};
	const url = resolveCompactorUrl(baseUrl, request.endpointPath);
	const headers: Record<string, string> = { "Content-Type": "application/json", ...customHeaders };
	if (apiKey && !hasHeaderCaseInsensitive(headers, "authorization")) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	let response: Response;
	try {
		response = await (request.fetchFn ?? fetch)(url, {
			method: "POST",
			headers,
			body: JSON.stringify(buildCompactorPayload(request)),
			signal,
		});
	} catch (error) {
		if (!(error instanceof Error) || signal.aborted) {
			return failure(error instanceof Error ? error : String(error), { code: "network-error" });
		}
		const hint = await sinkholeHint(url, request.resolveHost ?? resolveHostAddresses);
		return failure(`${describeWithCauses(error)}${hint}`, { code: "network-error" });
	}
	if (!response.ok) {
		return failure(await httpErrorMessage(response, secrets), { code: "http-error", status: response.status });
	}
	let body: CompactorResponse;
	try {
		body = (await response.json()) as CompactorResponse;
	} catch (error) {
		if (request.signal.aborted || timeout.aborted) return failure(error instanceof Error ? error : String(error));
		throw new CompactorFailure("malformed response", { code: "malformed-response", model: request.modelId });
	}
	if (request.signal.aborted) throw new CompactionCancelledError({ reason: "aborted" });
	if (typeof body !== "object" || body === null) {
		throw new CompactorFailure("malformed response", { code: "malformed-response", model: request.modelId });
	}
	let text = responseText(body);
	for (const secret of secrets) {
		if (secret) text = text.replaceAll(secret, "[redacted]");
	}
	if (!text) throw new CompactorFailure("empty output", { code: "empty-output", model: request.modelId });
	const usage = compactorUsage(body.usage);
	return { text, ...(usage ? { usage } : {}) };
}
