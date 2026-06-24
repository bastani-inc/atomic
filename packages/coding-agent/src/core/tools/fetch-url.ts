/// <reference path="../../utils/turndown.d.ts" />
/**
 * URL fetch / cache / artifact / markdown-discovery pipeline, mirrored from
 * oh-my-pi's `packages/coding-agent/src/tools/fetch.ts` at 15b5c1397fc.
 *
 * Responsibilities:
 *  - parseReadUrlTarget: URL + line selectors (:raw, :N, :A-B, :A+B, :A-B,C-D),
 *    collapsed-scheme repair, host-port protection.
 *  - session-scoped LRU cache keyed by `<scope>::<raw|rendered>::<normalizedUrl>`,
 *    cached under both requested and final (redirected) URLs.
 *  - renderUrl: markdown discovery (alternate <link>, .md suffix, content
 *    negotiation, llms.txt/llms.md endpoints) + native HTML-to-markdown, with
 *    quality gating.
 *  - artifact persistence of the rendered output, with artifactId surfaced in
 *    truncation metadata when the visible output is head-truncated.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LRUCache } from "lru-cache";
import TurndownService from "turndown";
import { Agent, type Dispatcher } from "undici";
import { getArtifactManager } from "./artifacts.ts";
import { extractDocumentMarkdown, isDocumentPath } from "./read-document-extract.ts";
import type { TruncationResult } from "./truncate.ts";

export const FETCH_DEFAULT_MAX_LINES = 300;
export const READ_URL_CACHE_MAX_ENTRIES = 100;
const REMOTE_FETCH_TIMEOUT_MS = 10_000;
const MAX_URL_REDIRECTS = 5;
const MAX_URL_RESPONSE_BYTES = 10 * 1024 * 1024;
const MIN_CONTENT_LENGTH = 100;

export interface LineRange { start: number; end?: number }

export interface ParsedReadUrlTarget {
	url: string;
	raw: boolean;
	offset?: number;
	limit?: number;
	ranges?: readonly LineRange[];
}

export interface ReadUrlToolDetails {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: { artifactId?: string; truncation?: TruncationResult };
}

interface ReadUrlCacheEntry {
	artifactId?: string;
	details: ReadUrlToolDetails;
	output: string;
}

export interface LoadedPage {
	ok: boolean;
	status: number;
	content: string;
	contentType: string;
	finalUrl: string;
}

const readUrlCache = new LRUCache<string, ReadUrlCacheEntry>({ max: READ_URL_CACHE_MAX_ENTRIES });
let turndown: TurndownService | undefined;
function getTurndown(): TurndownService {
	if (!turndown) turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	return turndown;
}

export function repairCollapsedScheme(url: string): string {
	return url.replace(/^(https?):\/([^/])/i, "$1://$2");
}

export function isReadableUrlPath(readPath: string): boolean {
	const repaired = repairCollapsedScheme(readPath);
	return /^https?:\/\//i.test(repaired) || /^www\./i.test(readPath);
}

function normalizeUrlForCache(url: string): string {
	const repaired = repairCollapsedScheme(url);
	return /^https?:\/\//i.test(repaired) ? repaired : `https://${repaired}`;
}
const RANGE_TOKEN_RE = /^(raw|\d+(?:\+(?:\d+)|(?:-|\.\.)\d+)?)$/i;
const MULTI_RANGE_RE = /^\d+(?:(?:-|\.\.|,|\+)\d+)*$/;

function isUrlSelectorToken(token: string): boolean {
	return /^raw$/i.test(token) || RANGE_TOKEN_RE.test(token) || MULTI_RANGE_RE.test(token);
}

function parseSingleRange(token: string): LineRange | undefined {
	const plus = token.match(/^(\d+)\+(\d+)$/);
	if (plus) {
		const start = Number.parseInt(plus[1]!, 10), count = Number.parseInt(plus[2]!, 10);
		return start < 1 || count < 1 ? undefined : { start, end: start + count - 1 };
	}
	const range = token.match(/^(\d+)(?:-|\.\.)(\d+)$/);
	if (range) { const start = Number.parseInt(range[1]!, 10); const end = Number.parseInt(range[2]!, 10); return start < 1 || end < start ? undefined : { start, end }; }
	const single = token.match(/^(\d+)$/);
	if (single) { const start = Number.parseInt(single[1]!, 10); return start < 1 ? undefined : { start }; }
	return undefined;
}

function parseRangeGroup(token: string): LineRange[] | undefined {
	const groups = token.split(",");
	const ranges: LineRange[] = [];
	for (const group of groups) { const r = parseSingleRange(group); if (!r) return undefined; ranges.push(r); }
	return ranges;
}

function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	for (;;) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;
		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder) || !isUrlSelectorToken(candidate)) break;
		try { new URL(remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`); } catch { break; }
		sels.unshift(candidate);
		basePath = remainder;
	}
	return sels.length === 0 ? null : { path: basePath, sels };
}

export function parseReadUrlTarget(readPath: string): ParsedReadUrlTarget | null {
	const repaired = repairCollapsedScheme(readPath);
	const embedded = tryExtractEmbeddedUrlSelector(repaired);
	const urlPath = embedded?.path ?? repaired;
	if (!isReadableUrlPath(urlPath)) return null;
	let raw = false;
	let ranges: LineRange[] | undefined;
	for (const sel of embedded?.sels ?? []) {
		if (/^raw$/i.test(sel)) { raw = true; continue; }
		if (ranges !== undefined) throw new Error("URL selector has multiple range groups; combine them with commas (e.g. `:5-10,20-30`).");
		const parsed = parseRangeGroup(sel);
		if (!parsed) throw new Error(`Invalid URL line selector: ${sel}`);
		ranges = parsed;
	}
	if (!ranges || ranges.length === 0) return { url: urlPath, raw };
	if (ranges.length === 1) {
		const r = ranges[0]!;
		return { url: urlPath, raw, offset: r.start, limit: r.end !== undefined ? r.end - r.start + 1 : undefined };
	}
	return { url: urlPath, raw, ranges };
}

export function getReadUrlCacheKey(scope: string, requestedUrl: string, raw: boolean): string {
	return `${scope}::${raw ? "raw" : "rendered"}::${normalizeUrlForCache(requestedUrl)}`;
}

function looksLikeHtml(text: string): boolean {
	return /<html[\s>]/i.test(text) || (/<head[\s>]/i.test(text) && /<body[\s>]/i.test(text));
}

function documentExtensionFromContentType(contentType: string): string | undefined {
	if (/pdf/i.test(contentType)) return ".pdf";
	if (/msword/i.test(contentType)) return ".doc";
	if (/wordprocessingml|officedocument\.word/i.test(contentType)) return ".docx";
	if (/presentationml|officedocument\.presentation/i.test(contentType)) return ".pptx";
	if (/ms-powerpoint|vnd\.ms-powerpoint/i.test(contentType)) return ".ppt";
	if (/spreadsheetml|officedocument\.spreadsheet/i.test(contentType)) return ".xlsx";
	if (/ms-excel|vnd\.ms-excel/i.test(contentType)) return ".xls";
	if (/epub/i.test(contentType)) return ".epub";
	if (/\bjson\b|ipynb|jupyter/i.test(contentType)) return ".ipynb";
	if (/rtf/i.test(contentType)) return ".rtf";
	return undefined;
}

interface SafeFetchAddress { address: string; family: 4 | 6 }
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | SafeFetchAddress[], family?: number) => void;

function ipFamily(address: string): 4 | 6 { return address.includes(":") ? 6 : 4; }

function createPinnedDispatcher(pinned: SafeFetchAddress): Agent {
	return new Agent({ connect: { lookup: (_hostname: string, options: { all?: boolean }, callback: LookupCallback) => { if (options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family); } } });
}
async function closePinnedDispatcher(dispatcher: Agent | undefined): Promise<void> {
	const close = (dispatcher as { close?: () => Promise<void> | void } | undefined)?.close;
	if (typeof close === "function") await close.call(dispatcher);
}

function isPrivateIpAddress(address: string): boolean {
	if (address.includes(":")) {
		const lower = address.toLowerCase();
		if (lower === "::" || lower === "::1" || lower === "0:0:0:0:0:0:0:1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
		const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
		const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hexMapped) {
			const high = Number.parseInt(hexMapped[1]!, 16), low = Number.parseInt(hexMapped[2]!, 16);
			return isPrivateIpAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
		}
		return mapped ? isPrivateIpAddress(mapped) : false;
	}
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
	const [a, b] = parts as [number, number, number, number];
	return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

async function assertSafeFetchUrl(url: string): Promise<SafeFetchAddress | undefined> {
	if (process.env.ATOMIC_ALLOW_PRIVATE_URL_READS === "1") return undefined;
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") throw new Error(`Refusing to fetch private or metadata URL: ${url}`);
	if (isIP(hostname)) { if (isPrivateIpAddress(hostname)) throw new Error(`Refusing to fetch private or metadata URL: ${url}`); return { address: hostname, family: ipFamily(hostname) }; }
	const addresses = await lookup(hostname, { all: true }).catch((error: unknown) => { throw new Error(`Could not resolve URL host ${hostname}: ${error instanceof Error ? error.message : String(error)}`); });
	if (addresses.length === 0) throw new Error(`Could not resolve URL host ${hostname}: no addresses returned`);
	for (const address of addresses) if (isPrivateIpAddress(address.address)) throw new Error(`Refusing to fetch private or metadata URL: ${url}`);
	const first = addresses[0]!;
	return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

async function readResponseTextWithLimit(response: Response): Promise<string> {
	if (!response.body) { const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > MAX_URL_RESPONSE_BYTES) throw new Error(`URL response exceeds ${MAX_URL_RESPONSE_BYTES} byte limit`); return buffer.toString("utf8"); }
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let totalBytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_URL_RESPONSE_BYTES) { await reader.cancel(); throw new Error(`URL response exceeds ${MAX_URL_RESPONSE_BYTES} byte limit`); }
		chunks.push(decoder.decode(value, { stream: true }));
	}
	chunks.push(decoder.decode());
	return chunks.join("");
}
export async function loadPage(url: string, timeoutMs: number, signal?: AbortSignal, accept?: string): Promise<LoadedPage> {
	url = normalizeUrlForCache(url);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, REMOTE_FETCH_TIMEOUT_MS));
	const onParentAbort = () => controller.abort();
	signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		let currentUrl = url;
		for (let redirects = 0; redirects <= MAX_URL_REDIRECTS; redirects++) {
			const pinned = await assertSafeFetchUrl(currentUrl);
			const dispatcher = pinned ? createPinnedDispatcher(pinned) : undefined;
			try {
				const response = await fetch(currentUrl, { signal: controller.signal, headers: accept ? { Accept: accept } : undefined, redirect: "manual", ...(dispatcher ? { dispatcher } : {}) } as RequestInit & { dispatcher?: Dispatcher });
				if (response.status >= 300 && response.status < 400 && response.headers.get("location")) { await response.body?.cancel().catch(() => {}); currentUrl = new URL(response.headers.get("location")!, currentUrl).href; continue; }
				const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
				if (contentLength > MAX_URL_RESPONSE_BYTES) throw new Error(`URL response exceeds ${MAX_URL_RESPONSE_BYTES} byte limit: ${currentUrl}`);
				const contentType = response.headers.get("content-type") ?? "";
				const content = await readResponseTextWithLimit(response);
				return { ok: response.ok, status: response.status, content, contentType, finalUrl: response.url || currentUrl };
			} finally {
				await closePinnedDispatcher(dispatcher).catch(() => undefined);
			}
		}
		throw new Error(`Too many redirects while fetching URL: ${url}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onParentAbort);
	}
}

function isLowQuality(content: string): boolean {
	const lower = content.toLowerCase();
	if (/(enable javascript|javascript required|turn on javascript|please enable javascript|browser not supported)/.test(lower) && content.trim().length < 2000) return true;
	const nonblank = content.split("\n").filter((line) => line.trim().length > 0);
	if (nonblank.length > 10 && nonblank.filter((line) => line.trim().length < 40).length / nonblank.length > 0.7) return true;
	return false;
}

function buildLlmEndpointCandidates(url: string): string[] {
	const parsed = (() => { try { return new URL(url); } catch { return undefined; } })();
	if (!parsed) return [];
	const origin = parsed.origin;
	if (parsed.pathname === "/" || parsed.pathname === "") return [`${origin}/.well-known/llms.txt`, `${origin}/llms.txt`, `${origin}/llms.md`];
	const trimmed = parsed.pathname.replace(/\/+$/, "");
	const segments = trimmed.split("/").filter(Boolean);
	const candidates: string[] = [];
	const depth = parsed.pathname.endsWith("/") ? segments.length : Math.max(segments.length - 1, 1);
	for (let scope = Math.min(depth, segments.length); scope >= 1; scope--) {
		const base = `${origin}/${segments.slice(0, scope).join("/")}`;
		candidates.push(`${base}/llms.txt`, `${base}/llms.md`);
	}
	candidates.push(`${origin}/llms.txt`, `${origin}/llms.md`);
	return [...new Set(candidates)];
}

async function tryLlmEndpoints(url: string, signal?: AbortSignal): Promise<{ content: string; endpoint: string } | null> {
	for (const endpoint of buildLlmEndpointCandidates(url)) {
		try {
			const page = await loadPage(endpoint, 5000, signal);
			if (page.ok && page.content.trim().length > MIN_CONTENT_LENGTH && !looksLikeHtml(page.content)) return { content: page.content, endpoint };
		} catch {}
	}
	return null;
}

function parseAlternateMarkdownLink(html: string, pageUrl: string): string | undefined {
	const head = html.slice(0, html.toLowerCase().indexOf("</head>") + 7 || html.length);
	const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0] ?? "");
	for (const tag of links) {
		const rel = /rel=["']?([^"'>]+)["']?/i.exec(tag)?.[1] ?? "";
		const type = /type=["']?([^"'>]+)["']?/i.exec(tag)?.[1] ?? "";
		const href = /href=["']?([^"'>]+)["']?/i.exec(tag)?.[1] ?? "";
		if (!/alternate/i.test(rel) || !href) continue;
		if (/RecentChanges|Special:|\/feed\/|action=feed/i.test(href)) continue;
		if (type.includes("markdown") || href.endsWith(".md")) {
			try { return new URL(href, pageUrl).href; } catch {}
		}
	}
	return undefined;
}

async function tryMdSuffix(url: string, signal?: AbortSignal): Promise<string | null> {
	const candidates: string[] = [];
	if (/\/$/.test(url)) candidates.push(`${url}index.html.md`);
	else if (/\.\w+\/?$/.test(url)) candidates.push(`${url}.md`);
	else candidates.push(`${url}.md`, `${url}/index.html.md`);
	for (const candidate of candidates) {
		try {
			const page = await loadPage(candidate, 5000, signal);
			if (page.ok && page.content.trim().length > MIN_CONTENT_LENGTH && !looksLikeHtml(page.content)) return page.content;
		} catch {}
	}
	return null;
}

async function tryContentNegotiation(url: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const page = await loadPage(url, 5000, signal, "text/markdown, text/plain;q=0.9, text/html;q=0.8");
		const mime = page.contentType.toLowerCase();
		if (page.ok && page.content.trim().length > MIN_CONTENT_LENGTH && !looksLikeHtml(page.content) && (mime.includes("markdown") || mime.includes("text/plain"))) return page.content;
	} catch {}
	return null;
}

export interface RenderedUrl {
	content: string;
	finalUrl: string;
	contentType: string;
	method: string;
	notes: string[];
	truncated: boolean;
}

export async function renderUrl(url: string, raw: boolean, signal?: AbortSignal): Promise<RenderedUrl> {
	const notes: string[] = [];
	let method = "text";
	let contentType = "";
	let finalUrl: string;
	let body = "";
	const page = await loadPage(url, REMOTE_FETCH_TIMEOUT_MS, signal);
	finalUrl = page.finalUrl;
	contentType = page.contentType;
	if (!page.ok) return { content: page.content || `(request failed with status ${page.status})`, finalUrl, contentType, method: "failed", notes, truncated: false };
	if (raw) return { content: page.content, finalUrl, contentType, method: "raw", notes, truncated: false };
	const buffer = Buffer.from(page.content, "utf8");
	const docExt = documentExtensionFromContentType(contentType) ?? (isDocumentPath(finalUrl) ? (finalUrl.match(/\.\w+(?:$|[?#])/)?.[0] ?? "") : "");
	if (docExt) {
		try { body = await extractDocumentMarkdown(buffer, `${finalUrl}${docExt}`); method = "document"; }
		catch (error) { body = `[Cannot read ${docExt} file: ${error instanceof Error ? error.message : "conversion failed"}]`; method = "document-error"; }
		return { content: body, finalUrl, contentType, method, notes, truncated: false };
	}
	const isHtml = /html/i.test(contentType) || looksLikeHtml(page.content);
	if (isHtml) {
		const altMd = parseAlternateMarkdownLink(page.content, finalUrl);
		if (altMd) { try { const alt = await loadPage(altMd, 5000, signal); if (alt.ok && alt.content.trim().length > MIN_CONTENT_LENGTH && !looksLikeHtml(alt.content)) { return { content: alt.content, finalUrl: alt.finalUrl, contentType: alt.contentType, method: "alternate-markdown", notes, truncated: false }; } } catch {} notes.push("alternate markdown link unusable"); }
		const md = await tryMdSuffix(finalUrl, signal); if (md) return { content: md, finalUrl, contentType: "text/markdown", method: "md-suffix", notes, truncated: false };
		const neg = await tryContentNegotiation(finalUrl, signal); if (neg) return { content: neg, finalUrl, contentType: "text/markdown", method: "content-negotiation", notes, truncated: false };
		let rendered = getTurndown().turndown(page.content).trim();
		method = "native";
		if (rendered.length <= MIN_CONTENT_LENGTH || isLowQuality(rendered)) {
			const llms = await tryLlmEndpoints(finalUrl, signal);
			if (llms) { return { content: llms.content, finalUrl, contentType: "text/plain", method: `llms-txt (${llms.endpoint})`, notes, truncated: false }; }
			notes.push("rendered content low quality; no markdown source discovered");
		}
		body = rendered;
	} else {
		body = page.content;
	}
	return { content: body, finalUrl, contentType, method, notes, truncated: false };
}

export function buildUrlReadOutput(result: RenderedUrl): string {
	const header = [`URL: ${result.finalUrl}`, `Content-Type: ${result.contentType}`, `Method: ${result.method}`, ...(result.notes.length ? [`Notes: ${result.notes.join("; ")}`] : [])].join("\n");
	return `${header}\n\n---\n\n${result.content}`;
}

function persistReadUrlArtifact(artifactsDir: string | undefined, output: string): string | undefined {
	if (!artifactsDir) return undefined;
	return getArtifactManager(artifactsDir).save(output, "read");
}

export interface ExecuteReadUrlResult {
	content: string;
	details: ReadUrlToolDetails;
	artifactId?: string;
}

export interface LoadedReadUrl {
	output: string;
	details: ReadUrlToolDetails;
	artifactId?: string;
	raw: boolean;
}

/**
 * Resolve a URL to its full rendered (or raw) output, using the session-scoped
 * cache and persisting the rendered body as a `read` artifact. Returns the
 * complete untruncated output so callers can apply their own line selection.
 */
