import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { loadNativeSearchBinding } from "./search-native.ts";

export interface ArchiveSelector { archivePath: string; memberPath: string }
export interface SqliteSelector { databasePath: string; table?: string; rowId?: string; query?: string; limit?: number; offset?: number; where?: string; order?: string; schema?: boolean; sampleRows?: number }
export interface InternalResourceRouter {
	read?: (url: string) => string | Buffer | undefined | Promise<string | Buffer | undefined>;
	write?: (url: string, content: string) => void | Promise<void>;
	resolve?: (url: string) => string | undefined | Promise<string | undefined>;
}
export interface InternalResourceContext { internalRouter?: InternalResourceRouter; internalResourceRouter?: InternalResourceRouter; resolveInternalUrl?: (url: string) => string | undefined | Promise<string | undefined> }
type SqliteValue = string | number | boolean | null;
interface SqliteQuery { all(...params: SqliteValue[]): Record<string, SqliteValue>[]; get?(...params: SqliteValue[]): Record<string, SqliteValue> | undefined; iterate?(): Iterable<Record<string, SqliteValue>>; run(...params: SqliteValue[]): { changes?: number; lastInsertRowid?: number | bigint } }
interface SqliteDatabase { query(sql: string): SqliteQuery; close(): void }
type SqliteDatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => SqliteDatabase;
function sqliteDatabase(): SqliteDatabaseConstructor {
	try { return (createRequire(import.meta.url)("bun:sqlite") as { Database: SqliteDatabaseConstructor }).Database; }
	catch { throw new Error("SQLite selectors require Atomic's Bun runtime with bun:sqlite support."); }
}
function existingSqliteFile(path: string): boolean | undefined { if (!existsSync(path)) return undefined; return readFileSync(path).subarray(0, 16).toString("binary") === "SQLite format 3\0"; }
export function sqliteSelectorForPath(value: string, cwd: string): SqliteSelector | undefined { const selector = parseSqliteSelector(value); if (!selector) return undefined; const absolute = resolveContainedLocalPath(cwd, selector.databasePath, "SQLite selector"); if (existingSqliteFile(absolute) !== true) return undefined; return { ...selector, databasePath: absolute }; }

const MAX_TAR_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = 500;

export function parseArchiveSelector(value: string): ArchiveSelector | undefined {
	const match = value.match(/^(.+\.(?:zip|jar|tar|tgz|tar\.gz|gz)):(.*)$/i);
	return match ? { archivePath: match[1] ?? "", memberPath: match[2] ?? "" } : undefined;
}
export function resolveArchiveSelector(selector: ArchiveSelector, cwd: string): ArchiveSelector {
	return { ...selector, archivePath: resolveContainedLocalPath(cwd, selector.archivePath, "Archive selector") };
}
export function parseSqliteSelector(value: string): SqliteSelector | undefined {
	const match = value.match(/^(.+\.(?:sqlite3?|db3?))(?:\?q=(.+)|:([^:?]+)(?:\?(.+))?(?::([^:?]+))?)?$/i);
	if (!match) return undefined;
	const params = new URLSearchParams(match[4] ?? "");
	const limit = Number.parseInt(params.get("limit") ?? "", 10);
	const offset = Number.parseInt(params.get("offset") ?? "", 10);
	const sampleRows = Number.parseInt(params.get("sampleRows") ?? params.get("sample_rows") ?? "", 10);
	return { databasePath: match[1] ?? "", query: match[2] ? decodeURIComponent(match[2]) : undefined, table: match[3], rowId: match[5] ?? params.get("id") ?? undefined, limit: Number.isFinite(limit) ? Math.max(0, Math.min(500, limit)) : undefined, offset: Number.isFinite(offset) ? Math.max(0, offset) : undefined, where: params.get("where") ?? undefined, order: params.get("order") ?? undefined, schema: params.get("schema") === "true" || params.get("schema") === "1", sampleRows: Number.isFinite(sampleRows) ? Math.max(0, Math.min(100, sampleRows)) : undefined };
}

