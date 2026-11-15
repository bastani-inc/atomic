import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, it } from "vitest";

const BLOCK = 512;
/** How long one parse may take before it counts as a hang; a valid or malformed archive here parses in microseconds. */
const PARSE_BOUND_MS = 5_000;
const FUZZ_CASES = 2_000;
/** The fuzz test spawns one worker and parses every case in it, each under its own bound. */
const FUZZ_TIMEOUT_MS = 120_000;
const TAR_MODULE = fileURLToPath(new URL("../src/core/tools/tar-archive.ts", import.meta.url));

/** Parses in a worker thread, so a parser that loops forever is terminated and reported instead of hanging the suite. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
import(require("node:url").pathToFileURL(workerData).href).then(({ listTarMembers }) => {
	parentPort.on("message", (bytes) => {
		try {
			listTarMembers(Buffer.from(bytes), "t.tar");
			parentPort.postMessage({ error: null });
		} catch (error) {
			parentPort.postMessage({ error: error.message });
		}
	});
	parentPort.postMessage({ ready: true });
});
`;

interface ParseReply {
	ready?: boolean;
	error?: string | null;
}

class BoundedParser {
	private worker = new Worker(WORKER_SOURCE, { eval: true, workerData: TAR_MODULE });
	private ready = this.next(PARSE_BOUND_MS * 4);

	private next(boundMs: number): Promise<ParseReply> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				// A worker stuck in a parse never answers again; replace it so later cases still run.
				void this.worker.terminate();
				this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: TAR_MODULE });
				this.ready = this.next(PARSE_BOUND_MS * 4);
				reject(new Error(`tar parse did not finish within ${boundMs} ms`));
			}, boundMs);
			const onMessage = (reply: ParseReply) => {
				clearTimeout(timer);
				resolve(reply);
			};
			this.worker.once("message", onMessage);
		});
	}

	/** The parse error message, or null when the archive parsed. Rejects when the parse exceeds the bound. */
	async parse(archive: Buffer): Promise<string | null> {
		await this.ready;
		const reply = this.next(PARSE_BOUND_MS);
		this.worker.postMessage(archive);
		return (await reply).error ?? null;
	}

	close(): Promise<number> {
		return this.worker.terminate();
	}
}

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

function member(name: string, type: string, data: Buffer): Buffer {
	return Buffer.concat([header(name, type, data.length), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
}

/** A PAX header carrying `records` verbatim, followed by a regular member and the end-of-archive marker. */
function withPax(records: string): Buffer {
	return Buffer.concat([
		member("././@PaxHeader", "x", Buffer.from(records)),
		member("f.txt", "0", Buffer.from("hello")),
		Buffer.alloc(BLOCK * 2),
	]);
}

let parser: BoundedParser;

beforeAll(() => {
	parser = new BoundedParser();
});

afterAll(async () => {
	await parser.close();
});

describe("malformed tar PAX headers (#5108)", () => {
	it("refuses trailing PAX bytes with no length separator instead of hanging (#5108)", async () => {
		assert.equal(await parser.parse(withPax("5 a=\nx")), "Invalid PAX header in t.tar");
	});

	it("refuses a zero-length PAX record (#5108)", async () => {
		assert.equal(await parser.parse(withPax("0 a=\n")), "Invalid PAX header in t.tar");
	});

	it("refuses a PAX length that does not cover its own length field (#5108)", async () => {
		assert.equal(await parser.parse(withPax("2 a=\n")), "Invalid PAX header in t.tar");
	});

	it("refuses a PAX record that runs past the header data (#5108)", async () => {
		assert.equal(await parser.parse(withPax("9 a=\n")), "Invalid PAX header in t.tar");
	});

	it("refuses a non-numeric PAX length (#5108)", async () => {
		assert.equal(await parser.parse(withPax("x5 a=\n")), "Invalid PAX header in t.tar");
	});

	it("still reads well-formed PAX records (#5108)", async () => {
		assert.equal(await parser.parse(withPax("5 a=\n6 bc=\n")), null);
	});

	it(
		"returns or throws within a bound for random mutations of a valid tar (#5108)",
		async () => {
			const parts = [
				member("././@PaxHeader", "x", Buffer.from("13 path=long\n5 a=\n")),
				member("short", "0", Buffer.from("payload")),
				member("././@LongLink", "L", Buffer.from("gnu/long/name\0")),
				member("x", "0", Buffer.alloc(600, 0x61)),
				Buffer.alloc(BLOCK * 2),
			];
			const valid = Buffer.concat(parts);
			const headers: number[] = [];
			for (let offset = 0, index = 0; index < parts.length - 1; offset += parts[index++]?.length ?? 0)
				headers.push(offset);
			const paxData = BLOCK;
			// A fixed-seed generator keeps any failing case reproducible.
			let seed = 0x5108;
			const random = (limit: number) => {
				seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
				return seed % limit;
			};
			const interesting = [0x00, 0x20, 0x30, 0x31, 0x39, 0x3d, 0x0a, 0x78, 0x4c, 0xff];
			for (let index = 0; index < FUZZ_CASES; index++) {
				const archive = Buffer.from(valid);
				for (let edit = 1 + random(4); edit > 0; edit--) {
					// Edits land in the PAX records, an octal digit of the PAX header's size or anywhere, in equal shares.
					const area = random(3);
					if (area === 1) archive[132 + random(3)] = 0x30 + random(8);
					else {
						const at = area === 0 ? paxData + random(24) : random(archive.length);
						archive[at] = random(2) ? (interesting[random(interesting.length)] ?? 0) : random(256);
					}
				}
				// Re-sealing the headers lets mutated sizes, types and names reach the walker past the checksum test.
				if (random(2)) for (const at of headers) seal(archive.subarray(at, at + BLOCK));
				const cut = random(4) === 0 ? random(archive.length) : archive.length;
				await assert.doesNotReject(parser.parse(archive.subarray(0, cut)), `fuzz case ${index}`);
			}
		},
		FUZZ_TIMEOUT_MS,
	);
});
