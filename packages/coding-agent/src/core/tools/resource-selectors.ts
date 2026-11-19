import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
	deflateRaw as deflateRawCallback,
	gunzip as gunzipCallback,
	gzip as gzipCallback,
	inflateRaw as inflateRawCallback,
} from "node:zlib";
import { isPathInside } from "../../utils/path-inside.ts";
import { resolvePhysicalPathAsync } from "../../utils/physical-path.ts";
import { readConflictUrl } from "./conflict-registry.ts";
import { pathExists } from "./path-utils.ts";
import { loadNativeSearchBinding } from "./search-native.ts";
import { plainShellWordMask } from "./shell-plain-words.ts";
import { SqliteSelectorConnection, type SqliteSelectorValue } from "./sqlite-selector-connection.ts";
import { listTarMembers, writeTarMember } from "./tar-archive.ts";

const deflateRaw = promisify(deflateRawCallback);
const gunzip = promisify(gunzipCallback);
const gzip = promisify(gzipCallback);
const inflateRaw = promisify(inflateRawCallback);

export interface ArchiveSelector {
	archivePath: string;
	memberPath: string;
}
export interface SqliteSelector {
	databasePath: string;
	table?: string;
	rowId?: string;
	query?: string;
	limit?: number;
	offset?: number;
	where?: string;
	order?: string;
	schema?: boolean;
	sampleRows?: number;
}
/** A request to search one internal resource, for routers that search without materializing it first. */
export interface InternalSearchRequest {
	pattern: string;
	ignoreCase: boolean;
	literal: boolean;
	contextBefore: number;
	contextAfter: number;
	ranges?: readonly { readonly start: number; readonly end: number }[];
	signal?: AbortSignal;
}
// A local router can avoid preparing a continuation for a group the selector won't show. No field
// is added to the extension's request, and the hint cannot collect or hold a provider's result rows.
export interface HistoryNoteWindow {
	first: number;
	end: number;
}
export const historyNoteWindows = new WeakMap<InternalSearchRequest, HistoryNoteWindow>();

export interface InternalReadSelection {
	ranges?: readonly { readonly start: number; readonly end?: number }[];
	offset?: number;
	limit?: number;
	raw?: boolean;
	signal?: AbortSignal;
}
export interface InternalResourceRouter {
	read?: (url: string) => string | Buffer | undefined | Promise<string | Buffer | undefined>;
	readSelected?: (url: string, selection: InternalReadSelection) => string | undefined | Promise<string | undefined>;
	write?: (url: string, content: string) => void | Promise<void>;
	resolve?: (url: string) => string | undefined | Promise<string | undefined>;
	/** Search a resource that is too large to read whole; `undefined` leaves the URL to `read`. */
	search?: (url: string, request: InternalSearchRequest) => string | undefined | Promise<string | undefined>;
}
export interface InternalResourceContext {
	internalRouter?: InternalResourceRouter;
	internalResourceRouter?: InternalResourceRouter;
	resolveInternalUrl?: (url: string) => string | undefined | Promise<string | undefined>;
}

/**
 * Every scheme that `read`, `search`, `write`, `find` and `bash` treat as an internal URL. Each one has a resolver in
 * this package; a URL with any other scheme is ordinary text.
 */
export const INTERNAL_URL_SCHEMES = ["skill", "local", "artifact", "conflict", "history", "tool-output"] as const;
export type InternalUrlScheme = (typeof INTERNAL_URL_SCHEMES)[number];
const INTERNAL_URL_PREFIX = new RegExp(`^(?:${INTERNAL_URL_SCHEMES.join("|")}):\\/\\/`);
const URL_LIKE_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Schemes with a resolver but no writer: `write` refuses them with an explicit error. */
const READ_ONLY_INTERNAL_SCHEMES: readonly InternalUrlScheme[] = ["skill", "artifact", "history", "tool-output"];

export function isInternalUrl(value: string): boolean {
	return INTERNAL_URL_PREFIX.test(value);
}
/** Whether `value` is shaped like a URL, whether or not Atomic resolves its scheme. */
export function isUrlLike(value: string): boolean {
	return URL_LIKE_PREFIX.test(value);
}
type SqliteValue = SqliteSelectorValue;
type SqliteDatabase = SqliteSelectorConnection;
const SQLITE_HEADER = "SQLite format 3\0";
async function existingSqliteFile(path: string): Promise<boolean | undefined> {
	if (!(await pathExists(path))) return undefined;
	const file = await open(path, "r");
	try {
		const header = Buffer.alloc(SQLITE_HEADER.length);
		const { bytesRead } = await file.read(header, 0, header.length, 0);
		return header.subarray(0, bytesRead).toString("binary") === SQLITE_HEADER;
	} finally {
		await file.close();
	}
}
export async function sqliteSelectorForPath(value: string, cwd: string): Promise<SqliteSelector | undefined> {
	const selector = parseSqliteSelector(value);
	if (!selector) return undefined;
	const absolute = await resolveContainedLocalPath(cwd, selector.databasePath, "SQLite selector");
	if ((await existingSqliteFile(absolute)) !== true) return undefined;
	return { ...selector, databasePath: absolute };
}

const MAX_TAR_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = 500;

const ARCHIVE_EXTENSIONS = ["zip", "jar", "tar", "tgz", "tar.gz", "gz"] as const;
const SQLITE_EXTENSIONS = ["sqlite", "sqlite3", "db", "db3"] as const;

/** Whether `value[0..end)` ends with `.<extension>` preceded by at least one character. */
function endsWithExtension(lower: string, end: number, extensions: readonly string[]): boolean {
	return extensions.some((extension) => end > extension.length + 1 && lower.endsWith(`.${extension}`, end));
}