function isZipArchive(path: string): boolean { return /\.(?:zip|jar)$/i.test(path); }
function isGzipTar(path: string): boolean { return /\.(?:tgz|tar\.gz|gz)$/i.test(path); }
function crc32(data: Buffer): number {
	let crc = ~0;
	for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
	return ~crc >>> 0;
}
function assertZipRange(buf: Buffer, offset: number, length: number, label: string): void {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > buf.length - length) throw new Error(`Invalid zip entry bounds: ${label}`);
}
function zipEntryPayload(buf: Buffer, label: string, name: string, localOffset: number, compressedSize: number): Buffer {
	if (compressedSize > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member compressed data too large: ${name}`);
	assertZipRange(buf, localOffset, 30, label);
	if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid zip local header: ${label}`);
	const localNameLen = buf.readUInt16LE(localOffset + 26), localExtraLen = buf.readUInt16LE(localOffset + 28), start = localOffset + 30 + localNameLen + localExtraLen;
	assertZipRange(buf, start, compressedSize, label);
	return buf.subarray(start, start + compressedSize);
}
export function readZipEntriesFromBuffer(buf: Buffer, label: string): Map<string, Buffer> {
	const entries = new Map<string, Buffer>();
	let eocd = -1; for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	if (eocd < 0) throw new Error(`Invalid zip archive: ${label}`);
	let ptr = buf.readUInt32LE(eocd + 16); const total = buf.readUInt16LE(eocd + 10);
	for (let n = 0; n < total; n++) {
		assertZipRange(buf, ptr, 46, label);
		if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`Invalid zip central directory: ${label}`);
		const method = buf.readUInt16LE(ptr + 10), compressedSize = buf.readUInt32LE(ptr + 20), size = buf.readUInt32LE(ptr + 24), nameLen = buf.readUInt16LE(ptr + 28), extraLen = buf.readUInt16LE(ptr + 30), commentLen = buf.readUInt16LE(ptr + 32), localOffset = buf.readUInt32LE(ptr + 42);
		assertZipRange(buf, ptr + 46, nameLen + extraLen + commentLen, label);
		const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString(); ptr += 46 + nameLen + extraLen + commentLen;
		if (name.endsWith("/")) continue;
		if (size > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${name}`);
		const data = zipEntryPayload(buf, label, name, localOffset, compressedSize);
		entries.set(name, method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ARCHIVE_MEMBER_BYTES }) : (() => { throw new Error(`Unsupported zip compression method ${method} for ${name}`); })());
	}
	return entries;
}
export function readZipEntries(path: string): Map<string, Buffer> { return readZipEntriesFromBuffer(readFileSync(path), path); }
function writeZipEntries(path: string, entries: Map<string, Buffer>): void {
	const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
	for (const [name, data] of entries) {
		const nameBuf = Buffer.from(name), compressed = deflateRawSync(data), crc = crc32(data);
		const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, compressed);
		const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf); offset += local.length + nameBuf.length + compressed.length;
	}
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0); const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.size, 8); eocd.writeUInt16LE(entries.size, 10); eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(offset, 16);
	writeFileSync(path, Buffer.concat([...locals, ...centrals, eocd]));
}
function parseTar(path: string): Map<string, Buffer> {
	const raw = readFileSync(path);
	if (raw.length > MAX_TAR_ARCHIVE_BYTES) throw new Error(`Archive too large: ${path}`);
	const buf = isGzipTar(path) ? gunzipSync(raw, { maxOutputLength: MAX_TAR_ARCHIVE_BYTES }) : raw;
	if (buf.length > MAX_TAR_ARCHIVE_BYTES) throw new Error(`Archive too large: ${path}`);
	const entries = new Map<string, Buffer>();
	for (let offset = 0; offset + 512 <= buf.length;) {
		const header = buf.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
		const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, "");
		const fullName = prefix ? `${prefix}/${name}` : name;
		const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0", 8);
		const type = String.fromCharCode(header[156] ?? 48);
		const dataStart = offset + 512;
		if (type !== "5" && fullName) {
			if (size > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${fullName}`);
			entries.set(fullName, Buffer.from(buf.subarray(dataStart, dataStart + size)));
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	return entries;
}
function tarHeader(name: string, size: number): Buffer {
	const header = Buffer.alloc(512); const nameBytes = Buffer.from(name); nameBytes.copy(header, 0, 0, Math.min(100, nameBytes.length));
	header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116); header.write(size.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(0x20, 148, 156); header[156] = 48; header.write("ustar\0", 257); header.write("00", 263);
	let sum = 0; for (const byte of header) sum += byte; header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148); return header;
}
function writeTar(path: string, entries: Map<string, Buffer>): void {
	const parts: Buffer[] = []; for (const [name, data] of entries) { parts.push(tarHeader(name, data.length), data); const pad = (512 - (data.length % 512)) % 512; if (pad) parts.push(Buffer.alloc(pad)); }
	parts.push(Buffer.alloc(1024)); const out = Buffer.concat(parts); writeFileSync(path, isGzipTar(path) ? gzipSync(out) : out);
}
function listArchiveDirectory(names: Iterable<string>, memberPath: string): string {
	const prefix = memberPath ? `${memberPath.replace(/\/+$/g, "")}/` : "";
	const children = new Set<string>();
	for (const name of names) { if (!name.startsWith(prefix) || name === prefix) continue; const rest = name.slice(prefix.length); const [first, ...more] = rest.split("/"); if (first) children.add(more.length > 0 ? `${first}/` : first); }
	return [...children].sort().slice(0, MAX_ARCHIVE_DIRECTORY_ENTRIES).join("\n");
}

