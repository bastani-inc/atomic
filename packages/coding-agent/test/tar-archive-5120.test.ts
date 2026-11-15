import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { listTarMembers, writeTarMember } from "../src/core/tools/tar-archive.js";

const BLOCK = 512;

function seal(block: Buffer): Buffer {
	block.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
}

function header(name: string, type: string, size: number): Buffer {
	const block = Buffer.alloc(BLOCK);
	block.write(name, 0, 100);
	block.write("0000644\0", 100);
	block.write("0000000\0", 108);
	block.write("0000000\0", 116);
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	block.write("00000000000\0", 136);
	block.write(type, 156);
	block.write("ustar\x0000", 257);
	return seal(block);
}

function padded(data: Buffer): Buffer {
	return Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
}

function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let length = body.length;
	while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
	return `${length}${body}`;
}

/** A PAX `x` header carrying `records`, then a regular member `hdr.txt` whose header says 5 bytes, holding `body`. */
function archiveWithPax(records: [string, string][], body = "hello"): Buffer {
	const pax = Buffer.from(records.map(([key, value]) => paxRecord(key, value)).join(""));
	return Buffer.concat([
		header("././@PaxHeader", "x", pax.length),
		padded(pax),
		header("hdr.txt", "0", 5),
		padded(Buffer.from(body)),
		Buffer.alloc(2 * BLOCK),
	]);
}

const gnuTar = (() => {
	const probe = spawnSync("tar", ["--version"], { encoding: "utf8" });
	return probe.status === 0 && probe.stdout.includes("GNU tar");
})();
const scratch = mkdtempSync(join(tmpdir(), "tar-5120-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** GNU tar's member list for `archive`, or its error when it refuses it; undefined when GNU tar is not installed. */
function gnuList(archive: Buffer): { names: string[] } | { error: string } | undefined {
	if (!gnuTar) return undefined;
	const file = join(scratch, `${Math.random().toString(36).slice(2)}.tar`);
	writeFileSync(file, archive);
	const result = spawnSync("tar", ["-tf", file], { encoding: "utf8" });
	return result.status === 0 ? { names: result.stdout.split("\n").filter(Boolean) } : { error: result.stderr };
}

describe("tar PAX values (#5120)", () => {
	for (const size of ["0x5", "5e0", " 5", "5 ", "+5", "5.0", ""]) {
		it(`refuses a PAX size of ${JSON.stringify(size)} as an invalid PAX header (#5120)`, () => {
			const archive = archiveWithPax([["size", size]]);
			assert.throws(() => listTarMembers(archive, "t.tar"), /Invalid PAX header in t\.tar/);
			const gnu = gnuList(archive);
			if (gnu) assert.ok("error" in gnu, `GNU tar accepted size=${JSON.stringify(size)}`);
		});
	}

	it("reads a plain decimal PAX size over the header size (#5120)", () => {
		const archive = archiveWithPax([["size", "3"]], "hel");
		const [member] = listTarMembers(archive, "t.tar").members;
		assert.equal(member?.data.toString(), "hel");
	});

	it("lists a member with an empty PAX path under its header name, as GNU tar does (#5120)", () => {
		const archive = archiveWithPax([["path", ""]]);
		const names = listTarMembers(archive, "t.tar").members.map((member) => member.name);
		assert.deepEqual(names, ["hdr.txt"]);
		const gnu = gnuList(archive);
		if (gnu) assert.deepEqual(gnu, { names });
	});

	it("keeps an earlier PAX path when a later record in the same header is empty, as GNU tar does (#5120)", () => {
		const archive = archiveWithPax([
			["path", "other.txt"],
			["path", ""],
		]);
		const names = listTarMembers(archive, "t.tar").members.map((member) => member.name);
		assert.deepEqual(names, ["other.txt"]);
		const gnu = gnuList(archive);
		if (gnu) assert.deepEqual(gnu, { names });
	});

	it("rewrites the member named by its header after an empty PAX path instead of adding a duplicate (#5120)", () => {
		const archive = archiveWithPax([
			["path", ""],
			["comment", "kept"],
		]);
		const written = writeTarMember(archive, "hdr.txt", Buffer.from("new"), "t.tar");
		const members = listTarMembers(written, "t.tar").members;
		assert.deepEqual(
			members.map((member) => [member.name, member.data.toString()]),
			[["hdr.txt", "new"]],
		);
		assert.deepEqual([...(members[0]?.pax ?? [])], [["comment", "kept"]]);
		const gnu = gnuList(written);
		if (gnu) assert.deepEqual(gnu, { names: ["hdr.txt"] });
	});

	it("drops an empty PAX linkpath record (#5120)", () => {
		const archive = archiveWithPax([["linkpath", ""]]);
		const [member] = listTarMembers(archive, "t.tar").members;
		assert.equal(member?.pax.has("linkpath"), false);
	});
});
