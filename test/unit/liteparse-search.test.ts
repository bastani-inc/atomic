import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const search = resolve(moduleDir(import.meta.url), "../../packages/subagents/skills/liteparse/scripts/search.py");

/** A Python 3.11+ interpreter, the oldest with the asyncio.TaskGroup the helper uses, or undefined when none is installed. */
function findPython(): string | undefined {
	for (const candidate of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
		const probe = spawnSync(
			candidate,
			["-c", "import sys; print(sys.executable); sys.exit(sys.version_info < (3, 11))"],
			{ encoding: "utf8" },
		);
		if (probe.status === 0) return probe.stdout.trim();
	}
	return undefined;
}

const python = findPython();

// Stand-ins for the helper's two dependencies, so it runs without installing them: a ranker that scores a line by the
// share of the query's words it contains and, as bm25s does, refuses to return more lines than it was given, and
// aiofiles' open() over the built-in one.
const FAKE_BM25S = `
import re

class Rows(list):
    def tolist(self):
        return list(self)

def tokenize(texts):
    words = lambda text: re.findall(r"\\w+", text.lower())
    return words(texts) if isinstance(texts, str) else [words(text) for text in texts]

class BM25:
    def __init__(self, corpus):
        self.corpus = corpus

    def index(self, tokens):
        self.tokens = tokens

    def retrieve(self, query, k):
        if k > len(self.tokens):
            raise ValueError(f"k of {k} is larger than the number of available scores, which is {len(self.tokens)}")
        scored = sorted(
            ((sum(word in line for word in query) / len(query), i) for i, line in enumerate(self.tokens)),
            key=lambda item: (-item[0], item[1]),
        )[:k]
        return [Rows(self.corpus[i] for _, i in scored)], [Rows(score for score, _ in scored)]
`;
const FAKE_AIOFILES = `
import builtins

class File:
    def __init__(self, path, mode):
        self.file = builtins.open(path, mode)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.file.close()

    async def read(self, size=-1):
        return self.file.read(size)

def open(path, mode="r"):
    return File(path, mode)
`;

// Outside Windows' ANSI code page.
const WIDE = "\u2713 \u65e5\u672c";
const SEPARATOR = `\n${"\u2500".repeat(60)}\n`;
// The helper reads a document in blocks of this many bytes.
const BLOCK = 65536;

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) removeTempDirectory(folder);
});

/** A folder holding `document` and the stand-in modules. */
function setUp(document: string): { dir: string; document: string } {
	const dir = makeTempDirectory("liteparse-search-");
	folders.push(dir);
	const modules = join(dir, "modules");
	mkdirSync(modules);
	writeFileSync(join(modules, "bm25s.py"), FAKE_BM25S);
	writeFileSync(join(modules, "aiofiles.py"), FAKE_AIOFILES);
	writeFileSync(join(dir, "doc.txt"), document);
	return { dir, document: join(dir, "doc.txt") };
}

function runSearch(dir: string, args: readonly string[], encoding = "utf-8") {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("PYTHON")) env[key] = value;
	}
	const result = spawnSyncCollect([python ?? "python3", search, ...args], {
		cwd: dir,
		// Python before 3.15 writes to a pipe in the locale's encoding, which on Windows is the ANSI code page,
		// such as cp1252.
		env: { ...env, PYTHONPATH: join(dir, "modules"), PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: encoding },
	});
	// A decoder that fails on anything but UTF-8. Windows ends lines with CRLF.
	const decode = (bytes: Uint8Array) =>
		new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
	return {
		exitCode: result.exitCode,
		stdout: decode(result.stdout),
		stderr: result.stderr.toString(),
		stderrBytes: result.stderr,
	};
}

/** `count` lines of filler, 100 bytes each with its line ending. */
function filler(count: number, from = 0): string[] {
	return Array.from({ length: count }, (_, i) => `filler line ${String(from + i).padStart(5, "0")} `.padEnd(99, "."));
}