function readZipSelector(path: string, memberPath: string): string {
	const buf = readFileSync(path); let eocd = -1; for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	if (eocd < 0) throw new Error(`Invalid zip archive: ${path}`);
	let ptr = buf.readUInt32LE(eocd + 16); const total = buf.readUInt16LE(eocd + 10), names: string[] = [];
	for (let n = 0; n < total; n++) {
		assertZipRange(buf, ptr, 46, path);
		if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`Invalid zip central directory: ${path}`);
		const method = buf.readUInt16LE(ptr + 10), compressedSize = buf.readUInt32LE(ptr + 20), size = buf.readUInt32LE(ptr + 24), nameLen = buf.readUInt16LE(ptr + 28), extraLen = buf.readUInt16LE(ptr + 30), commentLen = buf.readUInt16LE(ptr + 32), localOffset = buf.readUInt32LE(ptr + 42);
		assertZipRange(buf, ptr + 46, nameLen + extraLen + commentLen, path);
		const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString(); ptr += 46 + nameLen + extraLen + commentLen; if (name.endsWith("/")) continue; names.push(name); if (memberPath && name !== memberPath) continue;
		if (!memberPath) continue; if (size > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${memberPath}`);
		const data = zipEntryPayload(buf, path, name, localOffset, compressedSize);
		return (method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ARCHIVE_MEMBER_BYTES }) : (() => { throw new Error(`Unsupported zip compression method ${method} for ${name}`); })()).toString("utf8");
	}
	const listing = listArchiveDirectory(names, memberPath);
	if (listing) return listing;
	if (!memberPath) return "";
	throw new Error(`Archive member not found: ${memberPath}`);
}

export function readArchiveSelector(selector: ArchiveSelector): string {
	if (isZipArchive(selector.archivePath)) return readZipSelector(selector.archivePath, selector.memberPath);
	const entries = parseTar(selector.archivePath);
	if (!selector.memberPath) return listArchiveDirectory(entries.keys(), "");
	const data = entries.get(selector.memberPath); if (data) { if (data.length > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`Archive member too large: ${selector.memberPath}`); return data.toString("utf8"); }
	const listing = listArchiveDirectory(entries.keys(), selector.memberPath); if (listing) return listing;
	throw new Error(`Archive member not found: ${selector.memberPath}`);
}
function validateArchiveMemberPath(memberPath: string): void { if (!memberPath || memberPath.startsWith("/") || memberPath.endsWith("/") || memberPath.split("/").includes("..")) throw new Error(`Invalid archive member path: ${memberPath}`); }
function writeZipEntrySelective(path: string, memberPath: string, data: Buffer): void {
	const source = existsSync(path) ? readFileSync(path) : Buffer.alloc(0); const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
	if (source.length > 0) {
		let eocd = -1; for (let i = source.length - 22; i >= 0; i--) if (source.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
		if (eocd < 0) throw new Error(`Invalid zip archive: ${path}`);
		let ptr = source.readUInt32LE(eocd + 16); const total = source.readUInt16LE(eocd + 10);
		for (let n = 0; n < total; n++) {
			assertZipRange(source, ptr, 46, path);
			const start = ptr, nameLen = source.readUInt16LE(ptr + 28), extraLen = source.readUInt16LE(ptr + 30), commentLen = source.readUInt16LE(ptr + 32), localOffset = source.readUInt32LE(ptr + 42), compressedSize = source.readUInt32LE(ptr + 20);
			assertZipRange(source, ptr + 46, nameLen + extraLen + commentLen, path);
			const name = source.subarray(ptr + 46, ptr + 46 + nameLen).toString(); ptr += 46 + nameLen + extraLen + commentLen; if (name === memberPath) continue;
			assertZipRange(source, localOffset, 30, path);
			const localNameLen = source.readUInt16LE(localOffset + 26), localExtraLen = source.readUInt16LE(localOffset + 28), localEnd = localOffset + 30 + localNameLen + localExtraLen + compressedSize;
			assertZipRange(source, localOffset, localEnd - localOffset, path);
			const local = source.subarray(localOffset, localEnd), central = Buffer.from(source.subarray(start, ptr)); central.writeUInt32LE(offset, 42); locals.push(local); centrals.push(central); offset += local.length;
		}
	}
	const tmp = `${path}.atomic-entry-${Date.now()}`; writeZipEntries(tmp, new Map([[memberPath, data]])); const built = readFileSync(tmp); rmSync(tmp, { force: true });
	const eocdStart = built.length - 22, localLen = built.readUInt32LE(eocdStart + 16), centralSizeOne = built.readUInt32LE(eocdStart + 12); const central = Buffer.from(built.subarray(localLen, localLen + centralSizeOne)); central.writeUInt32LE(offset, 42); locals.push(built.subarray(0, localLen)); centrals.push(central); offset += localLen;
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(centrals.length, 8); eocd.writeUInt16LE(centrals.length, 10); eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(offset, 16); writeFileSync(path, Buffer.concat([...locals, ...centrals, eocd]));
}

export function writeArchiveSelector(selector: ArchiveSelector, content: string): void {
	validateArchiveMemberPath(selector.memberPath); mkdirSync(dirname(selector.archivePath), { recursive: true });
	if (isZipArchive(selector.archivePath)) { writeZipEntrySelective(selector.archivePath, selector.memberPath, Buffer.from(content)); return; }
	const entries = existsSync(selector.archivePath) ? parseTar(selector.archivePath) : new Map<string, Buffer>();
	entries.set(selector.memberPath, Buffer.from(content)); writeTar(selector.archivePath, entries);
}
const SEARCH_LINE_LIMIT = 512;
function truncateSearchLine(line: string): string {
	return line.length > SEARCH_LINE_LIMIT ? `${line.slice(0, SEARCH_LINE_LIMIT)}… [truncated]` : line;
}
function stripExtendedRegexWhitespace(pattern: string): string {
	let out = "", escaped = false, inClass = false, inComment = false;
	for (const ch of pattern) {
		if (inComment) { if (ch === "\n" || ch === "\r") inComment = false; continue; }
		if (escaped) { out += ch; escaped = false; continue; }
		if (ch === "\\") { out += ch; escaped = true; continue; }
		if (ch === "[") inClass = true; else if (ch === "]") inClass = false;
		if (!inClass && ch === "#") { inComment = true; continue; }
		if (!inClass && /\s/.test(ch)) continue;
		out += ch;
	}
	return out;
}

function normalizeSearchPattern(pattern: string, ignoreCase: boolean): { pattern: string; flags: string } {
	const match = pattern.match(/^\(\?([imsUx-]+)\)([\s\S]*)$/);
	const flags = new Set<string>(); if (ignoreCase) flags.add("i");
	if (match) { const inline = match[1] ?? ""; for (const flag of inline) { if (flag === "i" || flag === "m" || flag === "s") flags.add(flag); } return { pattern: inline.includes("x") ? stripExtendedRegexWhitespace(match[2] ?? "") : match[2] ?? "", flags: [...flags].join("") }; }
	return { pattern, flags: [...flags].join("") };
}

function searchTextSelectorLines(label: string, text: string, pattern: string, ignoreCase: boolean, literal: boolean, contextBefore = 1, contextAfter = 3): string[] {
	const normalized = normalizeSearchPattern(pattern, ignoreCase);
	if (!literal && !normalized.pattern.includes("\n") && !pattern.includes("\\n")) try { const native = loadNativeSearchBinding()?.search?.(text, { pattern: normalized.pattern, ignoreCase: normalized.flags.includes("i"), multiline: normalized.flags.includes("m") || normalized.flags.includes("s"), contextBefore, contextAfter }); if (native && !native.error) return native.matches.flatMap((match) => [...(match.contextBefore ?? []).map((line) => `${label}-${line.lineNumber}- ${truncateSearchLine(line.line)}`), `${label}:${match.lineNumber}: ${truncateSearchLine(match.line)}`, ...(match.contextAfter ?? []).map((line) => `${label}-${line.lineNumber}- ${truncateSearchLine(line.line)}`)]); } catch {}
	const matcher = literal ? undefined : new RegExp(normalized.pattern, normalized.flags);
	const needle = normalized.flags.includes("i") ? normalized.pattern.toLowerCase() : normalized.pattern;
	const lines = text.split("\n");
	const matchLines = new Set<number>();
	lines.forEach((line, index) => { const haystack = normalized.flags.includes("i") ? line.toLowerCase() : line; if (matcher ? matcher.test(line) : haystack.includes(needle)) matchLines.add(index + 1); });
	if (matchLines.size === 0 && matcher) { const match = new RegExp(normalized.pattern, normalized.flags).exec(text); if (match?.[0]) { const start = text.slice(0, match.index).split("\n").length; for (let line = start; line < start + match[0].split("\n").length; line++) matchLines.add(line); } }
	const outputLines = new Set<number>();
	for (const line of matchLines) for (let n = Math.max(1, line - contextBefore); n <= Math.min(lines.length, line + contextAfter); n++) outputLines.add(n);
	return [...outputLines].sort((a, b) => a - b).map((line) => `${label}${matchLines.has(line) ? ":" : "-"}${line}${matchLines.has(line) ? ":" : "-"} ${truncateSearchLine(lines[line - 1] ?? "")}`);
}

export function searchArchiveSelector(selector: ArchiveSelector, pattern: string, ignoreCase = false, literal = false, contextBefore = 1, contextAfter = 3): string {
	if (isZipArchive(selector.archivePath) && selector.memberPath) return searchTextSelectorLines(`${selector.archivePath}:${selector.memberPath}`, readArchiveSelector(selector), pattern, ignoreCase, literal, contextBefore, contextAfter).join("\n");
	const entries = isZipArchive(selector.archivePath) ? readZipEntries(selector.archivePath) : parseTar(selector.archivePath); const out: string[] = [];
	for (const [name, data] of entries) { if (selector.memberPath && name !== selector.memberPath) continue; out.push(...searchTextSelectorLines(`${selector.archivePath}:${name}`, data.toString("utf8"), pattern, ignoreCase, literal, contextBefore, contextAfter)); }
	return out.join("\n");
}

function routerFromContext(context?: InternalResourceContext): InternalResourceRouter | undefined { return context?.internalRouter ?? context?.internalResourceRouter; }
async function resolveViaRouter(value: string, cwd: string, context?: InternalResourceContext): Promise<string | undefined> {
	const router = routerFromContext(context); const routed = await router?.resolve?.(value); if (routed) return routed;
	const resolved = await context?.resolveInternalUrl?.(value); if (resolved) return resolved;
	return resolveInternalSelector(value, cwd);
}
function isContained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function nearestExistingAncestor(pathValue: string): string {
	let current = pathValue;
	while (!existsSync(current)) { const parent = dirname(current); if (parent === current) return current; current = parent; }
	return current;
}
function realpathExisting(pathValue: string): string { return realpathSync.native(nearestExistingAncestor(pathValue)); }
function resolveContainedPath(root: string, pathValue: string, label: string): string {
	const lexicalRoot = resolve(root), resolved = resolve(root, pathValue);
	if (!isContained(lexicalRoot, resolved)) throw new Error(`${label} escapes the workspace: ${pathValue}`);
	if (!isContained(realpathExisting(lexicalRoot), realpathExisting(resolved))) throw new Error(`${label} escapes the workspace: ${pathValue}`);
	return resolved;
}
function resolveContainedLocalPath(cwd: string, pathValue: string, label = "local:// resource"): string { return resolveContainedPath(cwd, pathValue, label); }

function fallbackInternalPath(value: string, cwd: string): string | undefined {
	const skill = value.match(/^skill:\/\/([^/]+)\/?(.*)$/); if (skill) { const name = skill[1] ?? "", rest = skill[2] || "SKILL.md"; return [".agents/skills", "packages/subagents/skills", "packages/workflows/skills"].map((base) => resolveContainedPath(resolveContainedLocalPath(cwd, base, "skill:// resource"), `${name}/${rest}`, "skill:// resource")).find((candidate) => existsSync(candidate)); }
	const local = value.match(/^local:\/\/(.+)$/); if (local) return resolveContainedLocalPath(cwd, local[1] ?? "");
	return undefined;
}
export function resolveInternalSelector(value: string, cwd: string): string | undefined { return fallbackInternalPath(value, cwd); }
export async function readInternalSelector(value: string, cwd: string, context?: InternalResourceContext): Promise<string> {
	const router = routerFromContext(context); const routed = await router?.read?.(value); if (typeof routed === "string") return routed; if (Buffer.isBuffer(routed)) return routed.toString("utf8");
	const resolved = await resolveViaRouter(value, cwd, context); if (!resolved || !existsSync(resolved)) throw new Error(`Internal resource not found or no session router supports it: ${value}`); return readFileSync(resolved, "utf8");
}
export async function writeInternalSelector(value: string, cwd: string, content: string, context?: InternalResourceContext): Promise<void> {
	const router = routerFromContext(context); if (router?.write) { await router.write(value, content); return; }
	const resolved = await resolveViaRouter(value, cwd, context); if (!resolved) throw new Error(`Unsupported writable internal resource without a session router: ${value}`); mkdirSync(dirname(resolved), { recursive: true }); writeFileSync(resolved, content);
}
export async function searchInternalSelector(value: string, cwd: string, pattern: string, ignoreCase = false, literal = false, context?: InternalResourceContext, contextBefore = 1, contextAfter = 3): Promise<string> {
	return searchTextSelectorLines(value, await readInternalSelector(value, cwd, context), pattern, ignoreCase, literal, contextBefore, contextAfter).join("\n");
}
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
export async function expandShellInternalUrls(text: string, cwd: string, context?: InternalResourceContext, quote = false): Promise<string> {
	let output = text; const matches = [...new Set(text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`$)]+/gi) ?? [])];
	for (const match of matches) { const resolved = await resolveViaRouter(match, cwd, context); if (resolved) output = output.split(match).join(quote ? shellQuote(resolved) : resolved); }
	return output;
}