export function parseArchiveSelector(value: string): ArchiveSelector | undefined {
	// Scan colons right to left so the longest archive path wins, exactly as the
	// previous greedy `(.+\.ext):(.*)` regex did. That regex's ambiguous `.+`
	// prefix was flagged as polynomial ReDoS (js/polynomial-redos); this scan is
	// linear in the input.
	const lower = value.toLowerCase();
	for (let index = value.lastIndexOf(":"); index > 0; index = value.lastIndexOf(":", index - 1)) {
		if (endsWithExtension(lower, index, ARCHIVE_EXTENSIONS)) {
			return { archivePath: value.slice(0, index), memberPath: value.slice(index + 1) };
		}
	}
	return undefined;
}
export async function resolveArchiveSelector(selector: ArchiveSelector, cwd: string): Promise<ArchiveSelector> {
	return { ...selector, archivePath: await resolveContainedLocalPath(cwd, selector.archivePath, "Archive selector") };
}
const SQLITE_SELECTOR_SUFFIX = /^(?:\?q=(.+)|:([^:?]+)(?:\?(.+))?(?::([^:?]+))?)?$/i;
export function parseSqliteSelector(value: string): SqliteSelector | undefined {
	// Try each candidate database path from longest to shortest, mirroring the
	// previous greedy `(.+\.ext)` regex prefix without its ambiguity, which was
	// flagged as polynomial ReDoS (js/polynomial-redos). The suffix grammar is
	// unchanged and unambiguous.
	const lower = value.toLowerCase();
	for (let end = value.length; end > 0; end--) {
		if (!endsWithExtension(lower, end, SQLITE_EXTENSIONS)) continue;
		const match = value.slice(end).match(SQLITE_SELECTOR_SUFFIX);
		if (!match) continue;
		const params = new URLSearchParams(match[3] ?? "");
		const limit = Number.parseInt(params.get("limit") ?? "", 10);
		const offset = Number.parseInt(params.get("offset") ?? "", 10);
		const sampleRows = Number.parseInt(params.get("sampleRows") ?? params.get("sample_rows") ?? "", 10);
		return {
			databasePath: value.slice(0, end),
			query: match[1] ? decodeURIComponent(match[1]) : undefined,
			table: match[2],
			rowId: match[4] ?? params.get("id") ?? undefined,
			limit: Number.isFinite(limit) ? Math.max(0, Math.min(500, limit)) : undefined,
			offset: Number.isFinite(offset) ? Math.max(0, offset) : undefined,
			where: params.get("where") ?? undefined,
			order: params.get("order") ?? undefined,
			schema: params.get("schema") === "true" || params.get("schema") === "1",
			sampleRows: Number.isFinite(sampleRows) ? Math.max(0, Math.min(100, sampleRows)) : undefined,
		};
	}
	return undefined;
}

function isZipArchive(path: string): boolean {
	return /\.(?:zip|jar)$/i.test(path);
}
function isGzipTar(path: string): boolean {
	return /\.(?:tgz|tar\.gz|gz)$/i.test(path);
}
function crc32(data: Buffer): number {
	let crc = ~0;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}
function assertZipRange(buf: Buffer, offset: number, length: number, label: string): void {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset > buf.length - length
	)
		throw new Error(`Invalid zip entry bounds: ${label}`);
}
function zipEntryPayload(
	buf: Buffer,
	label: string,
	name: string,
	localOffset: number,
	compressedSize: number,
): Buffer {
	if (compressedSize > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member compressed data too large: ${name}`);
	assertZipRange(buf, localOffset, 30, label);
	if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid zip local header: ${label}`);
	const localNameLen = buf.readUInt16LE(localOffset + 26),
		localExtraLen = buf.readUInt16LE(localOffset + 28),
		start = localOffset + 30 + localNameLen + localExtraLen;
	assertZipRange(buf, start, compressedSize, label);
	return buf.subarray(start, start + compressedSize);
}
export async function readZipEntriesFromBuffer(buf: Buffer, label: string): Promise<Map<string, Buffer>> {
	const entries = new Map<string, Buffer>();
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) throw new Error(`Invalid zip archive: ${label}`);
	let ptr = buf.readUInt32LE(eocd + 16);
	const total = buf.readUInt16LE(eocd + 10);
	for (let n = 0; n < total; n++) {
		assertZipRange(buf, ptr, 46, label);
		if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`Invalid zip central directory: ${label}`);
		const method = buf.readUInt16LE(ptr + 10),
			compressedSize = buf.readUInt32LE(ptr + 20),
			size = buf.readUInt32LE(ptr + 24),
			nameLen = buf.readUInt16LE(ptr + 28),
			extraLen = buf.readUInt16LE(ptr + 30),
			commentLen = buf.readUInt16LE(ptr + 32),
			localOffset = buf.readUInt32LE(ptr + 42);
		assertZipRange(buf, ptr + 46, nameLen + extraLen + commentLen, label);
		const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString();
		ptr += 46 + nameLen + extraLen + commentLen;
		if (name.endsWith("/")) continue;
		if (size > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${name}`);
		const data = zipEntryPayload(buf, label, name, localOffset, compressedSize);
		entries.set(
			name,
			method === 0
				? Buffer.from(data)
				: method === 8
					? await inflateRaw(data, { maxOutputLength: MAX_ARCHIVE_MEMBER_BYTES })
					: (() => {
							throw new Error(`Unsupported zip compression method ${method} for ${name}`);
						})(),
		);
	}
	return entries;
}
export async function readZipEntries(path: string): Promise<Map<string, Buffer>> {
	return readZipEntriesFromBuffer(await readFile(path), path);
}
async function writeZipEntries(path: string, entries: Map<string, Buffer>): Promise<void> {
	const locals: Buffer[] = [],
		centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const nameBuf = Buffer.from(name),
			compressed = await deflateRaw(data),
			crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, compressed);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + compressed.length;
	}
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.size, 8);
	eocd.writeUInt16LE(entries.size, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	await writeFile(path, Buffer.concat([...locals, ...centrals, eocd]));
}
async function readTarBuffer(path: string): Promise<Buffer> {
	const raw = await readFile(path);
	if (raw.length > MAX_TAR_ARCHIVE_BYTES) throw new Error(`Archive too large: ${path}`);
	const buf = isGzipTar(path) ? await gunzip(raw, { maxOutputLength: MAX_TAR_ARCHIVE_BYTES }) : raw;
	if (buf.length > MAX_TAR_ARCHIVE_BYTES) throw new Error(`Archive too large: ${path}`);
	return buf;
}
async function parseTar(path: string): Promise<Map<string, Buffer>> {
	const entries = new Map<string, Buffer>();
	for (const member of listTarMembers(await readTarBuffer(path), path).members) {
		if (member.type === "5" || member.type === "g" || !member.name) continue;
		if (member.data.length > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${member.name}`);
		entries.set(member.name, Buffer.from(member.data));
	}
	return entries;
}
function listArchiveDirectory(names: Iterable<string>, memberPath: string): string {
	const prefix = memberPath ? `${memberPath.replace(/\/+$/g, "")}/` : "";
	const children = new Set<string>();
	for (const name of names) {
		if (!name.startsWith(prefix) || name === prefix) continue;
		const rest = name.slice(prefix.length);
		const [first, ...more] = rest.split("/");
		if (first) children.add(more.length > 0 ? `${first}/` : first);
	}
	return [...children].sort().slice(0, MAX_ARCHIVE_DIRECTORY_ENTRIES).join("\n");
}

