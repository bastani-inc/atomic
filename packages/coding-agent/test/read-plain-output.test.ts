import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition, type ReadToolOptions } from "../src/core/tools/read.ts";
import { splitReadLineSelector } from "../src/core/tools/read-selectors.ts";

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
		expect(await readFixture("plain.txt", "alpha\nbeta\n")).toBe("alpha\nbeta");
	});

	it("bounded selectors include one line before and three after, under a label naming those lines", async () => {
		expect(await readFixture("lines.txt", SIX_LINES, "lines.txt:5-5")).toBe("[Lines 4-6 of 6]\nfour\nfive\nsix");
		expect(await readFixture("lines.txt", SIX_LINES, "lines.txt:2-2")).toBe(
			"[Lines 1-5 of 6]\none\ntwo\nthree\nfour\nfive\n\n[1 more lines in file. Continue with path selector :6.]",
		);
		expect(splitReadLineSelector("http://localhost:3000")).toMatchObject({ path: "http://localhost:3000" });
	});

	it("reads colon-delimited START:END selectors as a line range", async () => {
		expect(await readFixture("lines.txt", SIX_LINES, "lines.txt:2:4")).toBe(SIX_LINES.trimEnd());
		expect(splitReadLineSelector("/abs/Sat.Solver.fst:395:470")).toMatchObject({
			path: "/abs/Sat.Solver.fst",
			ranges: [{ start: 395, end: 470 }],
		});
	});

	it("an unbounded offset continues to the end of the file", async () => {
		expect(await readFixture("lines.txt", SIX_LINES, "lines.txt:5")).toBe("five\nsix");
	});

	it("a limited read names the next selector to continue with", async () => {
		const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
		expect(await readFixture("long.txt", `${lines}\n`, "long.txt:1+2")).toBe(
			"[Lines 1-5 of 30]\nline-1\nline-2\nline-3\nline-4\nline-5\n\n[25 more lines in file. Continue with path selector :6.]",
		);
	});

	it("raw bounded reads return exactly the requested lines", async () => {
		expect(await readFixture("lines.txt", SIX_LINES, "lines.txt:3-3:raw")).toBe("three");
	});

	it("a first line over the byte limit gets guidance instead of content", async () => {
		const output = await readFixture("emoji.txt", "😀".repeat(20_000));
		expect(output).toMatch(/^\[Line 1 is .* exceeds 50\.0KB limit\. Use bash: sed -n '1p' emoji\.txt/);
	});

	it("conflict-only reads return the conflict regions", async () => {
		expect(await readFixture("conflict.txt", CONFLICT, "conflict.txt:conflicts")).toBe(
			"<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs",
		);
		expect(await readFixture("plain.txt", "alpha\nbeta\n", "plain.txt:conflicts")).toBe("No conflict markers found");
	});

	it("line selectors on a conflict view count lines of the view", async () => {
		expect(await readFixture("conflict.txt", CONFLICT, "conflict.txt:conflicts:3+1")).toBe(
			"[Lines 2-5 of 5]\nleft\n=======\nright\n>>>>>>> theirs",
		);
		expect(await readFixture("conflict.txt", CONFLICT, "conflict.txt:conflicts:3")).toBe(
			"=======\nright\n>>>>>>> theirs",
		);
	});

	it("custom read operations need no local file and handle non-SQLite .db selectors", async () => {
		const options: ReadToolOptions = {
			operations: { access: async () => {}, readFile: async () => Buffer.from("one\ntwo\nthree\n") },
		};
		expect(await readText("/tmp/nonexistent-atomic-cwd", "remote.txt", options)).toBe("one\ntwo\nthree");
		expect(await readText("/tmp/nonexistent-atomic-cwd", "notes.db:2-2", options)).toBe("one\ntwo\nthree");
	});

	it("drops only the terminal newline, keeping a genuine final blank line", async () => {
		expect(await readFixture("a.txt", "a\n")).toBe("a");
		expect(await readFixture("a.txt", "a\n\n")).toBe("a\n");
		expect(await readFixture("a.txt", "a\nb")).toBe("a\nb");
		expect(await readFixture("a.txt", "a\n", "a.txt:raw")).toBe("a\n");
	});

	it("selector reads agree with the whole-file read", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "abc.txt"), "a\nb\nc\n", "utf8");
		const whole = await readText(dir, "abc.txt");
		expect(whole).toBe("a\nb\nc");
		for (const selector of ["abc.txt:1-3", "abc.txt:1+3", "abc.txt:2-3"])
			expect(await readText(dir, selector)).toBe(whole);
	});

	it("keeps a genuine blank line at the line truncation boundary", async () => {
		const lines = Array.from({ length: 3001 }, (_, index) => (index === 2999 ? "" : `line-${index + 1}`));
		for (const ending of ["\n", "\r\n"]) {
			const output = await readFixture("long.txt", `${lines.join(ending)}${ending}`);
			expect(
				output.endsWith("line-2999\n\n\n[Showing lines 1-3000 of 3001. Continue with path selector :3001.]"),
			).toBe(true);
		}
	});

	it("keeps a genuine blank line at the byte truncation boundary", async () => {
		const lines = Array.from({ length: 800 }, (_, index) => (index === 423 ? "" : "é".repeat(60)));
		const output = await readFixture("wide.txt", `${lines.join("\n")}\n`);
		expect(
			output.endsWith(
				`${"é".repeat(60)}\n\n\n[Showing lines 1-424 of 800 (50.0KB limit). Continue with path selector :425.]`,
			),
		).toBe(true);
	});

	it("normalizes CRLF to LF unless the read is raw", async () => {
		const source = "a\r\nb\r\nc\r\n";
		expect(await readFixture("crlf.txt", source)).toBe("a\nb\nc");
		expect(await readFixture("crlf.txt", source, "crlf.txt:2")).toBe("b\nc");
		expect(await readFixture("crlf.txt", "a\r\n\r\n")).toBe("a\n");
		expect(await readFixture("crlf.txt", source, "crlf.txt:raw")).toBe(source);
		expect(await readFixture("crlf.txt", source, "crlf.txt:4")).toBe(
			"Requested line 4 is beyond end of file (3 lines total). Use crlf.txt:3 to read the final line.",
		);
	});
});

