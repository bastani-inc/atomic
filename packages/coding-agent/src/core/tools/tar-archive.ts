/**
 * Tar archives for archive selectors. Reading resolves GNU long names and PAX paths; writing one member copies every
 * other header and data block verbatim and rewrites only that member, so long names, PAX records, links, modes and
 * mtimes elsewhere in the archive are untouched. Anything the walker cannot account for exactly is refused.
 */

const BLOCK = 512;
/** Headers that describe the member after them rather than a member of their own. */
const EXTENSION_TYPES = new Set(["L", "K", "x"]);
const REGULAR_TYPES = new Set(["0", "\0", "7"]);
const TYPE_NAMES: Record<string, string> = {
	"1": "hard link",
	"2": "symbolic link",
	"3": "character device",
	"4": "block device",
	"5": "directory",
	"6": "FIFO",
};
/** PAX records that describe the old contents of a rewritten member; every other record is kept. */
const REWRITTEN_PAX_KEYS = new Set(["path", "size", "mtime"]);

export interface TarMember {
	name: string;
	type: string;
	/** Offset of the first extension header for this member, or of its own header. */
	start: number;
	header: Buffer;
	pax: Map<string, string>;
	data: Buffer;
	/** Offset just past this member's padded data. */
	end: number;
}

interface TarListing {
	members: TarMember[];
	/** Offset of the end-of-archive marker, or the buffer length when there is none. */
	end: number;
}

function cString(field: Buffer): string {
	const nul = field.indexOf(0);
	return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
}

function octal(field: Buffer, what: string, label: string): number {
	if ((field[0] ?? 0) & 0x80) throw new Error(`Unsupported base-256 tar ${what} in ${label}`);
	const text = cString(field).trim();
	if (!/^[0-7]*$/.test(text)) throw new Error(`Invalid tar ${what} in ${label}`);
	return text === "" ? 0 : Number.parseInt(text, 8);
}

/** POSIX ustar headers have a `prefix` field; GNU headers keep other data in those bytes. */
function isPosixUstar(header: Buffer): boolean {
	return header.subarray(257, 263).toString() === "ustar\0";
}

function checksum(header: Buffer): { unsigned: number; signed: number } {
	let unsigned = 0,
		signed = 0;
	for (let index = 0; index < BLOCK; index++) {
		const byte = index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}
	return { unsigned, signed };
}

/**
 * PAX records are `<length> <key>=<value>\n`. A record needs its separator and a non-empty `key=` after it, so a valid
 * one always ends past its length field and every iteration advances. A `size` must be plain decimal digits, as GNU tar
 * requires. Any other empty value removes its keyword, so the header's own field applies.
 */
function parsePax(data: Buffer, label: string): Map<string, string> {
	const records = new Map<string, string>();
	for (let offset = 0; offset < data.length; ) {
		const space = data.indexOf(0x20, offset);
		const digits = data.subarray(offset, space).toString();
		const length = /^[1-9][0-9]*$/.test(digits) ? Number(digits) : 0;
		const record = data.subarray(space + 1, offset + length);
		const equals = record.indexOf(0x3d);
		if (space < 0 || offset + length > data.length || equals < 1 || record.at(-1) !== 0x0a)
			throw new Error(`Invalid PAX header in ${label}`);
		const key = record.subarray(0, equals).toString("utf8");
		const value = record.subarray(equals + 1, -1).toString("utf8");
		if (key === "size" && !/^[0-9]+$/.test(value)) throw new Error(`Invalid PAX header in ${label}`);
		if (value === "") records.delete(key);
		else records.set(key, value);
		offset += length;
	}
	return records;
}

/** Every member of `buf` with its exact byte range. Throws on anything it cannot walk exactly. */
export function listTarMembers(buf: Buffer, label: string): TarListing {
	const members: TarMember[] = [];
	let start: number | undefined,
		longName: string | undefined,
		pax = new Map<string, string>(),
		offset = 0;
	for (; offset < buf.length; ) {
		const header = buf.subarray(offset, offset + BLOCK);
		if (header.length < BLOCK) throw new Error(`Truncated tar archive: ${label}`);
		if (header.every((byte) => byte === 0)) break;
		const sum = octal(header.subarray(148, 156), "header checksum", label);
		const { unsigned, signed } = checksum(header);
		if (sum !== unsigned && sum !== signed)
			throw new Error(`Invalid tar header checksum at offset ${offset}: ${label}`);
		const type = String.fromCharCode(header[156] ?? 0);
		if (type === "S") throw new Error(`Unsupported GNU sparse member in ${label}`);
		const size = pax.has("size") ? Number(pax.get("size")) : octal(header.subarray(124, 136), "member size", label);
		const dataStart = offset + BLOCK;
		const end = dataStart + Math.ceil(size / BLOCK) * BLOCK;
		if (!Number.isSafeInteger(size) || end > buf.length) throw new Error(`Truncated tar archive: ${label}`);
		const data = buf.subarray(dataStart, dataStart + size);
		start ??= offset;
		if (type === "L") longName = cString(data);
		else if (type === "x") pax = parsePax(data, label);
		if (!EXTENSION_TYPES.has(type)) {
			const prefix = isPosixUstar(header) ? cString(header.subarray(345, 500)) : "";
			const name = cString(header.subarray(0, 100));
			members.push({
				name: pax.get("path") ?? longName ?? (prefix ? `${prefix}/${name}` : name),
				type,
				start,
				header,
				pax,
				data,
				end,
			});
			start = undefined;
			longName = undefined;
			pax = new Map();
		}
		offset = end;
	}
	if (start !== undefined) throw new Error(`Truncated tar archive: ${label}`);
	return { members, end: offset };
}