async function readZipSelector(path: string, memberPath: string): Promise<string> {
	const buf = await readFile(path);
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) throw new Error(`Invalid zip archive: ${path}`);
	let ptr = buf.readUInt32LE(eocd + 16);
	const total = buf.readUInt16LE(eocd + 10),
		names: string[] = [];
	for (let n = 0; n < total; n++) {
		assertZipRange(buf, ptr, 46, path);
		if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`Invalid zip central directory: ${path}`);
		const method = buf.readUInt16LE(ptr + 10),
			compressedSize = buf.readUInt32LE(ptr + 20),
			size = buf.readUInt32LE(ptr + 24),
			nameLen = buf.readUInt16LE(ptr + 28),
			extraLen = buf.readUInt16LE(ptr + 30),
			commentLen = buf.readUInt16LE(ptr + 32),
			localOffset = buf.readUInt32LE(ptr + 42);
		assertZipRange(buf, ptr + 46, nameLen + extraLen + commentLen, path);
		const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString();
		ptr += 46 + nameLen + extraLen + commentLen;
		if (name.endsWith("/")) continue;
		names.push(name);
		if (memberPath && name !== memberPath) continue;
		if (!memberPath) continue;
		if (size > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${memberPath}`);
		const data = zipEntryPayload(buf, path, name, localOffset, compressedSize);
		return (
			method === 0
				? Buffer.from(data)
				: method === 8
					? await inflateRaw(data, { maxOutputLength: MAX_ARCHIVE_MEMBER_BYTES })
					: (() => {
							throw new Error(`Unsupported zip compression method ${method} for ${name}`);
						})()
		).toString("utf8");
	}
	const listing = listArchiveDirectory(names, memberPath);
	if (listing) return listing;
	if (!memberPath) return "";
	throw new Error(`Archive member not found: ${memberPath}`);
}

export async function readArchiveSelector(selector: ArchiveSelector): Promise<string> {
	if (isZipArchive(selector.archivePath)) return readZipSelector(selector.archivePath, selector.memberPath);
	const entries = await parseTar(selector.archivePath);
	if (!selector.memberPath) return listArchiveDirectory(entries.keys(), "");
	const data = entries.get(selector.memberPath);
	if (data) {
		if (data.length > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${selector.memberPath}`);
		return data.toString("utf8");
	}
	const listing = listArchiveDirectory(entries.keys(), selector.memberPath);
	if (listing) return listing;
	throw new Error(`Archive member not found: ${selector.memberPath}`);
}
function validateArchiveMemberPath(memberPath: string): void {
	if (!memberPath || memberPath.startsWith("/") || memberPath.endsWith("/") || memberPath.split("/").includes(".."))
		throw new Error(`Invalid archive member path: ${memberPath}`);
}
async function writeZipEntrySelective(path: string, memberPath: string, data: Buffer): Promise<void> {
	const source = (await pathExists(path)) ? await readFile(path) : Buffer.alloc(0);
	const locals: Buffer[] = [],
		centrals: Buffer[] = [];
	let offset = 0;
	if (source.length > 0) {
		let eocd = -1;
		for (let i = source.length - 22; i >= 0; i--)
			if (source.readUInt32LE(i) === 0x06054b50) {
				eocd = i;
				break;
			}
		if (eocd < 0) throw new Error(`Invalid zip archive: ${path}`);
		let ptr = source.readUInt32LE(eocd + 16);
		const total = source.readUInt16LE(eocd + 10);
		for (let n = 0; n < total; n++) {
			assertZipRange(source, ptr, 46, path);
			const start = ptr,
				flags = source.readUInt16LE(ptr + 8),
				nameLen = source.readUInt16LE(ptr + 28),
				extraLen = source.readUInt16LE(ptr + 30),
				commentLen = source.readUInt16LE(ptr + 32),
				localOffset = source.readUInt32LE(ptr + 42),
				compressedSize = source.readUInt32LE(ptr + 20);
			assertZipRange(source, ptr + 46, nameLen + extraLen + commentLen, path);
			const name = source.subarray(ptr + 46, ptr + 46 + nameLen).toString();
			ptr += 46 + nameLen + extraLen + commentLen;
			if (name === memberPath) continue;
			if ((flags & 0x0008) !== 0) throw new Error(`Unsupported zip data descriptor during selective write: ${name}`);
			assertZipRange(source, localOffset, 30, path);
			const localNameLen = source.readUInt16LE(localOffset + 26),
				localExtraLen = source.readUInt16LE(localOffset + 28),
				localEnd = localOffset + 30 + localNameLen + localExtraLen + compressedSize;
			assertZipRange(source, localOffset, localEnd - localOffset, path);
			const local = source.subarray(localOffset, localEnd),
				central = Buffer.from(source.subarray(start, ptr));
			central.writeUInt32LE(offset, 42);
			locals.push(local);
			centrals.push(central);
			offset += local.length;
		}
	}
	const tmp = `${path}.atomic-entry-${Date.now()}`;
	await writeZipEntries(tmp, new Map([[memberPath, data]]));
	const built = await readFile(tmp);
	await rm(tmp, { force: true });
	const eocdStart = built.length - 22,
		localLen = built.readUInt32LE(eocdStart + 16),
		centralSizeOne = built.readUInt32LE(eocdStart + 12);
	const central = Buffer.from(built.subarray(localLen, localLen + centralSizeOne));
	central.writeUInt32LE(offset, 42);
	locals.push(built.subarray(0, localLen));
	centrals.push(central);
	offset += localLen;
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0),
		eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(centrals.length, 8);
	eocd.writeUInt16LE(centrals.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	await writeFile(path, Buffer.concat([...locals, ...centrals, eocd]));
}

