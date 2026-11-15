import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { listTarMembers, writeTarMember } from "../src/core/tools/tar-archive.js";

const BLOCK = 512;
const NOW_SECONDS = 1_700_000_000;

interface HeaderFields {
	name: string;
	type?: string;
	size: number;
	mode?: number;
	uid?: number;
	mtime?: number;
	linkname?: string;
	magic?: "posix" | "gnu" | "v7";
	prefix?: string;
	uname?: string;
	/** Raw bytes for GNU's atime/ctime area (offset 345) in a GNU header. */
	gnuExtra?: string;
}

function octalField(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(fields: HeaderFields): Buffer {
	const block = Buffer.alloc(BLOCK);
	block.write(fields.name, 0, 100);
	block.write(octalField(fields.mode ?? 0o644, 8), 100);
	block.write(octalField(fields.uid ?? 0, 8), 108);
	block.write(octalField(fields.uid ?? 0, 8), 116);
	block.write(octalField(fields.size, 12), 124);
	block.write(octalField(fields.mtime ?? NOW_SECONDS, 12), 136);
	block.write(fields.type ?? "0", 156);
	block.write(fields.linkname ?? "", 157, 100);
	const magic = fields.magic ?? "posix";
	if (magic === "posix") block.write("ustar\x0000", 257);
	if (magic === "gnu") block.write("ustar  \0", 257);
	block.write(fields.uname ?? "", 265, 32);
	block.write(fields.prefix ?? "", 345, 155);
	block.write(fields.gnuExtra ?? "", 345);
	block.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
}

function pad(data: Buffer): Buffer {
	return Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
}

function member(fields: Omit<HeaderFields, "size">, data = ""): Buffer {
	const body = Buffer.from(data);
	return Buffer.concat([header({ ...fields, size: body.length }), pad(body)]);
}

function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let length = Buffer.byteLength(body);
	while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
	return `${length}${body}`;
}

function paxMember(records: string, fields: Omit<HeaderFields, "size">, data = ""): Buffer {
	return Buffer.concat([member({ name: "././@PaxHeader", type: "x" }, records), member(fields, data)]);
}