function writeOctal(header: Buffer, value: number, offset: number, width: number): void {
	header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width);
}

function sealHeader(header: Buffer): Buffer {
	header.fill(0x20, 148, 156);
	header.write(`${checksum(header).unsigned.toString(8).padStart(6, "0")}\0 `, 148, 8);
	return header;
}

function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let length = Buffer.byteLength(body);
	while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
	return `${length}${body}`;
}

function padded(data: Buffer): Buffer[] {
	const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
	return pad ? [data, Buffer.alloc(pad)] : [data];
}

/** A ustar `prefix`/`name` split of `name`, when it fits those fields. */
function ustarSplit(name: Buffer): [Buffer, Buffer] | undefined {
	if (name.length <= 100) return [Buffer.alloc(0), name];
	for (let slash = name.indexOf(0x2f); slash >= 0; slash = name.indexOf(0x2f, slash + 1))
		if (slash <= 155 && name.length - slash - 1 <= 100 && slash < name.length - 1)
			return [name.subarray(0, slash), name.subarray(slash + 1)];
	return undefined;
}

/** Header blocks and data for `name`, keeping the mode, owner and other fields of `template` when it is replaced. */
function memberBlocks(name: string, data: Buffer, template: TarMember | undefined): Buffer[] {
	const header = Buffer.alloc(BLOCK);
	const now = Math.floor(Date.now() / 1000);
	if (template) template.header.copy(header);
	else {
		writeOctal(header, 0o644, 100, 8);
		writeOctal(header, 0, 108, 8);
		writeOctal(header, 0, 116, 8);
		header.write("0", 156);
		header.write("ustar\0", 257);
		header.write("00", 263);
	}
	const posix = isPosixUstar(header);
	const nameBytes = Buffer.from(name);
	const split = posix || nameBytes.length <= 100 ? ustarSplit(nameBytes) : undefined;
	header.fill(0, 0, 100);
	if (posix) header.fill(0, 345, 500);
	(split?.[1] ?? nameBytes.subarray(0, 100)).copy(header, 0);
	split?.[0].copy(header, 345);
	writeOctal(header, data.length, 124, 12);
	writeOctal(header, now, 136, 12);
	const records = [...(template?.pax ?? [])].filter(([key]) => !REWRITTEN_PAX_KEYS.has(key));
	if (!split) records.push(["path", name]);
	const blocks = [sealHeader(header), ...padded(data)];
	if (records.length === 0) return blocks;
	const pax = Buffer.from(records.map(([key, value]) => paxRecord(key, value)).join(""));
	const paxHeader = Buffer.alloc(BLOCK);
	paxHeader.write("././@PaxHeader", 0);
	writeOctal(paxHeader, 0o644, 100, 8);
	writeOctal(paxHeader, 0, 108, 8);
	writeOctal(paxHeader, 0, 116, 8);
	writeOctal(paxHeader, pax.length, 124, 12);
	writeOctal(paxHeader, now, 136, 12);
	paxHeader.write("x", 156);
	paxHeader.write("ustar\0", 257);
	paxHeader.write("00", 263);
	return [sealHeader(paxHeader), ...padded(pax), ...blocks];
}

/**
 * `source` with `memberPath` set to `data`. Every other member keeps its exact bytes. A new member is appended before
 * the end-of-archive marker; an existing one must be a single regular file.
 */
export function writeTarMember(source: Buffer, memberPath: string, data: Buffer, label: string): Buffer {
	const { members, end } = listTarMembers(source, label);
	const matches = members.filter((member) => member.name === memberPath);
	if (matches.length > 1)
		throw new Error(
			`Archive member ${memberPath} appears ${matches.length} times in ${label}; refusing to choose one`,
		);
	const [target] = matches;
	if (target && !REGULAR_TYPES.has(target.type))
		throw new Error(
			`Archive member ${memberPath} is a ${TYPE_NAMES[target.type] ?? `type '${target.type}' entry`} in ${label}, not a regular file`,
		);
	if (target && [...target.pax.keys()].some((key) => key.startsWith("GNU.sparse")))
		throw new Error(`Archive member ${memberPath} is a sparse file in ${label}; refusing to rewrite it`);
	const blocks = memberBlocks(memberPath, data, target);
	if (target) return Buffer.concat([source.subarray(0, target.start), ...blocks, source.subarray(target.end)]);
	const trailer = source.subarray(end);
	return Buffer.concat([
		source.subarray(0, end),
		...blocks,
		trailer,
		Buffer.alloc(Math.max(0, 2 * BLOCK - trailer.length)),
	]);
}