export async function writeArchiveSelector(selector: ArchiveSelector, content: string): Promise<void> {
	validateArchiveMemberPath(selector.memberPath);
	await mkdir(dirname(selector.archivePath), { recursive: true });
	if (isZipArchive(selector.archivePath)) {
		await writeZipEntrySelective(selector.archivePath, selector.memberPath, Buffer.from(content));
		return;
	}
	const path = selector.archivePath;
	const source = (await pathExists(path)) ? await readTarBuffer(path) : Buffer.alloc(0);
	const out = writeTarMember(source, selector.memberPath, Buffer.from(content), path);
	await writeFile(path, isGzipTar(path) ? await gzip(out) : out);
}
const SEARCH_LINE_LIMIT = 512;
function truncateSearchLine(line: string): string {
	if (line.length <= SEARCH_LINE_LIMIT) return line;
	let end = SEARCH_LINE_LIMIT;
	const high = line.charCodeAt(end - 1);
	const low = line.charCodeAt(end);
	if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end--;
	return `${line.slice(0, end)}… [truncated]`;
}
function stripExtendedRegexWhitespace(pattern: string): string {
	let out = "",
		escaped = false,
		inClass = false,
		inComment = false;
	for (const ch of pattern) {
		if (inComment) {
			if (ch === "\n" || ch === "\r") inComment = false;
			continue;
		}
		if (escaped) {
			out += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			out += ch;
			escaped = true;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "]") inClass = false;
		if (!inClass && ch === "#") {
			inComment = true;
			continue;
		}
		if (!inClass && /\s/.test(ch)) continue;
		out += ch;
	}
	return out;
}

export function normalizeSearchPattern(pattern: string, ignoreCase: boolean): { pattern: string; flags: string } {
	const match = pattern.match(/^\(\?([imsUx-]+)\)([\s\S]*)$/);
	const flags = new Set<string>();
	if (ignoreCase) flags.add("i");
	if (match) {
		const inline = match[1] ?? "";
		for (const flag of inline) {
			if (flag === "i" || flag === "m" || flag === "s") flags.add(flag);
		}
		return {
			pattern: inline.includes("x") ? stripExtendedRegexWhitespace(match[2] ?? "") : (match[2] ?? ""),
			flags: [...flags].join(""),
		};
	}
	return { pattern, flags: [...flags].join("") };
}

export interface SearchTextLine {
	readonly lineNumber: number;
	readonly line: string;
	readonly match: boolean;
}

export function searchTextLines(
	text: string,
	pattern: string,
	ignoreCase: boolean,
	literal: boolean,
	contextBefore = 1,
	contextAfter = 3,
): SearchTextLine[] {
	const normalized = normalizeSearchPattern(pattern, ignoreCase);
	if (!literal && !normalized.pattern.includes("\n") && !pattern.includes("\\n"))
		try {
			const native = loadNativeSearchBinding()?.search?.(text, {
				pattern: normalized.pattern,
				ignoreCase: normalized.flags.includes("i"),
				multiline: normalized.flags.includes("m") || normalized.flags.includes("s"),
				contextBefore,
				contextAfter,
			});
			if (native && !native.error)
				return native.matches.flatMap((match) => [
					...(match.contextBefore ?? []).map((line) => ({
						lineNumber: line.lineNumber,
						line: line.line,
						match: false,
					})),
					{ lineNumber: match.lineNumber, line: match.line, match: true },
					...(match.contextAfter ?? []).map((line) => ({
						lineNumber: line.lineNumber,
						line: line.line,
						match: false,
					})),
				]);
		} catch {}
	const matcher = literal ? undefined : new RegExp(normalized.pattern, normalized.flags);
	const needle = normalized.flags.includes("i") ? normalized.pattern.toLowerCase() : normalized.pattern;
	const lines = text.split("\n");
	const matchLines = new Set<number>();
	lines.forEach((line, index) => {
		const haystack = normalized.flags.includes("i") ? line.toLowerCase() : line;
		if (matcher ? matcher.test(line) : haystack.includes(needle)) matchLines.add(index + 1);
	});
	if (matchLines.size === 0 && matcher) {
		const match = new RegExp(normalized.pattern, normalized.flags).exec(text);
		if (match?.[0]) {
			const start = text.slice(0, match.index).split("\n").length;
			for (let line = start; line < start + match[0].split("\n").length; line++) matchLines.add(line);
		}
	}
	const outputLines = new Set<number>();
	for (const line of matchLines)
		for (let n = Math.max(1, line - contextBefore); n <= Math.min(lines.length, line + contextAfter); n++)
			outputLines.add(n);
	return [...outputLines]
		.sort((a, b) => a - b)
		.map((line) => ({ lineNumber: line, line: lines[line - 1] ?? "", match: matchLines.has(line) }));
}

export function formatSearchTextLine(label: string, number: number, line: string, match: boolean): string {
	return `${label}${match ? ":" : "-"}${number}${match ? ":" : "-"} ${truncateSearchLine(line)}`;
}

export function searchTextSelectorLines(
	label: string,
	text: string,
	pattern: string,
	ignoreCase: boolean,
	literal: boolean,
	contextBefore = 1,
	contextAfter = 3,
): string[] {
	return searchTextLines(text, pattern, ignoreCase, literal, contextBefore, contextAfter).map((line) =>
		formatSearchTextLine(label, line.lineNumber, line.line, line.match),
	);
}

export async function searchArchiveSelector(
	selector: ArchiveSelector,
	pattern: string,
	ignoreCase = false,
	literal = false,
	contextBefore = 1,
	contextAfter = 3,
): Promise<string> {
	if (isZipArchive(selector.archivePath) && selector.memberPath)
		return searchTextSelectorLines(
			`${selector.archivePath}:${selector.memberPath}`,
			await readArchiveSelector(selector),
			pattern,
			ignoreCase,
			literal,
			contextBefore,
			contextAfter,
		).join("\n");
	const entries = isZipArchive(selector.archivePath)
		? await readZipEntries(selector.archivePath)
		: await parseTar(selector.archivePath);
	const out: string[] = [];
	for (const [name, data] of entries) {
		if (selector.memberPath && name !== selector.memberPath) continue;
		out.push(
			...searchTextSelectorLines(
				`${selector.archivePath}:${name}`,
				data.toString("utf8"),
				pattern,
				ignoreCase,
				literal,
				contextBefore,
				contextAfter,
			),
		);
	}
	return out.join("\n");
}