describe.skipIf(python === undefined)("liteparse's search helper", () => {
	test("writes its matches as UTF-8 to a pipe in Windows' ANSI code page", () => {
		const lines = filler(20);
		lines[3] = `zebra quantum ${WIDE}`;
		lines[15] = "zebra quantum again";
		const { dir, document } = setUp(`${lines.join("\n")}\n`);
		const result = runSearch(dir, [document, "-q", "zebra quantum", "-e", "1"], "cp1252");
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(
			result.stdout,
			[
				"Match #0",
				`Lines 2 - 4\n\n\n${lines[2]}\n${lines[3]}\n${lines[4]}`,
				SEPARATOR,
				"Match #1",
				`Lines 14 - 16\n\n\n${lines[14]}\n${lines[15]}\n${lines[16]}`,
				"",
			].join("\n"),
		);
	});

	test("finds matches in a document whose blocks split a character in two", () => {
		// 655 lines of 100 bytes, then 35 more bytes: the 3-byte em dash starts one byte before the first block ends.
		const head = `${filler(655).join("\n")}\n${"x".repeat(35)}`;
		assert.equal(Buffer.byteLength(head), BLOCK - 1);
		const { dir, document } = setUp(`${head}\u2014 zebra quantum\nzebra quantum again\n`);
		const result = runSearch(dir, [document, "-q", "zebra quantum", "-e", "1"]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.ok(result.stdout.includes(`${"x".repeat(35)}\u2014 zebra quantum\nzebra quantum again`), result.stdout);
	});

	test("numbers a match past the document's first block by its line in the whole document", () => {
		const lines = filler(1500);
		lines[1200] = "zebra quantum";
		const { dir, document } = setUp(`${lines.join("\n")}\n`);
		const result = runSearch(dir, [document, "-q", "zebra quantum", "-k", "1", "-e", "2"]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.stdout, `Match #0\nLines 1198 - 1202\n\n\n${lines.slice(1198, 1203).join("\n")}\n`);
	});

	test("counts a page break as a line past the document's first block, as it does within it", () => {
		const lines = filler(1500);
		// A form feed ends a line too: "page 1\f" is two lines, "page 1" and an empty one.
		lines[10] = "page 1\f";
		lines[1200] = "zebra quantum";
		const { dir, document } = setUp(`${lines.join("\n")}\n`);
		const result = runSearch(dir, [document, "-q", "zebra quantum", "-k", "1", "-e", "2"]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.stdout, `Match #0\nLines 1199 - 1203\n\n\n${lines.slice(1198, 1203).join("\n")}\n`);
		const near = runSearch(dir, [document, "-q", "page", "-k", "1", "-e", "1"]);
		// The window ends with that empty line, which the helper trims as it prints.
		assert.equal(near.stdout, `Match #0\nLines 9 - 11\n\n\n${lines[9]}\npage 1\n`);
	});

	test("shows a line longer than a block whole, and numbers the lines after it in the whole document", () => {
		const lines = filler(10);
		const long = "y".repeat(2 * BLOCK);
		lines.push(long, "zebra quantum", ...filler(10, 12));
		const { dir, document } = setUp(`${lines.join("\n")}\n`);
		const result = runSearch(dir, [document, "-q", "zebra quantum", "-k", "1", "-e", "1"]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.stdout, `Match #0\nLines 10 - 12\n\n\n${long}\nzebra quantum\n${lines[12]}\n`);
	});

	test("names a document it cannot find in UTF-8 on standard error in Windows' ANSI code page", () => {
		const { dir } = setUp("");
		const missing = join(dir, `missing ${WIDE}.txt`);
		const result = runSearch(dir, [missing, "-q", "zebra"], "cp1252");
		assert.equal(result.exitCode, 1);
		// The error quotes the path as Python writes a string, with a Windows path's backslashes doubled: look for its name.
		const stderr = new TextDecoder("utf-8", { fatal: true }).decode(result.stderrBytes);
		assert.ok(stderr.includes(`missing ${WIDE}.txt`), stderr);
	});

	test("searches a document with fewer lines than the matches asked for", () => {
		const { dir, document } = setUp("zebra quantum\nfiller\nzebra again\n");
		const result = runSearch(dir, [document, "-q", "zebra quantum", "-e", "1"]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(
			result.stdout,
			`Match #0\nLines 0 - 1\n\n\nzebra quantum\nfiller\n${SEPARATOR}\nMatch #1\nLines 1 - 2\n\n\nfiller\nzebra again\n`,
		);
	});

	test("returns every match asked for in a document with exactly as many lines", () => {
		const { dir, document } = setUp("zebra quantum one\nzebra quantum two\nzebra quantum three\n");
		const result = runSearch(dir, [document, "-q", "zebra quantum", "-k", "3", "-e", "1"]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(
			result.stdout,
			[
				"Match #0",
				"Lines 0 - 1\n\n\nzebra quantum one\nzebra quantum two",
				SEPARATOR,
				"Match #1",
				"Lines 0 - 2\n\n\nzebra quantum one\nzebra quantum two\nzebra quantum three",
				SEPARATOR,
				"Match #2",
				"Lines 1 - 2\n\n\nzebra quantum two\nzebra quantum three",
				"",
			].join("\n"),
		);
	});

	test("searches a document of one block as one part, its last line ending without a line break", () => {
		const lines = filler(10);
		lines[9] = "zebra quantum";
		const { dir, document } = setUp(lines.join("\n"));
		const result = runSearch(dir, [document, "-q", "zebra quantum"]);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.stdout, `Match #0\nLines 4 - 9\n\n\n${lines.slice(4).join("\n")}\n`);
	});
});