const EOF = Buffer.alloc(BLOCK * 2);
const names = (archive: Buffer) => listTarMembers(archive, "t.tar").members.map((entry) => entry.name);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW_SECONDS * 1000 + 999);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("tar member writes (#4906)", () => {
	it("appends a new member as a plain ustar header, its padded data and the end-of-archive marker (#4906)", () => {
		const data = Buffer.from("hello\n");
		assert.deepEqual(
			writeTarMember(Buffer.alloc(0), "a.txt", data, "t.tar"),
			Buffer.concat([header({ name: "a.txt", size: data.length }), pad(data), EOF]),
		);
	});

	it("keeps a block-aligned member without padding and a longer trailer as it was (#4906)", () => {
		const first = member({ name: "one" }, "x".repeat(BLOCK));
		const trailer = Buffer.alloc(BLOCK * 20);
		const data = Buffer.from("y".repeat(BLOCK));
		assert.deepEqual(
			writeTarMember(Buffer.concat([first, trailer]), "two", data, "t.tar"),
			Buffer.concat([first, header({ name: "two", size: BLOCK }), data, trailer]),
		);
	});

	it("completes a missing end-of-archive marker (#4906)", () => {
		const first = member({ name: "one" }, "1");
		const data = Buffer.from("2");
		assert.deepEqual(
			writeTarMember(Buffer.concat([first, Buffer.alloc(BLOCK)]), "two", data, "t.tar"),
			Buffer.concat([first, header({ name: "two", size: 1 }), pad(data), EOF]),
		);
	});

	it("replaces a member in place, keeping its mode, owner and neighbours (#4906)", () => {
		const before = member({ name: "a" }, "a");
		const after = member({ name: "c", type: "2", linkname: "b" });
		const target = { name: "b", mode: 0o750, uid: 1000, uname: "dev" };
		const archive = Buffer.concat([before, member(target, "old"), after, EOF]);
		assert.deepEqual(
			writeTarMember(archive, "b", Buffer.from("new!"), "t.tar"),
			Buffer.concat([before, header({ ...target, size: 4 }), pad(Buffer.from("new!")), after, EOF]),
		);
	});

	it.each([
		["a 100-byte name", "n".repeat(100), "", "n".repeat(100)],
		[
			"a 155-byte prefix and a 100-byte name",
			`${"p".repeat(155)}/${"n".repeat(100)}`,
			"p".repeat(155),
			"n".repeat(100),
		],
		[
			"the first slash that fits",
			`${"a".repeat(10)}/${"b".repeat(60)}/${"c".repeat(60)}`,
			`${"a".repeat(10)}/${"b".repeat(60)}`,
			"c".repeat(60),
		],
	])("stores %s in the ustar name and prefix fields (#4906)", (_case, name, prefix, base) => {
		const written = writeTarMember(Buffer.alloc(0), name, Buffer.from("x"), "t.tar");
		assert.deepEqual(written.subarray(0, BLOCK), header({ name: base, prefix, size: 1 }));
		assert.deepEqual(names(written), [name]);
	});

	it.each([
		["a 101-byte name without a slash", "n".repeat(101)],
		["a 156-byte prefix", `${"p".repeat(156)}/n`],
		["a 101-byte last component", `p/${"n".repeat(101)}`],
		["a name ending in a slash", `${"n".repeat(101)}/`],
	])("stores %s in a PAX path record (#4906)", (_case, name) => {
		const written = writeTarMember(Buffer.alloc(0), name, Buffer.from("x"), "t.tar");
		const records = Buffer.from(paxRecord("path", name));
		assert.deepEqual(
			written,
			Buffer.concat([
				header({ name: "././@PaxHeader", type: "x", size: records.length }),
				pad(records),
				header({ name: Buffer.from(name).subarray(0, 100).toString(), size: 1 }),
				pad(Buffer.from("x")),
				EOF,
			]),
		);
		assert.deepEqual(names(written), [name]);
	});

	it("keeps a replaced member's other PAX records and rewrites its path, size and mtime (#4906)", () => {
		const longName = `${"d".repeat(120)}.txt`;
		const records = [
			paxRecord("path", longName),
			paxRecord("size", "3"),
			paxRecord("mtime", "1.5"),
			paxRecord("SCHILY.xattr.user.tag", "kept"),
		].join("");
		const archive = Buffer.concat([paxMember(records, { name: "short" }, "old"), EOF]);
		const written = writeTarMember(archive, longName, Buffer.from("new"), "t.tar");
		const [entry] = listTarMembers(written, "t.tar").members;
		assert.deepEqual(
			[...(entry?.pax ?? [])],
			[
				["SCHILY.xattr.user.tag", "kept"],
				["path", longName],
			],
		);
		assert.equal(entry?.data.toString(), "new");
	});

	it("keeps a GNU header's own fields and uses a PAX path for a long name (#4906)", () => {
		const gnu = { name: "g", magic: "gnu" as const, gnuExtra: "12345670123" };
		const archive = Buffer.concat([member(gnu, "old"), EOF]);
		const written = writeTarMember(archive, "g", Buffer.from("new"), "t.tar");
		assert.deepEqual(written.subarray(0, BLOCK), header({ ...gnu, size: 3 }));
		const longName = `x/${"y".repeat(120)}`;
		const appended = writeTarMember(written, longName, Buffer.from("z"), "t.tar");
		assert.deepEqual(names(appended), ["g", longName]);
	});

	it("rewrites a GNU member with a long name through a PAX path, keeping a 100-byte name in its header (#4906)", () => {
		const longName = `x/${"y".repeat(120)}`;
		const gnu = { name: longName.slice(0, 100), magic: "gnu" as const, gnuExtra: "1234" };
		const archive = Buffer.concat([
			member({ name: "././@LongLink", type: "L", magic: "gnu" }, `${longName}\0`),
			member(gnu, "old"),
			member({ name: "n".repeat(100), magic: "gnu", gnuExtra: "5678" }, "old"),
			EOF,
		]);
		const written = writeTarMember(archive, longName, Buffer.from("new"), "t.tar");
		const records = Buffer.from(paxRecord("path", longName));
		const rest = writeTarMember(written, "n".repeat(100), Buffer.from("two"), "t.tar");
		assert.deepEqual(
			rest,
			Buffer.concat([
				header({ name: "././@PaxHeader", type: "x", size: records.length }),
				pad(records),
				header({ ...gnu, size: 3 }),
				pad(Buffer.from("new")),
				header({ name: "n".repeat(100), magic: "gnu", gnuExtra: "5678", size: 3 }),
				pad(Buffer.from("two")),
				EOF,
			]),
		);
	});

	it("clears a POSIX header's old prefix when it rewrites the name (#4906)", () => {
		const dir = "d".repeat(20);
		const name = `${"q".repeat(90)}.txt`;
		const target = { name: "stale", prefix: "s".repeat(150) };
		const archive = Buffer.concat([paxMember(paxRecord("path", `${dir}/${name}`), target, "old"), EOF]);
		const written = writeTarMember(archive, `${dir}/${name}`, Buffer.from("new"), "t.tar");
		assert.deepEqual(written.subarray(0, BLOCK), header({ ...target, name, prefix: dir, size: 3 }));
	});

	it.each([
		["2", "symbolic link"],
		["1", "hard link"],
		["5", "directory"],
		["3", "character device"],
		["4", "block device"],
		["6", "FIFO"],
		["V", "type 'V' entry"],
	])("refuses to overwrite a type %j member (#4906)", (type, description) => {
		const archive = Buffer.concat([member({ name: "m", type }), EOF]);
		assert.throws(
			() => writeTarMember(archive, "m", Buffer.from("x"), "t.tar"),
			new Error(`Archive member m is a ${description} in t.tar, not a regular file`),
		);
	});

	it.each(["0", "\0", "7"])("overwrites a regular type %j member (#4906)", (type) => {
		const archive = Buffer.concat([member({ name: "m", type }, "old"), EOF]);
		assert.equal(
			listTarMembers(writeTarMember(archive, "m", Buffer.from("new"), "t.tar"), "t.tar").members[0]?.data.toString(),
			"new",
		);
	});

	it("refuses a member stored twice (#4906)", () => {
		const archive = Buffer.concat([member({ name: "m" }, "1"), member({ name: "m" }, "2"), EOF]);
		assert.throws(
			() => writeTarMember(archive, "m", Buffer.from("x"), "t.tar"),
			new Error("Archive member m appears 2 times in t.tar; refusing to choose one"),
		);
	});

	it("refuses a PAX sparse member (#4906)", () => {
		const archive = Buffer.concat([paxMember(paxRecord("GNU.sparse.major", "1"), { name: "m" }, "x"), EOF]);
		assert.throws(
			() => writeTarMember(archive, "m", Buffer.from("x"), "t.tar"),
			new Error("Archive member m is a sparse file in t.tar; refusing to rewrite it"),
		);
		const other = Buffer.concat([paxMember(paxRecord("SCHILY.sparse", "1"), { name: "m" }, "x"), EOF]);
		assert.doesNotThrow(() => writeTarMember(other, "m", Buffer.from("x"), "t.tar"));
	});
});

