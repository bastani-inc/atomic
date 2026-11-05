import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createReadToolDefinition, type ReadToolOptions } from "../src/core/tools/read.js";
import { splitReadLineSelector } from "../src/core/tools/read-selectors.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-read-plain-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readText(dir: string, path: string, options?: ReadToolOptions): Promise<string> {
	const result = await createReadToolDefinition(dir, options).execute(
		`read-${path}`,
		{ path },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

async function readFixture(name: string, content: string, selector = name): Promise<string> {
	const dir = await createTempDir();
	await writeFile(join(dir, name), content, "utf8");
	return readText(dir, selector);
}

const SIX_LINES = "one\ntwo\nthree\nfour\nfive\nsix\n";
const CONFLICT = "pre\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\npost\n";

describe("read returns plain text (#4328)", () => {
	it("returns a whole file without headers or line numbers", async () => {
		assert.equal(await readFixture("plain.txt", "alpha\nbeta\n"), "alpha\nbeta");
	});

	it("bounded selectors include one line before and three after, under a label naming those lines", async () => {
		assert.equal(await readFixture("lines.txt", SIX_LINES, "lines.txt:5-5"), "[Lines 4-6 of 6]\nfour\nfive\nsix");
		assert.equal(
			await readFixture("lines.txt", SIX_LINES, "lines.txt:2-2"),
			"[Lines 1-5 of 6]\none\ntwo\nthree\nfour\nfive\n\n[1 more lines in file. Continue with path selector :6.]",
		);
		assert.partialDeepStrictEqual(splitReadLineSelector("http://localhost:3000"), { path: "http://localhost:3000" });
	});

	it("reads colon-delimited START:END selectors as a line range", async () => {
		assert.equal(await readFixture("lines.txt", SIX_LINES, "lines.txt:2:4"), SIX_LINES.trimEnd());
		const selector = splitReadLineSelector("/abs/Sat.Solver.fst:395:470");
		assert.equal(selector.ranges?.length, 1);
		assert.partialDeepStrictEqual(selector, {
			path: "/abs/Sat.Solver.fst",
			ranges: [{ start: 395, end: 470 }],
		});
	});

	it("an unbounded offset continues to the end of the file", async () => {
		assert.equal(await readFixture("lines.txt", SIX_LINES, "lines.txt:5"), "five\nsix");
	});

	it("a limited read names the next selector to continue with", async () => {
		const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
		assert.equal(
			await readFixture("long.txt", `${lines}\n`, "long.txt:1+2"),
			"[Lines 1-5 of 30]\nline-1\nline-2\nline-3\nline-4\nline-5\n\n[25 more lines in file. Continue with path selector :6.]",
		);
	});

	it("raw bounded reads return exactly the requested lines", async () => {
		assert.equal(await readFixture("lines.txt", SIX_LINES, "lines.txt:3-3:raw"), "three");
	});

	it("a first line over the byte limit gets guidance instead of content", async () => {
		const output = await readFixture("emoji.txt", "😀".repeat(20_000));
		assert.match(output, /^\[Line 1 is .* exceeds 50\.0KB limit\. Use bash: sed -n '1p' emoji\.txt/);
	});

	it("conflict-only reads return the conflict regions", async () => {
		assert.equal(
			await readFixture("conflict.txt", CONFLICT, "conflict.txt:conflicts"),
			"<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs",
		);
		assert.equal(await readFixture("plain.txt", "alpha\nbeta\n", "plain.txt:conflicts"), "No conflict markers found");
	});

	it("line selectors on a conflict view count lines of the view", async () => {
		assert.equal(
			await readFixture("conflict.txt", CONFLICT, "conflict.txt:conflicts:3+1"),
			"[Lines 2-5 of 5]\nleft\n=======\nright\n>>>>>>> theirs",
		);
		assert.equal(
			await readFixture("conflict.txt", CONFLICT, "conflict.txt:conflicts:3"),
			"=======\nright\n>>>>>>> theirs",
		);
	});

	it("custom read operations need no local file and handle non-SQLite .db selectors", async () => {
		const options: ReadToolOptions = {
			operations: { access: async () => {}, readFile: async () => Buffer.from("one\ntwo\nthree\n") },
		};
		assert.equal(await readText("/tmp/nonexistent-atomic-cwd", "remote.txt", options), "one\ntwo\nthree");
		assert.equal(await readText("/tmp/nonexistent-atomic-cwd", "notes.db:2-2", options), "one\ntwo\nthree");
	});

	it("drops only the terminal newline, keeping a genuine final blank line", async () => {
		assert.equal(await readFixture("a.txt", "a\n"), "a");
		assert.equal(await readFixture("a.txt", "a\n\n"), "a\n");
		assert.equal(await readFixture("a.txt", "a\nb"), "a\nb");
		assert.equal(await readFixture("a.txt", "a\n", "a.txt:raw"), "a\n");
	});

	it("selector reads agree with the whole-file read", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "abc.txt"), "a\nb\nc\n", "utf8");
		const whole = await readText(dir, "abc.txt");
		assert.equal(whole, "a\nb\nc");
		for (const selector of ["abc.txt:1-3", "abc.txt:1+3", "abc.txt:2-3"])
			assert.equal(await readText(dir, selector), whole);
	});

	it("keeps a genuine blank line at the line truncation boundary", async () => {
		const lines = Array.from({ length: 3001 }, (_, index) => (index === 2999 ? "" : `line-${index + 1}`));
		for (const ending of ["\n", "\r\n"]) {
			const output = await readFixture("long.txt", `${lines.join(ending)}${ending}`);
			assert.equal(
				output.endsWith("line-2999\n\n\n[Showing lines 1-3000 of 3001. Continue with path selector :3001.]"),
				true,
			);
		}
	});

	it("keeps a genuine blank line at the byte truncation boundary", async () => {
		const lines = Array.from({ length: 800 }, (_, index) => (index === 423 ? "" : "é".repeat(60)));
		const output = await readFixture("wide.txt", `${lines.join("\n")}\n`);
		assert.equal(
			output.endsWith(
				`${"é".repeat(60)}\n\n\n[Showing lines 1-424 of 800 (50.0KB limit). Continue with path selector :425.]`,
			),
			true,
		);
	});

	it("normalizes CRLF to LF unless the read is raw", async () => {
		const source = "a\r\nb\r\nc\r\n";
		assert.equal(await readFixture("crlf.txt", source), "a\nb\nc");
		assert.equal(await readFixture("crlf.txt", source, "crlf.txt:2"), "b\nc");
		assert.equal(await readFixture("crlf.txt", "a\r\n\r\n"), "a\n");
		assert.equal(await readFixture("crlf.txt", source, "crlf.txt:raw"), source);
		assert.equal(
			await readFixture("crlf.txt", source, "crlf.txt:4"),
			"Requested line 4 is beyond end of file (3 lines total). Use crlf.txt:3 to read the final line.",
		);
	});
});