const ROW_COUNT_PROBE_CAP = 50_000;
const MAX_RAW_QUERY_ROWS = 1000;

function quoteSqliteIdent(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function formatSqliteOrder(order: string | undefined): string {
	if (!order) return "";
	return order.split(",").map((part) => {
		const [column, direction] = part.split(":");
		if (!column || !/^[A-Za-z_][\w$]*$/.test(column)) throw new Error(`Invalid SQLite order column: ${part}`);
		const dir = direction?.toLowerCase() === "desc" ? "desc" : "asc";
		return `${quoteSqliteIdent(column)} ${dir}`;
	}).join(", ");
}
const FORBIDDEN_WHERE_KEYWORDS = new Set(["limit", "offset", "union", "intersect", "except", "attach", "detach", "pragma"]);
function validateSqliteWhere(where: string | undefined): string | undefined {
	const trimmed = where?.trim(); if (!trimmed) return undefined;
	let quote = "", token = "";
	const flush = () => { const lower = token.toLowerCase(); if (token && (FORBIDDEN_WHERE_KEYWORDS.has(lower) || lower.startsWith("pragma_"))) throw new Error("Invalid SQLite where filter"); token = ""; };
	for (let i = 0; i < trimmed.length; i++) { const ch = trimmed[i], next = trimmed[i + 1]; if (quote === "'") { if (ch === "'" && next === "'") { i++; continue; } if (ch === "'") quote = ""; continue; } if (quote === "\"") { if (ch === "\"" && next === "\"") { i++; continue; } if (ch === "\"") { quote = ""; flush(); continue; } if (ch && /[A-Za-z0-9_]/.test(ch)) { token += ch; continue; } flush(); token = ch; continue; } if (ch === "'" || ch === "\"") { flush(); quote = ch; continue; } if (ch === ";" || ch === "-" && next === "-" || ch === "/" && next === "*" || ch === "*" && next === "/") throw new Error("Invalid SQLite where filter"); if (ch && /[A-Za-z0-9_]/.test(ch)) { token += ch; continue; } flush(); }
	flush();
	return trimmed;
}
function rowsToJsonLines(rows: Record<string, SqliteValue>[]): string { return rows.map((row) => JSON.stringify(row)).join("\n"); }

const FORBIDDEN_RAW_QUERY_KEYWORDS = new Set(["attach", "detach", "pragma", "insert", "update", "delete", "drop", "alter", "create", "replace", "vacuum", "reindex", "load_extension", "union", "intersect", "except"]);
function validateRawSqliteQuery(query: string): string {
	const trimmed = query.trim(); if (!trimmed) throw new Error("SQLite raw query must not be empty"); if (!/^select\b/i.test(trimmed)) throw new Error("Invalid raw SQLite query");
	let quote = "", token = "";
	const flush = () => { const lower = token.toLowerCase(); if (lower && (FORBIDDEN_RAW_QUERY_KEYWORDS.has(lower) || lower.startsWith("sqlite_") || lower.startsWith("pragma_"))) throw new Error("Invalid raw SQLite query"); token = ""; };
	for (let i = 0; i < trimmed.length; i++) { const ch = trimmed[i], next = trimmed[i + 1]; if (quote === "'") { if (ch === "'" && next === "'") { i++; continue; } if (ch === "'") quote = ""; continue; } if (quote === "\"") { if (ch === "\"" && next === "\"") { i++; continue; } if (ch === "\"") { quote = ""; flush(); continue; } if (ch && /[A-Za-z0-9_]/.test(ch)) { token += ch; continue; } flush(); token = ch; continue; } if (ch === "'" || ch === "\"") { flush(); quote = ch; continue; } if (ch === ";" || ch === "-" && next === "-" || ch === "/" && next === "*" || ch === "*" && next === "/") throw new Error("Invalid raw SQLite query"); if (ch && /[A-Za-z0-9_]/.test(ch)) { token += ch; continue; } flush(); }
	flush();
	if (quote) throw new Error("Invalid raw SQLite query");
	return trimmed;
}

function readRawSqliteRows(query: SqliteQuery): Record<string, SqliteValue>[] { const rows: Record<string, SqliteValue>[] = []; const iterable = query.iterate?.(); if (!iterable) return query.all().slice(0, MAX_RAW_QUERY_ROWS); for (const row of iterable) { if (rows.length >= MAX_RAW_QUERY_ROWS) break; rows.push(row); } return rows; }

function sqliteTableColumns(db: SqliteDatabase, table: string): string[] { return (db.query(`pragma table_info(${quoteSqliteIdent(table)})`).all() as Array<{ name?: string }>).map((row) => String(row.name ?? "")).filter(Boolean); }

function boundedSqliteRowCount(db: SqliteDatabase, table: string): string | number { const row = db.query(`select count(*) as count from (select 1 from ${quoteSqliteIdent(table)} limit ${ROW_COUNT_PROBE_CAP + 1})`).all()[0]; const count = Number(row?.count ?? 0); return count > ROW_COUNT_PROBE_CAP ? `${ROW_COUNT_PROBE_CAP}+` : count; }
function normalizeSqliteWriteValue(value: unknown, column: string): SqliteValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	throw new Error(`SQLite column '${column}' only accepts JSON scalar values or null`);
}