export async function loadReadUrlOutput(scope: string, params: { path: string; raw?: boolean }, artifactsDir: string | undefined, signal?: AbortSignal): Promise<LoadedReadUrl> {
	const parsed = parseReadUrlTarget(params.path);
	if (!parsed) throw new Error(`Not a readable URL: ${params.path}`);
	const raw = params.raw ?? parsed.raw;
	const key = getReadUrlCacheKey(scope, parsed.url, raw);
	let entry = readUrlCache.get(key);
	if (!entry) {
		const rendered = await renderUrl(parsed.url, raw, signal);
		const output = raw ? rendered.content : buildUrlReadOutput(rendered);
		const artifactId = persistReadUrlArtifact(artifactsDir, output);
		const details: ReadUrlToolDetails = { url: parsed.url, finalUrl: rendered.finalUrl, contentType: rendered.contentType, method: rendered.method, truncated: rendered.truncated, notes: rendered.notes, meta: artifactId ? { artifactId } : undefined };
		entry = { artifactId, details, output };
		readUrlCache.set(key, entry);
		readUrlCache.set(getReadUrlCacheKey(scope, rendered.finalUrl, raw), entry);
	}
	return { output: entry.output, details: entry.details, artifactId: entry.artifactId, raw };
}

export async function executeReadUrl(scope: string, params: { path: string; raw?: boolean }, artifactsDir: string | undefined, signal?: AbortSignal): Promise<ExecuteReadUrlResult> {
	const loaded = await loadReadUrlOutput(scope, params, artifactsDir, signal);
	const entry = { output: loaded.output, details: loaded.details, artifactId: loaded.artifactId };
	const fetchDefaultBytes = 50 * 1024;
	const lines = entry.output.split("\n");
	const visibleLines = lines.slice(0, FETCH_DEFAULT_MAX_LINES);
	let content = visibleLines.join("\n");
	const bytesBeforeByteClamp = Buffer.byteLength(content, "utf8");
	const byteTruncated = bytesBeforeByteClamp > fetchDefaultBytes;
	const lineTruncated = lines.length > FETCH_DEFAULT_MAX_LINES;
	if (byteTruncated) content = content.slice(0, fetchDefaultBytes);
	const truncated = lineTruncated || byteTruncated;
	let artifactId = entry.artifactId;
	if (truncated && !artifactId) artifactId = persistReadUrlArtifact(artifactsDir, entry.output);
	const outputLines = content.length === 0 ? 0 : content.split("\n").length;
	const truncation: TruncationResult | undefined = truncated ? {
		content,
		truncated: true,
		truncatedBy: byteTruncated ? "bytes" : "lines",
		totalLines: lines.length,
		totalBytes: Buffer.byteLength(entry.output, "utf8"),
		outputLines,
		outputBytes: Buffer.byteLength(content, "utf8"),
		lastLinePartial: byteTruncated,
		firstLineExceedsLimit: false,
		maxLines: FETCH_DEFAULT_MAX_LINES,
		maxBytes: fetchDefaultBytes,
	} : undefined;
	const details: ReadUrlToolDetails = { ...entry.details, truncated, meta: { ...(entry.details.meta ?? {}), ...(artifactId ? { artifactId } : {}), ...(truncation ? { truncation } : {}) } };
	if (truncated) content += `\n\n[Showing first ${visibleLines.length} of ${lines.length} lines.${artifactId ? ` Full output: artifact://${artifactId}` : ""}]`;
	return { content, details, artifactId };
}

export function resetReadUrlCache(): void {
	readUrlCache.clear();
}