const FORTY_LINES = `${Array.from({ length: 40 }, (_, index) => `row${index + 1}`).join("\n")}\n`;
const rows = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, index) => `row${from + index}`).join("\n");

describe("range selections label their lines (#4328)", () => {
	it("labels each range of a discontiguous selection and continues after the last one", async () => {
		expect(await readFixture("big.txt", FORTY_LINES, "big.txt:10-11,30-31")).toBe(
			`[Lines 9-14 of 40]\n${rows(9, 14)}\n[Lines 29-34 of 40]\n${rows(29, 34)}\n\n[6 more lines in file. Continue with path selector :35.]`,
		);
	});

	it("merges adjacent and overlapping ranges under one label", async () => {
		expect(await readFixture("big.txt", FORTY_LINES, "big.txt:10-11,12-13")).toBe(
			`[Lines 9-16 of 40]\n${rows(9, 16)}\n\n[24 more lines in file. Continue with path selector :17.]`,
		);
		expect(await readFixture("big.txt", FORTY_LINES, "big.txt:10-10,15-15")).toBe(
			`[Lines 9-18 of 40]\n${rows(9, 18)}\n\n[22 more lines in file. Continue with path selector :19.]`,
		);
	});

	it("labels a gap of a single line", async () => {
		expect(await readFixture("big.txt", FORTY_LINES, "big.txt:10-10,16-16")).toBe(
			`[Lines 9-13 of 40]\n${rows(9, 13)}\n[Lines 15-19 of 40]\n${rows(15, 19)}\n\n[21 more lines in file. Continue with path selector :20.]`,
		);
	});

	it("labels ranges near the end and stops the hint at the last line", async () => {
		expect(await readFixture("big.txt", FORTY_LINES, "big.txt:36-36")).toBe(
			`[Lines 35-39 of 40]\n${rows(35, 39)}\n\n[1 more lines in file. Continue with path selector :40.]`,
		);
		expect(await readFixture("big.txt", FORTY_LINES, "big.txt:38-39")).toBe(`[Lines 37-40 of 40]\n${rows(37, 40)}`);
	});

	it("keeps raw multi-range reads to the exact lines, unlabelled", async () => {
		expect(await readFixture("big.txt", FORTY_LINES, "big.txt:10-11,30-31:raw")).toBe("row10\nrow11\nrow30\nrow31");
	});

	it("continues a truncated selection after the last line shown", async () => {
		const huge = `${Array.from({ length: 6000 }, (_, index) => `L${index + 1}`).join("\n")}\n`;
		const output = await readFixture("huge.txt", huge, "huge.txt:1-2000,4000-5000");
		expect(output.startsWith("[Lines 1-2003 of 6000]\nL1\n")).toBe(true);
		expect(output).toContain("\nL2003\n[Lines 3999-4995 of 6000]\nL3999\n");
		expect(output.endsWith("\nL4995\n\n[Showing lines 1-4995 of 6000. Continue with path selector :4996.]")).toBe(
			true,
		);
	});
});