/** One router from several: each operation goes to the first router that handles the URL. */
export function composeInternalRouters(...routers: readonly InternalResourceRouter[]): InternalResourceRouter {
	const first = async <R>(
		attempt: (router: InternalResourceRouter) => R | undefined | Promise<R | undefined>,
	): Promise<R | undefined> => {
		for (const router of routers) {
			const result = await attempt(router);
			if (result !== undefined) return result;
		}
		return undefined;
	};
	return {
		read: (url) => first((router) => router.read?.(url)),
		readSelected: (url, selection) => first((router) => router.readSelected?.(url, selection)),
		resolve: (url) => first((router) => router.resolve?.(url)),
		search: (url, request) => first((router) => router.search?.(url, request)),
	};
}
function routerFromContext(context?: InternalResourceContext): InternalResourceRouter | undefined {
	return context?.internalRouter ?? context?.internalResourceRouter;
}
async function resolveViaRouter(
	value: string,
	cwd: string,
	context?: InternalResourceContext,
): Promise<string | undefined> {
	const router = routerFromContext(context);
	const routed = await router?.resolve?.(value);
	if (routed) return routed;
	const resolved = await context?.resolveInternalUrl?.(value);
	if (resolved) return resolved;
	return await resolveInternalSelector(value, cwd);
}
async function resolveContainedPath(root: string, pathValue: string, label: string): Promise<string> {
	const lexicalRoot = resolve(root),
		resolved = resolve(root, pathValue);
	if (!isPathInside(lexicalRoot, resolved)) throw new Error(`${label} escapes the workspace: ${pathValue}`);
	const physicalRoot = await resolvePhysicalPathAsync(lexicalRoot);
	if (!isPathInside(physicalRoot, await resolvePhysicalPathAsync(resolved)))
		throw new Error(`${label} escapes the workspace: ${pathValue}`);
	return resolved;
}
function resolveContainedLocalPath(cwd: string, pathValue: string, label = "local:// resource"): Promise<string> {
	return resolveContainedPath(cwd, pathValue, label);
}

async function fallbackInternalPath(value: string, cwd: string): Promise<string | undefined> {
	const skill = value.match(/^skill:\/\/([^/]+)(?:\/(.*))?$/);
	if (skill) {
		const name = skill[1] ?? "",
			rest = skill[2] || "SKILL.md";
		const candidates: string[] = [];
		for (const base of [".agents/skills", "packages/subagents/skills"])
			candidates.push(
				await resolveContainedPath(
					await resolveContainedLocalPath(cwd, base, "skill:// resource"),
					`${name}/${rest}`,
					"skill:// resource",
				),
			);
		for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
		return undefined;
	}
	const local = value.match(/^local:\/\/(.+)$/);
	if (local) return resolveContainedLocalPath(cwd, local[1] ?? "");
	return undefined;
}
export async function resolveInternalSelector(value: string, cwd: string): Promise<string | undefined> {
	return fallbackInternalPath(value, cwd);
}
export async function readInternalSelector(
	value: string,
	cwd: string,
	context?: InternalResourceContext,
): Promise<string> {
	const router = routerFromContext(context);
	const routed = await router?.read?.(value);
	if (typeof routed === "string") return routed;
	if (Buffer.isBuffer(routed)) return routed.toString("utf8");
	if (value.startsWith("conflict://")) return readConflictUrl(value, cwd);
	const resolved = await resolveViaRouter(value, cwd, context);
	if (!resolved || !(await pathExists(resolved)))
		throw new Error(`Internal resource not found or no session router supports it: ${value}`);
	return readFile(resolved, "utf8");
}
export async function readInternalSelected(
	value: string,
	selection: InternalReadSelection,
	context?: InternalResourceContext,
): Promise<string | undefined> {
	return routerFromContext(context)?.readSelected?.(value, selection);
}
export async function writeInternalSelector(
	value: string,
	cwd: string,
	content: string,
	context?: InternalResourceContext,
): Promise<void> {
	const router = routerFromContext(context);
	if (router?.write) {
		await router.write(value, content);
		return;
	}
	const scheme = READ_ONLY_INTERNAL_SCHEMES.find((candidate) => value.startsWith(`${candidate}://`));
	if (scheme) throw new Error(`${scheme}:// resources are read-only: ${value}`);
	const resolved = await resolveViaRouter(value, cwd, context);
	if (!resolved) throw new Error(`Unsupported writable internal resource without a session router: ${value}`);
	await mkdir(dirname(resolved), { recursive: true });
	await writeFile(resolved, content);
}
export async function searchInternalSelector(
	value: string,
	cwd: string,
	pattern: string,
	ignoreCase = false,
	literal = false,
	context?: InternalResourceContext,
	contextBefore = 1,
	contextAfter = 3,
	scope: Pick<InternalSearchRequest, "ranges" | "signal"> = {},
	window?: HistoryNoteWindow,
): Promise<string> {
	const router = routerFromContext(context);
	const search = router?.search;
	if (search != null) {
		const request = { pattern, ignoreCase, literal, contextBefore, contextAfter, ...scope };
		if (window) historyNoteWindows.set(request, window);
		try {
			const searched = await Reflect.apply(search, router, [value, request]);
			if (typeof searched === "string") return searched;
		} finally {
			if (window) historyNoteWindows.delete(request);
		}
	}
	return searchTextSelectorLines(
		value,
		await readInternalSelector(value, cwd, context),
		pattern,
		ignoreCase,
		literal,
		contextBefore,
		contextAfter,
	).join("\n");
}
function shellQuote(value: string, dialect: "posix" | "powershell"): string {
	// PowerShell also treats U+2018–U+201B as single-quote delimiters.
	return dialect === "powershell"
		? `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`
		: `'${value.replace(/'/g, `'\\''`)}'`;
}
const SHELL_INTERNAL_URL = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s'"`$)]+/gi;
// In shell code a URL must start a word. Glued to `$`, `[`, `@`, a quote or a `#`, the shell may read the
// replacement as something other than a quoted word, so such a URL stays unexpanded.
const PLAIN_SHELL_INTERNAL_URL = /(?<=^|[\s;&|(<>=])[a-z][a-z0-9+.-]*:\/\/[^\s'"`$();&|<>]+/gi;
/**
 * Replaces internal URLs with the paths they resolve to. With `quote` the text is shell code: only URLs that sit
 * wholly in plain shell words are replaced, and each path is shell-quoted. Quoted strings, heredoc bodies, comments,
 * escapes and substitutions that merely mention a scheme run unchanged. Without `quote` the text is a plain value
 * such as a `cwd` or an environment variable.
 */
export async function expandShellInternalUrls(
	text: string,
	cwd: string,
	context?: InternalResourceContext,
	quote = false,
	dialect: "posix" | "powershell" = "posix",
): Promise<string> {
	const mask = quote ? plainShellWordMask(text, dialect) : undefined;
	const candidates = [...text.matchAll(quote ? PLAIN_SHELL_INTERNAL_URL : SHELL_INTERNAL_URL)].filter(
		(match) =>
			isInternalUrl(match[0]) &&
			(mask === undefined || mask.subarray(match.index, match.index + match[0].length).every(Boolean)),
	);
	const replacements = new Map<string, string>();
	for (const url of new Set(candidates.map((match) => match[0]))) {
		const resolved = await resolveViaRouter(url, cwd, context);
		if (resolved) replacements.set(url, quote ? shellQuote(resolved, dialect) : resolved);
	}
	let expanded = "";
	let copied = 0;
	for (const match of candidates) {
		const replacement = replacements.get(match[0]);
		if (replacement === undefined) continue;
		expanded += text.slice(copied, match.index) + replacement;
		copied = match.index + match[0].length;
	}
	// Replace original occurrences only; never reinterpret a router's result.
	return expanded + text.slice(copied);
}

const ROW_COUNT_PROBE_CAP = 50_000;
const MAX_RAW_QUERY_ROWS = 1000;

function quoteSqliteIdent(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}
function formatSqliteOrder(order: string | undefined): string {
	if (!order) return "";
	return order
		.split(",")
		.map((part) => {
			const [column, direction] = part.split(":");
			if (!column || !/^[A-Za-z_][\w$]*$/.test(column)) throw new Error(`Invalid SQLite order column: ${part}`);
			const dir = direction?.toLowerCase() === "desc" ? "desc" : "asc";
			return `${quoteSqliteIdent(column)} ${dir}`;
		})
		.join(", ");
}
const FORBIDDEN_WHERE_KEYWORDS = new Set([
	"limit",
	"offset",
	"union",
	"intersect",
	"except",
	"attach",
	"detach",
	"pragma",
	"select",
	"load_extension",
]);
function validateSqliteWhere(where: string | undefined): string | undefined {
	const trimmed = where?.trim();
	if (!trimmed) return undefined;
	let quote = "",
		token = "";
	const flush = () => {
		const lower = token.toLowerCase();
		if (token && (FORBIDDEN_WHERE_KEYWORDS.has(lower) || lower.startsWith("pragma_") || lower.startsWith("sqlite_")))
			throw new Error("Invalid SQLite where filter");
		token = "";
	};
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i],
			next = trimmed[i + 1];
		if (quote === "'") {
			if (ch === "'" && next === "'") {
				i++;
				continue;
			}
			if (ch === "'") quote = "";
			continue;
		}
		if (quote === '"') {
			if (ch === '"' && next === '"') {
				i++;
				continue;
			}
			if (ch === '"') {
				quote = "";
				flush();
				continue;
			}
			if (ch && /[A-Za-z0-9_]/.test(ch)) {
				token += ch;
				continue;
			}
			flush();
			token = ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			flush();
			quote = ch;
			continue;
		}
		if (ch === ";" || (ch === "-" && next === "-") || (ch === "/" && next === "*") || (ch === "*" && next === "/"))
			throw new Error("Invalid SQLite where filter");
		if (ch && /[A-Za-z0-9_]/.test(ch)) {
			token += ch;
			continue;
		}
		flush();
	}
	flush();
	return trimmed;
}
function rowsToJsonLines(rows: Record<string, SqliteValue>[]): string {
	return rows.map((row) => JSON.stringify(row)).join("\n");
}