const FORTY_LINES = `${Array.from({ length: 40 }, (_, index) => `row${index + 1}`).join("\n")}\n`;
const rows = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, index) => `row${from + index}`).join("\n");

describe("range selections label their lines (#4328)", () => {
	it("labels each range of a discontiguous selection and continues after the last one", async () => {
		assert.equal(
			await readFixture("big.txt", FORTY_LINES, "big.txt:10-11,30-31"),
			`[Lines 9-14 of 40]\n${rows(9, 14)}\n[Lines 29-34 of 40]\n${rows(29, 34)}\n\n[6 more lines in file. Continue with path selector :35.]`,
		);
	});

	it("merges adjacent and overlapping ranges under one label", async () => {
		assert.equal(
			await readFixture("big.txt", FORTY_LINES, "big.txt:10-11,12-13"),
			`[Lines 9-16 of 40]\n${rows(9, 16)}\n\n[24 more lines in file. Continue with path selector :17.]`,
		);
		assert.equal(
			await readFixture("big.txt", FORTY_LINES, "big.txt:10-10,15-15"),
			`[Lines 9-18 of 40]\n${rows(9, 18)}\n\n[22 more lines in file. Continue with path selector :19.]`,
		);
	});

	it("labels a gap of a single line", async () => {
		assert.equal(
			await readFixture("big.txt", FORTY_LINES, "big.txt:10-10,16-16"),
			`[Lines 9-13 of 40]\n${rows(9, 13)}\n[Lines 15-19 of 40]\n${rows(15, 19)}\n\n[21 more lines in file. Continue with path selector :20.]`,
		);
	});

	it("labels ranges near the end and stops the hint at the last line", async () => {
		assert.equal(
			await readFixture("big.txt", FORTY_LINES, "big.txt:36-36"),
			`[Lines 35-39 of 40]\n${rows(35, 39)}\n\n[1 more lines in file. Continue with path selector :40.]`,
		);
		assert.equal(await readFixture("big.txt", FORTY_LINES, "big.txt:38-39"), `[Lines 37-40 of 40]\n${rows(37, 40)}`);
	});

	it("sorts multi-range reads and rejects open-ended plus selectors", async () => {
		assert.equal(await readFixture("lines.txt", "one\ntwo\nthree\nfour\n", "lines.txt:3-3,1-1:raw"), "one\nthree");
		const thirty = `${Array.from({ length: 30 }, (_, index) => `r${index + 1}`).join("\n")}\n`;
		const sorted = Array.from({ length: 5 }, (_, index) => `r${index + 2}`).join("\n");
		const later = Array.from({ length: 5 }, (_, index) => `r${index + 19}`).join("\n");
		assert.equal(
			await readFixture("long.txt", thirty, "long.txt:20-20,3-3"),
			`[Lines 2-6 of 30]\n${sorted}\n[Lines 19-23 of 30]\n${later}\n\n[7 more lines in file. Continue with path selector :24.]`,
		);
		assert.throws(() => splitReadLineSelector("lines.txt:2+"), /\+ requires a line count/);
	});

	it("keeps raw multi-range reads to the exact lines, unlabelled", async () => {
		assert.equal(await readFixture("big.txt", FORTY_LINES, "big.txt:10-11,30-31:raw"), "row10\nrow11\nrow30\nrow31");
	});

	it("continues a truncated selection after the last line shown", async () => {
		const huge = `${Array.from({ length: 6000 }, (_, index) => `L${index + 1}`).join("\n")}\n`;
		const output = await readFixture("huge.txt", huge, "huge.txt:1-2000,4000-5000");
		assert.equal(output.startsWith("[Lines 1-2003 of 6000]\nL1\n"), true);
		assert.ok(output.includes("\nL2003\n[Lines 3999-4995 of 6000]\nL3999\n"));
		assert.equal(
			output.endsWith("\nL4995\n\n[Showing lines 1-4995 of 6000. Continue with path selector :4996.]"),
			true,
		);
	});
});
