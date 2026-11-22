import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { isIPv4, isIPv6 } from "node:net";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import { activityMonitor } from "./activity.js";
import { extractRSCContent } from "./rsc-extract.js";
import { extractPDFToMarkdown, isPDF } from "./pdf-extract.js";
import { extractGitHub } from "./github-extract.js";
import { isYouTubeURL, isYouTubeEnabled, extractYouTube } from "./youtube-extract.js";
import { extractWithUrlContext, extractWithGeminiWeb } from "./gemini-url-context.js";
import { isVideoFile, extractVideo } from "./video-extract.js";
import { extractRequestedFrames } from "./extract-frames.js";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;
const MAX_TEXT_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_RESPONSE_BYTES = 20 * 1024 * 1024;

/**
 * Read a response body, stopping (and closing the connection) as soon as it exceeds `maxBytes`.
 * Returns null when the body is too large, whatever the response headers claimed.
 */
async function readBodyWithinLimit(response: Response, maxBytes: number): Promise<Uint8Array | null> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		total += chunk.value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(chunk.value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function responseTooLarge(sizeBytes: number, overLimit = false): string {
	return `Response too large (${overLimit ? "over " : ""}${Math.round(sizeBytes / 1024 / 1024)}MB)`;
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isHttpUrl(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

function isPrivateIPv4(a: number, b: number): boolean {
	return a === 0 || a === 10 || a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 168);
}

/** The eight 16-bit groups of a canonical (WHATWG-serialized, so dotted-quad-free) IPv6 address. */
function ipv6Groups(address: string): number[] {
	const [head, tail] = address.split("::");
	const parse = (part: string | undefined) => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
	const high = parse(head);
	const low = parse(tail);
	return [...high, ...Array<number>(8 - high.length - low.length).fill(0), ...low];
}

function isPrivateIPv6(address: string): boolean {
	const groups = ipv6Groups(address);
	const [first] = groups;
	if ((first & 0xfe00) === 0xfc00 || (first & 0xff80) === 0xfe80) return true;
	const prefix = groups.slice(0, 6).join(":");
	// IPv4-compatible (which also covers :: and ::1, as 0.0.0.0/8), IPv4-mapped, IPv4-translated, and NAT64.
	const embedsIPv4 = ["0:0:0:0:0:0", "0:0:0:0:0:65535", "0:0:0:0:65535:0", "100:65435:0:0:0:0"].includes(prefix);
	return embedsIPv4 && isPrivateIPv4(groups[6] >> 8, groups[6] & 255);
}

const PRIVATE_HOST_SUFFIX = /(^|\.)(localhost|localdomain|local|internal|lan|home\.arpa)$/;

/**
 * True when a URL must not be handed to a third-party fallback service: it is not http(s), carries
 * credentials, or names a loopback, private, link-local, or intranet host that such a service could
 * not reach anyway. http(s) hosts arrive lowercased, with every IPv4 notation normalized to dotted quads.
 *
 * This is not the fetch tool's address guard (`url-ip-guards.ts` in coding-agent), which refuses every reserved and
 * non-public range. It only keeps addresses that are private to this machine or network away from remote services,
 * so reserved but non-private ranges such as the documentation prefix 2001:db8::/32 count as public here on purpose.
 */
function isPrivateUrl(url: string): boolean {
	const parsed = new URL(url);
	if (!isHttpUrl(parsed) || parsed.username || parsed.password) return true;
	const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
	if (isIPv6(host)) return isPrivateIPv6(host);
	if (isIPv4(host)) {
		const [a, b] = host.split(".").map(Number);
		return isPrivateIPv4(a, b);
	}
	return !host.includes(".") || PRIVATE_HOST_SUFFIX.test(host);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

async function safeVideoInfo(url: string): Promise<{ info: Awaited<ReturnType<typeof isVideoFile>>; error?: string }> {
	try {
		return { info: await isVideoFile(url) };
	} catch (err) {
		return { info: null, error: errorMessage(err) };
	}
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
}

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

async function extractWithJinaReader(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const res = await fetch(jinaUrl, {
			headers: {
				"Accept": "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(JINA_TIMEOUT_MS),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const body = await readBodyWithinLimit(res, MAX_TEXT_RESPONSE_BYTES);
		activityMonitor.logComplete(activityId, res.status);
		if (!body) return null;
		const content = new TextDecoder().decode(body);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}


export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	const localVideo = await safeVideoInfo(url);
	if (localVideo.error) {
		return { url, title: "", content: "", error: localVideo.error };
	}
	// Batch options apply per input: stray video options must not block ordinary URLs.
	if (localVideo.info || isYouTubeURL(url).isYouTube) {
		const frameResult = await extractRequestedFrames(url, options, signal);
		if (frameResult) return frameResult;
	}
	if (localVideo.info) {
		try {
			const result = await extractVideo(localVideo.info, signal, options);
			if (signal?.aborted) return abortedResult(url);
			return result ?? { url, title: "", content: "", error: `Video analysis requires Gemini access. Either:\n  1. Sign into gemini.google.com in Chrome (free, uses cookies)\n  2. Set GEMINI_API_KEY in ~/${CONFIG_DIR_NAME}/web-search.json` };
		} catch (err) {
			if (isAbortError(err)) return abortedResult(url);
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}
	if (!isHttpUrl(parsedUrl)) {
		return { url, title: "", content: "", error: `Unsupported URL scheme: ${parsedUrl.protocol}` };
	}

	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone);
		if (ghResult) return ghResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
	}

	const ytInfo = isYouTubeURL(url);
	let youtubeEnabled = false;
	try {
		youtubeEnabled = await isYouTubeEnabled();
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	if (ytInfo.isYouTube && youtubeEnabled) {
		try {
			const ytResult = await extractYouTube(url, signal, options?.prompt, options?.model);
			if (ytResult) return ytResult;
			if (signal?.aborted) return abortedResult(url);
		} catch (err) {
			const message = errorMessage(err);
			if (isAbortError(err)) return abortedResult(url);
			if (isConfigParseError(err)) {
				return { url, title: "", content: "", error: message };
			}
		}
		return {
			url,
			title: "",
			content: "",
			error: "Could not extract YouTube video content. Sign into Google in Chrome for automatic access, or set GEMINI_API_KEY.",
		};
	}

	if (signal?.aborted) return abortedResult(url);

	const redirects: string[] = [];
	const httpResult = await extractViaHttp(url, signal, options, redirects);

	if (signal?.aborted) return abortedResult(url);
	if (!httpResult.error) return httpResult;
	if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult.error!.startsWith(prefix))) return httpResult;
	// Remote fallbacks cannot reach local hosts, even via a public redirect; sending them the URL would only leak it.
	if ([url, ...redirects].some(isPrivateUrl)) return httpResult;

	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return jinaResult;
	if (signal?.aborted) return abortedResult(url);

	let geminiResult: ExtractedContent | null = null;
	try {
		geminiResult = await extractWithUrlContext(url, signal)
			?? await extractWithGeminiWeb(url, signal);
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { ...httpResult, error: errorMessage(err) };
		}
	}

	if (geminiResult) return geminiResult;
	if (signal?.aborted) return abortedResult(url);

	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		`  \u2022 Set GEMINI_API_KEY in ~/${CONFIG_DIR_NAME}/web-search.json`,
		"  \u2022 Sign into gemini.google.com in Chrome",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
	return { ...httpResult, error: guidance };
}

function stripElementBlocks(html: string, tagName: "script" | "style"): string {
	let output = "";
	let cursor = 0;
	const lower = html.toLowerCase();
	const startNeedle = `<${tagName}`;
	const endNeedle = `</${tagName}`;

	while (cursor < html.length) {
		const start = lower.indexOf(startNeedle, cursor);
		if (start === -1) {
			output += html.slice(cursor);
			break;
		}

		output += html.slice(cursor, start);
		const end = lower.indexOf(endNeedle, start + startNeedle.length);
		if (end === -1) {
			break;
		}

		const endClose = lower.indexOf(">", end + endNeedle.length);
		if (endClose === -1) {
			break;
		}
		cursor = endClose + 1;
	}

	return output;
}

function stripTags(html: string): string {
	let output = "";
	let insideTag = false;
	for (const char of html) {
		if (char === "<") {
			insideTag = true;
			continue;
		}
		if (char === ">") {
			insideTag = false;
			continue;
		}
		if (!insideTag) output += char;
	}
	return output;
}

function collapseWhitespace(text: string): string {
	let output = "";
	let pendingSpace = false;
	for (const char of text) {
		if (/\s/.test(char)) {
			pendingSpace = output.length > 0;
			continue;
		}
		if (pendingSpace) {
			output += " ";
			pendingSpace = false;
		}
		output += char;
	}
	return output.trim();
}

function matchesAsciiCaseInsensitiveAt(text: string, lowerNeedle: string, offset: number): boolean {
	if (offset < 0 || offset + lowerNeedle.length > text.length) return false;
	for (let i = 0; i < lowerNeedle.length; i++) {
		let code = text.charCodeAt(offset + i);
		if (code >= 0x41 && code <= 0x5a) code += 32;
		if (code !== lowerNeedle.charCodeAt(i)) return false;
	}
	return true;
}

function findAsciiCaseInsensitive(text: string, lowerNeedle: string, fromIndex: number): number {
	const limit = text.length - lowerNeedle.length;
	if (fromIndex > limit) return -1;
	const firstChar = lowerNeedle[0]!;
	let pos = fromIndex;
	while (pos <= limit) {
		const idx = text.indexOf(firstChar, pos);
		if (idx === -1 || idx > limit) return -1;
		if (matchesAsciiCaseInsensitiveAt(text, lowerNeedle, idx)) return idx;
		pos = idx + 1;
	}
	return -1;
}

function isBodyTagDelimiter(code: number): boolean {
	return (
		code === 0x3e ||
		code === 0x2f ||
		code === 0x20 ||
		code === 0x09 ||
		code === 0x0a ||
		code === 0x0c ||
		code === 0x0d
	);
}

export function extractHtmlBody(html: string): string | undefined {
	let searchFrom = 0;
	while (searchFrom < html.length) {
		const openStart = findAsciiCaseInsensitive(html, "<body", searchFrom);
		if (openStart === -1) return undefined;
		const afterName = openStart + 5;
		if (afterName >= html.length) return undefined;
		if (!isBodyTagDelimiter(html.charCodeAt(afterName))) {
			searchFrom = afterName;
			continue;
		}
		const openEnd = html.indexOf(">", afterName);
		if (openEnd === -1) return undefined;
		const closeStart = findAsciiCaseInsensitive(html, "</body>", openEnd + 1);
		if (closeStart === -1) return undefined;
		return html.slice(openEnd + 1, closeStart);
	}
	return undefined;
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyHtml = extractHtmlBody(html);
	if (bodyHtml === undefined) return false;

	// Strip tags to get text content
	const textContent = collapseWhitespace(stripTags(stripElementBlocks(stripElementBlocks(bodyHtml, "script"), "style")));

	// Count scripts
	const scriptCount = (html.match(/<script\b/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

/** Fetch `url`, following redirects by hand so every hop is recorded in `redirects`. */
async function fetchFollowingRedirects(url: string, init: RequestInit, redirects: string[]): Promise<Response> {
	let current = url;
	for (;;) {
		const response = await fetch(current, { ...init, redirect: "manual" });
		const location = response.headers.get("location");
		if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
		await response.body?.cancel();
		if (redirects.length === MAX_REDIRECTS) throw new Error("Too many redirects");
		const next = new URL(location, current);
		redirects.push(next.href);
		if (!isHttpUrl(next)) throw new Error(`Unsupported redirect URL scheme: ${next.protocol}`);
		current = next.href;
	}
}

async function extractViaHttp(
	url: string,
	signal: AbortSignal | undefined,
	options: ExtractOptions | undefined,
	redirects: string[],
): Promise<ExtractedContent> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetchFollowingRedirects(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		}, redirects);

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const isPDFContent = isPDF(url, contentType);
		const maxResponseSize = isPDFContent ? MAX_PDF_RESPONSE_BYTES : MAX_TEXT_RESPONSE_BYTES;
		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: responseTooLarge(contentLength),
				};
			}
		}

		if (isPDFContent) {
			try {
				const body = await readBodyWithinLimit(response, maxResponseSize);
				if (!body) {
					activityMonitor.logComplete(activityId, response.status);
					return { url, title: "", content: "", error: responseTooLarge(maxResponseSize, true) };
				}
				const result = await extractPDFToMarkdown(body.buffer as ArrayBuffer, url);
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
					error: null,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const body = await readBodyWithinLimit(response, maxResponseSize);
		if (!body) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: "", content: "", error: responseTooLarge(maxResponseSize, true) };
		}
		const text = new TextDecoder().decode(body);
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: rscResult.title, content: rscResult.content, error: null };
			}

			activityMonitor.logComplete(activityId, response.status);

			// Provide more specific error message
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: "",
				content: "",
				error: errorMsg,
			};
		}

		const markdown = turndown.turndown(article.content ?? "");
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
			};
		}

		return { url, title: article.title || "", content: markdown, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
}