const FORBIDDEN_RAW_QUERY_KEYWORDS = new Set([
	"attach",
	"detach",
	"pragma",
	"insert",
	"update",
	"delete",
	"drop",
	"alter",
	"create",
	"replace",
	"vacuum",
	"reindex",
	"load_extension",
	"union",
	"intersect",
	"except",
]);
function validateRawSqliteQuery(query: string): string {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("SQLite raw query must not be empty");
	if (!/^select\b/i.test(trimmed)) throw new Error("Invalid raw SQLite query");
	let quote = "",
		token = "";
	const flush = () => {
		const lower = token.toLowerCase();
		if (
			lower &&
			(FORBIDDEN_RAW_QUERY_KEYWORDS.has(lower) || lower.startsWith("sqlite_") || lower.startsWith("pragma_"))
		)
			throw new Error("Invalid raw SQLite query");
		token = "";
	};
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i],
			next = trimmed[i + 1];
		if (quote === "'") {
			if (ch === "'" && next === "'") {
				i++;
				continue;
			}
			if (ch === "'") quote = "";
			continue;
		}
		if (quote === '"') {
			if (ch === '"' && next === '"') {
				i++;
				continue;
			}
			if (ch === '"') {
				quote = "";
				flush();
				continue;
			}
			if (ch && /[A-Za-z0-9_]/.test(ch)) {
				token += ch;
				continue;
			}
			flush();
			token = ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			flush();
			quote = ch;
			continue;
		}
		if (ch === ";" || (ch === "-" && next === "-") || (ch === "/" && next === "*") || (ch === "*" && next === "/"))
			throw new Error("Invalid raw SQLite query");
		if (ch && /[A-Za-z0-9_]/.test(ch)) {
			token += ch;
			continue;
		}
		flush();
	}
	flush();
	if (quote) throw new Error("Invalid raw SQLite query");
	return trimmed;
}

async function sqliteTableColumns(db: SqliteDatabase, table: string): Promise<string[]> {
	return ((await db.all(`pragma table_info(${quoteSqliteIdent(table)})`)) as Array<{ name?: string }>)
		.map((row) => String(row.name ?? ""))
		.filter(Boolean);
}

async function boundedSqliteRowCount(db: SqliteDatabase, table: string): Promise<string | number> {
	const row = (
		await db.all(
			`select count(*) as count from (select 1 from ${quoteSqliteIdent(table)} limit ${ROW_COUNT_PROBE_CAP + 1})`,
		)
	)[0];
	const count = Number(row?.count ?? 0);
	return count > ROW_COUNT_PROBE_CAP ? `${ROW_COUNT_PROBE_CAP}+` : count;
}
function normalizeSqliteWriteValue(value: unknown, column: string): SqliteValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	throw new Error(`SQLite column '${column}' only accepts JSON scalar values or null`);
}

