import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { createGrepTool, type GrepToolOptions } from "../src/core/tools/grep.ts";

const cwd = mkdtempSync(join(tmpdir(), "atomic-grep-4903-"));
writeFileSync(join(cwd, "long.txt"), `${"x".repeat(600)}NEEDLE\n`);
writeFileSync(join(cwd, "crlf.txt"), "alpha\r\nbeta\r\n");
writeFileSync(join(cwd, "lf.txt"), "alpha\nbeta\n");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

// Custom operations force the ripgrep path; the default tool uses the native search when it is built.
const variants: ReadonlyArray<{ name: string; options: GrepToolOptions | undefined }> = [
	{ name: "ripgrep", options: { operations: { isDirectory: (path) => statSync(path).isDirectory() } } },
	{ name: "default", options: undefined },
];

async function grepText(options: GrepToolOptions | undefined, args: { pattern: string; path?: string }) {
	const result = await createGrepTool(cwd, options).execute("grep-4903", args);
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

describe.each(variants)("grep $name search", ({ options }) => {
	test("shows a match past the line length limit in its result line (#4903)", async () => {
		const output = await grepText(options, { pattern: "NEEDLE", path: "long.txt" });
		const resultLine = output.split("\n")[0];

		assert.match(resultLine, /^long\.txt:1: /);
		assert.ok(resultLine.includes("NEEDLE"), resultLine);
		assert.ok(resultLine.length < 600, `result line was not truncated: ${resultLine.length} chars`);
	});

	test.each(["a$", "^beta$"])("matches %s in a CRLF file and shows lines without CR (#4903)", async (pattern) => {
		const crlf = await grepText(options, { pattern, path: "crlf.txt" });
		const lf = await grepText(options, { pattern, path: "lf.txt" });

		assert.equal(crlf, pattern === "a$" ? "crlf.txt:1: alpha\ncrlf.txt:2: beta" : "crlf.txt:2: beta");
		assert.equal(lf, crlf.replaceAll("crlf.txt", "lf.txt"));
	});
});