function sqlitePrimaryKey(db: SqliteDatabase, table: string): string { return (db.query(`pragma table_info(${quoteSqliteIdent(table)})`).all() as Array<{ name?: string; pk?: number }>).find((row) => row.pk === 1)?.name ?? "rowid"; }
export function readSqliteSelector(selector: SqliteSelector): string {
	const Database = sqliteDatabase();
	const db = new Database(selector.databasePath, { readonly: true });
	try {
		if (selector.query) return rowsToJsonLines(readRawSqliteRows(db.query(validateRawSqliteQuery(selector.query))));
		if (!selector.table) {
			const tables = db.query("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().slice(0, 500);
			return tables.map((row) => { const name = String(row.name ?? ""); return JSON.stringify({ table: name, rows: boundedSqliteRowCount(db, name) }); }).join("\n");
		}
		const schemaRows = db.query(`pragma table_info(${quoteSqliteIdent(selector.table)})`).all();
		if (selector.schema) return rowsToJsonLines(schemaRows);
		const key = sqlitePrimaryKey(db, selector.table);
		const where = selector.rowId ? `${quoteSqliteIdent(key)} = ?` : validateSqliteWhere(selector.where);
		const order = formatSqliteOrder(selector.order);
		const isQuery = selector.limit !== undefined || selector.offset !== undefined || selector.where || selector.order;
		const limit = selector.sampleRows ?? selector.limit ?? (isQuery ? 20 : 5);
		const offset = selector.offset ?? 0;
		const sql = [`select * from ${quoteSqliteIdent(selector.table)}`, where ? `where ${where}` : "", order ? `order by ${order}` : "", "limit ? offset ?"].filter(Boolean).join(" ");
		const rows = selector.rowId ? db.query(sql).all(selector.rowId, limit, offset) : db.query(sql).all(limit, offset);
		if (selector.rowId || isQuery || selector.sampleRows !== undefined) return rowsToJsonLines(rows);
		return [`# ${selector.table}`, "Schema:", rowsToJsonLines(schemaRows), "Rows:", rowsToJsonLines(rows)].join("\n");
	} finally { db.close(); }
}
function stripJson5Comments(input: string): string {
	let out = "", quote = "", escaped = false;
	for (let i = 0; i < input.length; i++) { const ch = input[i]!, next = input[i + 1]; if (escaped) { out += ch; escaped = false; continue; } if (quote) { out += ch; if (ch === "\\") escaped = true; else if (ch === quote) quote = ""; continue; } if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; } if (ch === "/" && next === "/") { while (i < input.length && input[i] !== "\n") i++; out += "\n"; continue; } if (ch === "/" && next === "*") { i += 2; while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++; i++; continue; } out += ch; }
	return out;
}
function parseLooseJsonObject(content: string): Record<string, SqliteValue> {
	const trimmed = stripJson5Comments(content.trim());
	if (!trimmed) throw new Error("SQLite write content must be a JSON object; empty content only deletes a row when a row id is present.");
	let parsed: unknown;
	try { parsed = JSON.parse(trimmed); } catch {
		const normalized = trimmed.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/:\s*\+(-?\d+(?:\.\d+)?)/g, ":$1").replace(/(:\s*)0x[0-9a-fA-F]+/g, (match, prefix: string) => `${prefix}${Number.parseInt(match.slice(prefix.length + 2), 16)}`).replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, body: string) => JSON.stringify(body.replace(/\\'/g, "'"))).replace(/,\s*([}\]])/g, "$1");
		parsed = JSON.parse(normalized);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SQLite write content must be a JSON object.");
	return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([column, value]) => [column, normalizeSqliteWriteValue(value, column)]));
}
export function writeSqliteSelector(selector: SqliteSelector, content: string): string {
	if (!selector.table) throw new Error("SQLite write target must include a table name"); if (!existsSync(selector.databasePath)) throw new Error(`SQLite database does not exist: ${selector.databasePath}`); if (content.trim() === "") { if (!selector.rowId) throw new Error("SQLite empty content deletes a row only when a row id is present."); const Database = sqliteDatabase(); const db = new Database(selector.databasePath); try { const table = selector.table; const result = db.query(`delete from ${quoteSqliteIdent(table)} where ${quoteSqliteIdent(sqlitePrimaryKey(db, table))} = ?`).run(selector.rowId); return (result.changes ?? 0) > 0 ? `Deleted row '${selector.rowId}' in ${table}` : `No row deleted for '${selector.rowId}' in ${table}`; } finally { db.close(); } } const data = parseLooseJsonObject(content); const Database = sqliteDatabase(); const db = new Database(selector.databasePath);
	try { const table = selector.table; const quotedTable = quoteSqliteIdent(table); const key = sqlitePrimaryKey(db, table); const quotedKey = quoteSqliteIdent(key); const validColumns = new Set(sqliteTableColumns(db, table)); if (!selector.rowId && key !== "id" && Object.hasOwn(data, "id") && !Object.hasOwn(data, key)) { data[key] = data.id; delete data.id; } const columns = Object.keys(data); for (const column of columns) if (!validColumns.has(column)) throw new Error(`SQLite table '${table}' has no column named '${column}'`); if (columns.length === 0) { if (!selector.rowId) { db.query(`insert into ${quotedTable} default values`).run(); return `Inserted row into ${table}`; } throw new Error("SQLite update content must include at least one column."); } if (!selector.rowId) { const quoted = columns.map(quoteSqliteIdent).join(", "); db.query(`insert into ${quotedTable} (${quoted}) values (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => data[column])); return `Inserted row into ${table}`; } const assignments = columns.map((column) => `${quoteSqliteIdent(column)} = ?`).join(", "); const result = db.query(`update ${quotedTable} set ${assignments} where ${quotedKey} = ?`).run(...columns.map((column) => data[column]), selector.rowId); return (result.changes ?? 0) > 0 ? `Updated row '${selector.rowId}' in ${table}` : `No row updated for '${selector.rowId}' in ${table}`; } finally { db.close(); }
}
export function searchSqliteSelector(selector: SqliteSelector, pattern: string, ignoreCase = false, contextBefore = 1, contextAfter = 3): string {
	const normalized = normalizeSearchPattern(pattern, ignoreCase);
	const matcher = new RegExp(normalized.pattern, normalized.flags);
	if (!selector.table || selector.query) return searchTextSelectorLines(`${selector.databasePath}:${selector.table ?? "tables"}`, readSqliteSelector(selector), pattern, ignoreCase, false, contextBefore, contextAfter).join("\n");
	const Database = sqliteDatabase();
	const db = new Database(selector.databasePath, { readonly: true });
	try {
		const key = sqlitePrimaryKey(db, selector.table);
		const where = selector.rowId ? `${quoteSqliteIdent(key)} = ?` : validateSqliteWhere(selector.where);
		const order = formatSqliteOrder(selector.order);
		const limit = selector.sampleRows ?? selector.limit ?? 1000;
		const offset = selector.offset ?? 0;
		const rowIdAlias = "__atomic_rowid__";
		const selectList = key === "rowid" ? `rowid as ${quoteSqliteIdent(rowIdAlias)}, *` : "*";
		const sql = [`select ${selectList} from ${quoteSqliteIdent(selector.table)}`, where ? `where ${where}` : "", order ? `order by ${order}` : "", "limit ? offset ?"].filter(Boolean).join(" ");
		const rows = selector.rowId ? db.query(sql).all(selector.rowId, limit, offset) : db.query(sql).all(limit, offset);
		return rows.map((rawRow, index) => {
			const row = rawRow as Record<string, unknown>;
			const rowKey = key === "rowid" ? row[rowIdAlias] : row[key];
			if (key === "rowid") delete row[rowIdAlias];
			return { row, key: String(rowKey ?? offset + index + 1) };
		}).filter(({ row }) => matcher.test(JSON.stringify(row))).map(({ row, key }) => `${selector.databasePath}:${selector.table}:${key}: ${truncateSearchLine(JSON.stringify(row))}`).join("\n");
	} finally { db.close(); }
}