/** The columns that identify one row: the complete primary key in key order, or `rowid` for a table without one. */
async function sqliteRowKey(db: SqliteDatabase, table: string): Promise<string[]> {
	const columns = (
		(await db.all(`pragma table_info(${quoteSqliteIdent(table)})`)) as unknown as Array<{ name: string; pk: number }>
	)
		.filter((row) => row.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((row) => row.name);
	return columns.length > 0 ? columns : ["rowid"];
}
/**
 * The value a single-column key binds for `rowId`. A column with a type affinity converts the text itself when it
 * compares, but a column declared without a type (or as BLOB) compares exactly, so a stored `2` never equals the text
 * `'2'`: such a column binds a canonical number as a number.
 */
async function sqliteSingleKeyValue(
	db: SqliteDatabase,
	table: string,
	column: string,
	rowId: string,
): Promise<SqliteValue> {
	const value = Number(rowId);
	if (!Number.isFinite(value) || String(value) !== rowId) return rowId;
	const type = (
		(
			(await db.all(`pragma table_info(${quoteSqliteIdent(table)})`)) as unknown as Array<{
				name: string;
				type: string;
			}>
		).find((row) => row.name === column)?.type ?? ""
	).toUpperCase();
	// SQLite's affinity rules: INT, then CHAR/CLOB/TEXT, then BLOB or no type, which is the only one without affinity.
	return !/INT|CHAR|CLOB|TEXT/.test(type) && (type === "" || type.includes("BLOB")) ? value : rowId;
}
/**
 * Bind values for a row selector. A single-column key takes the selector text as its value; a composite key takes a
 * JSON array with one value per key column, in key order, such as `["acme",2]`. Anything else is refused, because
 * matching on part of a composite key would select several rows.
 */
async function sqliteRowKeyValues(
	db: SqliteDatabase,
	key: string[],
	rowId: string,
	table: string,
): Promise<SqliteValue[]> {
	if (key.length === 1) return [await sqliteSingleKeyValue(db, table, key[0] as string, rowId)];
	let values: unknown;
	try {
		values = JSON.parse(rowId);
	} catch {
		values = undefined;
	}
	if (!Array.isArray(values) || values.length !== key.length)
		throw new Error(
			`SQLite table '${table}' has a composite primary key (${key.join(", ")}); select a row with a JSON array of all ${key.length} key values in that order`,
		);
	return values.map((value, index) => normalizeSqliteWriteValue(value, key[index] as string));
}
function sqliteRowKeyWhere(key: string[]): string {
	return key.map((column) => `${quoteSqliteIdent(column)} = ?`).join(" and ");
}
/** Runs a row update or delete that changes at most one row, refusing (and changing nothing) when more match. */
async function runSingleRowWrite(
	db: SqliteDatabase,
	table: string,
	rowId: string,
	where: string,
	keyValues: SqliteValue[],
	statement: string,
	params: SqliteValue[],
): Promise<number> {
	await db.run("begin immediate");
	let committed = false;
	try {
		const matched = Number(
			(await db.all(`select count(*) as count from ${quoteSqliteIdent(table)} where ${where}`, keyValues))[0]?.count,
		);
		if (matched > 1)
			throw new Error(
				`SQLite row selector '${rowId}' matches ${matched} rows in ${table}; refusing to change more than one row. Select the row by its complete primary key.`,
			);
		const changes = (await db.run(statement, params)).changes;
		await db.run("commit");
		committed = true;
		return changes;
	} finally {
		if (!committed) await db.run("rollback");
	}
}
function sqliteRowKeyText(key: string[], row: Record<string, unknown>, fallback: number): string {
	if (key.length > 1) return JSON.stringify(key.map((column) => row[column]));
	return String(row[key[0] as string] ?? fallback);
}
export async function readSqliteSelector(selector: SqliteSelector): Promise<string> {
	const db = await SqliteSelectorConnection.open(selector.databasePath, { readonly: true });
	try {
		if (selector.query)
			return rowsToJsonLines(await db.rows(validateRawSqliteQuery(selector.query), MAX_RAW_QUERY_ROWS));
		if (!selector.table) {
			const tables = (
				await db.all("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
			).slice(0, 500);
			const lines: string[] = [];
			for (const row of tables) {
				const name = String(row.name ?? "");
				lines.push(JSON.stringify({ table: name, rows: await boundedSqliteRowCount(db, name) }));
			}
			return lines.join("\n");
		}
		const schemaRows = await db.all(`pragma table_info(${quoteSqliteIdent(selector.table)})`);
		if (selector.schema) return rowsToJsonLines(schemaRows);
		const key = await sqliteRowKey(db, selector.table);
		const keyValues = selector.rowId ? await sqliteRowKeyValues(db, key, selector.rowId, selector.table) : [];
		const where = selector.rowId ? sqliteRowKeyWhere(key) : validateSqliteWhere(selector.where);
		const order = formatSqliteOrder(selector.order);
		const isQuery = selector.limit !== undefined || selector.offset !== undefined || selector.where || selector.order;
		const limit = selector.sampleRows ?? selector.limit ?? (isQuery ? 20 : 5);
		const offset = selector.offset ?? 0;
		const sql = [
			`select * from ${quoteSqliteIdent(selector.table)}`,
			where ? `where ${where}` : "",
			order ? `order by ${order}` : "",
			"limit ? offset ?",
		]
			.filter(Boolean)
			.join(" ");
		const rows = await db.all(sql, [...keyValues, limit, offset]);
		if (selector.rowId || isQuery || selector.sampleRows !== undefined) return rowsToJsonLines(rows);
		return [`# ${selector.table}`, "Schema:", rowsToJsonLines(schemaRows), "Rows:", rowsToJsonLines(rows)].join("\n");
	} finally {
		await db.close();
	}
}
function stripJson5Comments(input: string): string {
	let out = "",
		quote = "",
		escaped = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!,
			next = input[i + 1];
		if (escaped) {
			out += ch;
			escaped = false;
			continue;
		}
		if (quote) {
			out += ch;
			if (ch === "\\") escaped = true;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < input.length && input[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}
const LOOSE_JSON_NUMBER = /0[xX][\da-fA-F]+|[\d.]+(?:[eE][+-]?\d+)?/y;
const LOOSE_JSON_WORD = /[\w$]+/y;
const LOOSE_JSON_KEY_COLON = /\s*:/y;
/**
 * JSON for the JSON5 forms SQLite writes accept: unquoted keys, single-quoted strings, a leading `+`, hex numbers and
 * trailing commas. It walks tokens, so the text inside a string is never rewritten.
 */
function looseJsonToJson(input: string): string {
	let out = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i] as string;
		if (ch === '"' || ch === "'") {
			let body = "";
			let j = i + 1;
			for (; j < input.length && input[j] !== ch; j++) {
				const c = input[j] as string;
				if (c === "\\") {
					const escaped = input[++j] as string;
					body += escaped === "'" ? "'" : `\\${escaped}`;
				} else body += c === '"' ? '\\"' : c;
			}
			out += `"${body}"`;
			i = j;
			continue;
		}
		// A `+` outside a string can only be a number sign; JSON has none.
		if (ch === "+") continue;
		if (/[\d.]/.test(ch)) {
			LOOSE_JSON_NUMBER.lastIndex = i;
			const number = (LOOSE_JSON_NUMBER.exec(input) as RegExpExecArray)[0];
			out += /[xX]/.test(number) ? String(Number(number)) : number;
			i += number.length - 1;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			LOOSE_JSON_WORD.lastIndex = i;
			const word = (LOOSE_JSON_WORD.exec(input) as RegExpExecArray)[0];
			LOOSE_JSON_KEY_COLON.lastIndex = i + word.length;
			out += LOOSE_JSON_KEY_COLON.test(input) ? JSON.stringify(word) : word;
			i += word.length - 1;
			continue;
		}
		if ((ch === "}" || ch === "]") && out.trimEnd().endsWith(",")) out = out.trimEnd().slice(0, -1);
		out += ch;
	}
	return out;
}
function parseLooseJsonObject(content: string): Record<string, SqliteValue> {
	const trimmed = stripJson5Comments(content.trim());
	if (!trimmed)
		throw new Error(
			"SQLite write content must be a JSON object; empty content only deletes a row when a row id is present.",
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		const normalized = looseJsonToJson(trimmed);
		parsed = JSON.parse(normalized);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("SQLite write content must be a JSON object.");
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).map(([column, value]) => [
			column,
			normalizeSqliteWriteValue(value, column),
		]),
	);
}
export async function writeSqliteSelector(selector: SqliteSelector, content: string): Promise<string> {
	if (!selector.table) throw new Error("SQLite write target must include a table name");
	if (!(await pathExists(selector.databasePath)))
		throw new Error(`SQLite database does not exist: ${selector.databasePath}`);
	if (content.trim() === "") {
		if (!selector.rowId) throw new Error("SQLite empty content deletes a row only when a row id is present.");
		const db = await SqliteSelectorConnection.open(selector.databasePath);
		try {
			const table = selector.table;
			const key = await sqliteRowKey(db, table);
			const keyValues = await sqliteRowKeyValues(db, key, selector.rowId, table);
			const where = sqliteRowKeyWhere(key);
			const changes = await runSingleRowWrite(
				db,
				table,
				selector.rowId,
				where,
				keyValues,
				`delete from ${quoteSqliteIdent(table)} where ${where}`,
				keyValues,
			);
			return changes > 0
				? `Deleted row '${selector.rowId}' in ${table}`
				: `No row deleted for '${selector.rowId}' in ${table}`;
		} finally {
			await db.close();
		}
	}
	const data = parseLooseJsonObject(content);
	const db = await SqliteSelectorConnection.open(selector.databasePath);
	try {
		const table = selector.table;
		const quotedTable = quoteSqliteIdent(table);
		const key = await sqliteRowKey(db, table);
		const keyValues = selector.rowId ? await sqliteRowKeyValues(db, key, selector.rowId, table) : [];
		const validColumns = new Set(await sqliteTableColumns(db, table));
		const [single = ""] = key;
		if (!selector.rowId && key.length === 1 && Object.hasOwn(data, "id") && !Object.hasOwn(data, single)) {
			data[single] = data.id;
			delete data.id;
		}
		const columns = Object.keys(data);
		for (const column of columns)
			if (!validColumns.has(column)) throw new Error(`SQLite table '${table}' has no column named '${column}'`);
		if (columns.length === 0) {
			if (!selector.rowId) {
				await db.run(`insert into ${quotedTable} default values`);
				return `Inserted row into ${table}`;
			}
			throw new Error("SQLite update content must include at least one column.");
		}
		if (!selector.rowId) {
			const quoted = columns.map(quoteSqliteIdent).join(", ");
			await db.run(
				`insert into ${quotedTable} (${quoted}) values (${columns.map(() => "?").join(", ")})`,
				columns.map((column) => data[column] as SqliteValue),
			);
			return `Inserted row into ${table}`;
		}
		const assignments = columns.map((column) => `${quoteSqliteIdent(column)} = ?`).join(", ");
		const where = sqliteRowKeyWhere(key);
		const changes = await runSingleRowWrite(
			db,
			table,
			selector.rowId,
			where,
			keyValues,
			`update ${quotedTable} set ${assignments} where ${where}`,
			[...columns.map((column) => data[column] as SqliteValue), ...keyValues],
		);
		return changes > 0
			? `Updated row '${selector.rowId}' in ${table}`
			: `No row updated for '${selector.rowId}' in ${table}`;
	} finally {
		await db.close();
	}
}
export async function searchSqliteSelector(
	selector: SqliteSelector,
	pattern: string,
	ignoreCase = false,
	contextBefore = 1,
	contextAfter = 3,
): Promise<string> {
	const normalized = normalizeSearchPattern(pattern, ignoreCase);
	const matcher = new RegExp(normalized.pattern, normalized.flags);
	if (!selector.table || selector.query)
		return searchTextSelectorLines(
			`${selector.databasePath}:${selector.table ?? "tables"}`,
			await readSqliteSelector(selector),
			pattern,
			ignoreCase,
			false,
			contextBefore,
			contextAfter,
		).join("\n");
	const db = await SqliteSelectorConnection.open(selector.databasePath, { readonly: true });
	try {
		const key = await sqliteRowKey(db, selector.table);
		const keyValues = selector.rowId ? await sqliteRowKeyValues(db, key, selector.rowId, selector.table) : [];
		const where = selector.rowId ? sqliteRowKeyWhere(key) : validateSqliteWhere(selector.where);
		const order = formatSqliteOrder(selector.order);
		const limit = selector.sampleRows ?? selector.limit ?? 1000;
		const offset = selector.offset ?? 0;
		const rowIdAlias = "__atomic_rowid__";
		const usesRowid = key[0] === "rowid";
		const selectList = usesRowid ? `rowid as ${quoteSqliteIdent(rowIdAlias)}, *` : "*";
		const sql = [
			`select ${selectList} from ${quoteSqliteIdent(selector.table)}`,
			where ? `where ${where}` : "",
			order ? `order by ${order}` : "",
			"limit ? offset ?",
		]
			.filter(Boolean)
			.join(" ");
		const rows = await db.all(sql, [...keyValues, limit, offset]);
		return rows
			.map((rawRow, index) => {
				const row = rawRow as Record<string, unknown>;
				const rowKey = usesRowid
					? String(row[rowIdAlias] ?? offset + index + 1)
					: sqliteRowKeyText(key, row, offset + index + 1);
				delete row[rowIdAlias];
				return { row, key: rowKey };
			})
			.filter(({ row }) => matcher.test(JSON.stringify(row)))
			.map(
				({ row, key }) =>
					`${selector.databasePath}:${selector.table}:${key}: ${truncateSearchLine(JSON.stringify(row))}`,
			)
			.join("\n");
	} finally {
		await db.close();
	}
}
