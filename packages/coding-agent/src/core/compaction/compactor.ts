import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { Usage } from "@bastani/atomic-ai/compat";
import { redactCredentialShapes } from "../../utils/credential-redaction.js";
import { messageIsLlmVisible } from "../messages.ts";

/** Share of the conversation the compactor keeps. A constant, not a setting. */
export const COMPACTOR_COMPRESSION_RATIO = 0.5;
/** Wall-clock bound on one compactor request; past it the context is cleared instead. */
export const COMPACTOR_REQUEST_TIMEOUT_MS = 120_000;
/** Lines longer than this are wrapped before they are sent, so the compactor can keep or drop parts of them. */
export const COMPACTOR_LINE_WIDTH = 2_000;
/** Upper bound on compacted text, in estimated tokens. Longer output is a failure and the context is cleared. */
export const COMPACTED_OUTPUT_MAX_TOKENS = 32_000;
/** Compacted text never fills more than this share of the context the automatic trigger allows. */
export const COMPACTED_OUTPUT_MAX_TRIGGER_SHARE = 0.5;

const DEFAULT_COMPACTOR_BASE_URL = "https://api.morphllm.com/v1";
const HTTP_ERROR_EXCERPT_MAX_CHARS = 500;
const HTTP_ERROR_BODY_MAX_BYTES = 8192;

export interface CompactorMessage {
	role: "user" | "assistant";
	content: string;
}

/** Why a compactor request produced no usable text. The context is cleared instead. */
export class CompactorFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompactorFailure";
	}
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
export function compactedOutputTokenCap(triggerTokens: number): number {
	return Math.max(
		0,
		Math.min(COMPACTED_OUTPUT_MAX_TOKENS, Math.floor(triggerTokens * COMPACTED_OUTPUT_MAX_TRIGGER_SHARE)),
	);
}

/** A conservative token estimate for text: four characters per token, one per character outside ASCII. */
export function estimateTextTokens(text: string): number {
	let dense = 0;
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) dense++;
	return Math.ceil((text.length - dense) / 4) + dense;
}

function redact(text: string, apiKey: string): string {
	return redactCredentialShapes(apiKey ? text.replaceAll(apiKey, "[redacted]") : text);
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

async function httpErrorMessage(response: Response, apiKey: string): Promise<string> {
	const body = await readHttpErrorBody(response);
	const excerpt = redact(body, apiKey)
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
	/** The compactor model's id, sent as `model`. */
	readonly modelId: string;
	/** The compactor model's base URL; the request goes to `<baseUrl>/compact`. */
	readonly baseUrl?: string;
	readonly messages: readonly CompactorMessage[];
	readonly query: string;
	/** Aborts when the compaction itself is cancelled; that is a cancel, not a failure. */
	readonly signal: AbortSignal;
	/** Stops this request only; that is a failure (`request aborted`) and the context is cleared instead. */
	readonly stop?: AbortSignal;
	readonly timeoutMs?: number;
	readonly fetchFn?: typeof fetch;
}

/**
 * Send the framed conversation to a compactor endpoint and return its text. Throws `CompactorFailure` naming the
 * reason for every failure (no credentials, HTTP error, malformed or empty output, timeout), and `Compaction cancelled`
 * when `signal` aborts. The API key never appears in a thrown message.
 */
export async function requestCompactorOutput(request: CompactorRequest): Promise<{ text: string; usage?: Usage }> {
	if (request.signal.aborted) throw new Error("Compaction cancelled");
	const apiKey = request.apiKey;
	if (!apiKey) throw new CompactorFailure("no credentials (use /login or the provider's API key variable)");
	const timeoutMs = request.timeoutMs ?? COMPACTOR_REQUEST_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([request.signal, timeout, ...(request.stop ? [request.stop] : [])]);
	const failure = (error: Error | string): never => {
		if (request.signal.aborted) throw new Error("Compaction cancelled");
		if (request.stop?.aborted) throw new CompactorFailure("request aborted");
		if (timeout.aborted) throw new CompactorFailure(`timed out after ${timeoutMs} ms`);
		const message = typeof error === "string" ? error : error.message || error.name;
		throw new CompactorFailure(redact(message, apiKey));
	};
	const baseUrl = (request.baseUrl ?? DEFAULT_COMPACTOR_BASE_URL).replace(/\/+$/, "");
	let response: Response;
	try {
		response = await (request.fetchFn ?? fetch)(`${baseUrl}/compact`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: request.messages,
				query: request.query,
				compression_ratio: COMPACTOR_COMPRESSION_RATIO,
				preserve_recent: 0,
				include_markers: true,
				include_line_ranges: false,
				model: request.modelId,
			}),
			signal,
		});
	} catch (error) {
		return failure(error instanceof Error ? error : String(error));
	}
	if (!response.ok) return failure(await httpErrorMessage(response, apiKey));
	let body: CompactorResponse;
	try {
		body = (await response.json()) as CompactorResponse;
	} catch (error) {
		if (request.signal.aborted || timeout.aborted) return failure(error instanceof Error ? error : String(error));
		throw new CompactorFailure("malformed response");
	}
	if (request.signal.aborted) throw new Error("Compaction cancelled");
	if (typeof body !== "object" || body === null) throw new CompactorFailure("malformed response");
	// The output becomes context and history, so a credential the endpoint echoed back must not survive in it.
	const text = responseText(body).replaceAll(apiKey, "[redacted]");
	if (!text) throw new CompactorFailure("empty output");
	const usage = compactorUsage(body.usage);
	return { text, ...(usage ? { usage } : {}) };
}