describe("tar archive listing (#4906)", () => {
	it("names members by PAX path, then GNU long name, then POSIX prefix and name (#4906)", () => {
		const archive = Buffer.concat([
			paxMember(paxRecord("path", "from-pax"), { name: "ignored" }),
			member({ name: "././@LongLink", type: "L" }, "from-gnu\0junk"),
			member({ name: "ignored" }),
			member({ name: "base", prefix: "pre" }),
			member({ name: "gnu-base", magic: "gnu", gnuExtra: "1234" }),
			member({ name: "v7", magic: "v7", prefix: "nope" }),
			member({ name: "plain" }),
			EOF,
			member({ name: "after-eof" }),
		]);
		const listing = listTarMembers(archive, "t.tar");
		assert.deepEqual(
			listing.members.map((entry) => entry.name),
			["from-pax", "from-gnu", "pre/base", "gnu-base", "v7", "plain"],
		);
		assert.equal(listing.end, archive.length - EOF.length - BLOCK);
		assert.deepEqual(
			listing.members.map((entry) => entry.start),
			[0, BLOCK * 3, BLOCK * 6, BLOCK * 7, BLOCK * 8, BLOCK * 9],
		);
	});

	it("names a link by its GNU long link name header's member and lists an archive without an end marker (#4906)", () => {
		const archive = Buffer.concat([
			member({ name: "././@LongLink", type: "K" }, `${"t".repeat(120)}\0`),
			member({ name: "link", type: "2", linkname: "t".repeat(100) }),
			member({ name: "last" }, "x".repeat(BLOCK)),
		]);
		const listing = listTarMembers(archive, "t.tar");
		assert.deepEqual(
			listing.members.map((entry) => [entry.name, entry.type, entry.start]),
			[
				["link", "2", 0],
				["last", "0", BLOCK * 3],
			],
		);
		assert.equal(listing.end, archive.length);
	});

	it("reads empty and space-terminated numeric fields (#4906)", () => {
		const block = header({ name: "a", size: 0 });
		block.fill(0, 124, 136);
		const spaced = header({ name: "b", size: 3 });
		spaced.write(" 00000000003", 124);
		for (const damaged of [block, spaced]) {
			damaged.fill(0x20, 148, 156);
			let sum = 0;
			for (const byte of damaged) sum += byte;
			damaged.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		}
		const listing = listTarMembers(Buffer.concat([block, spaced, pad(Buffer.from("bbb")), EOF]), "t.tar");
		assert.deepEqual(
			listing.members.map((entry) => [entry.name, entry.data.toString()]),
			[
				["a", ""],
				["b", "bbb"],
			],
		);
	});

	it("refuses a negative PAX size (#4906)", () => {
		const archive = Buffer.concat([paxMember(paxRecord("size", "-1"), { name: "a" }), EOF]);
		assert.throws(() => listTarMembers(archive, "t.tar"), new Error("Invalid PAX header in t.tar"));
	});

	it("uses a PAX size record for the member's data length (#4906)", () => {
		const data = "z".repeat(600);
		const archive = Buffer.concat([
			member({ name: "././@PaxHeader", type: "x" }, paxRecord("size", "600")),
			header({ name: "big", size: 0 }),
			pad(Buffer.from(data)),
			member({ name: "next" }, "n"),
			EOF,
		]);
		const [big, next] = listTarMembers(archive, "t.tar").members;
		assert.equal(big?.data.toString(), data);
		assert.equal(next?.name, "next");
	});

	it("accepts a header whose checksum was computed with signed bytes (#4906)", () => {
		const block = header({ name: "é", size: 0 });
		let signed = 0;
		block.fill(0x20, 148, 156);
		for (const byte of block) signed += byte > 127 ? byte - 256 : byte;
		block.write(`${signed.toString(8).padStart(6, "0")}\0 `, 148);
		assert.deepEqual(names(Buffer.concat([block, EOF])), ["é"]);
	});

	it.each([
		["a short final header", Buffer.alloc(100, 1), "Truncated tar archive: t.tar"],
		["data past the end", header({ name: "a", size: 10 }), "Truncated tar archive: t.tar"],
		[
			"an extension header with no member",
			member({ name: "././@LongLink", type: "L" }, "x"),
			"Truncated tar archive: t.tar",
		],
		[
			"a damaged checksum",
			Buffer.from(header({ name: "a", size: 0 }).fill(0x62, 0, 1)),
			"Invalid tar header checksum at offset 0: t.tar",
		],
		["a GNU sparse member", header({ name: "a", type: "S", size: 0 }), "Unsupported GNU sparse member in t.tar"],
		[
			"a non-octal checksum",
			Buffer.from(header({ name: "a", size: 0 }).fill(0x7a, 148, 154)),
			"Invalid tar header checksum in t.tar",
		],
	])("refuses %s (#4906)", (_case, bytes, message) => {
		assert.throws(() => listTarMembers(bytes, "t.tar"), new Error(message));
	});

	it.each([
		[
			"a base-256 size",
			(block: Buffer) => block.fill(0x80, 124, 125),
			"Unsupported base-256 tar member size in t.tar",
		],
		["a non-octal size", (block: Buffer) => block.write("00000000009\0", 124), "Invalid tar member size in t.tar"],
	])("refuses %s (#4906)", (_case, damage, message) => {
		const block = header({ name: "a", size: 0 });
		damage(block);
		block.fill(0x20, 148, 156);
		let sum = 0;
		for (const byte of block) sum += byte;
		block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		assert.throws(() => listTarMembers(Buffer.concat([block, EOF]), "t.tar"), new Error(message));
	});

	it.each([
		["no length", "path=x\n"],
		["a zero length", "0 path=x\n"],
		["a length past the data", "99 path=x\n"],
		["no key", "9 =value\n"],
		["no newline", "9 path=xy"],
		["no separator", "9 pathxy\n"],
	])("refuses a PAX header with %s (#4906)", (_case, records) => {
		const archive = Buffer.concat([paxMember(records, { name: "a" }), EOF]);
		assert.throws(() => listTarMembers(archive, "t.tar"), new Error("Invalid PAX header in t.tar"));
	});

	it("reads several PAX records, including multi-byte values (#4906)", () => {
		const records = paxRecord("path", "naïve") + paxRecord("comment", "a=b");
		const [entry] = listTarMembers(Buffer.concat([paxMember(records, { name: "a" }), EOF]), "t.tar").members;
		assert.deepEqual(
			[...(entry?.pax ?? [])],
			[
				["path", "naïve"],
				["comment", "a=b"],
			],
		);
		assert.equal(entry?.name, "naïve");
	});
});
