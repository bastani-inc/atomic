import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { resolveReadPath, resolveToCwd } from "../src/core/tools/path-utils.ts";
import { createEditTool, createReadTool, createWriteTool } from "../src/index.ts";

const NBSP_NAME = "a\u00A0b.txt";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

describe("tool paths prefer the literal path (#4841)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tool-paths-literal-first-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reads an existing @types/... file instead of stripping the @ (#4841)", async () => {
		mkdirSync(join(cwd, "@types"));
		writeFileSync(join(cwd, "@types", "a.d.ts"), "declare const scoped: 1;\n");
		mkdirSync(join(cwd, "types"));
		writeFileSync(join(cwd, "types", "a.d.ts"), "declare const unscoped: 1;\n");

		assert.equal(resolveReadPath("@types/a.d.ts", cwd), join(cwd, "@types", "a.d.ts"));
		const result = await createReadTool(cwd).execute("read-types", { path: "@types/a.d.ts" });
		assert.match(textOf(result), /scoped: 1/);
		assert.doesNotMatch(textOf(result), /unscoped/);
	});

	it("reads an existing @scope/pkg workspace file (#4841)", async () => {
		mkdirSync(join(cwd, "@scope", "pkg"), { recursive: true });
		writeFileSync(join(cwd, "@scope", "pkg", "package.json"), '{"name":"@scope/pkg"}\n');

		const result = await createReadTool(cwd).execute("read-scope", { path: "@scope/pkg/package.json" });
		assert.match(textOf(result), /"name":"@scope\/pkg"/);
	});

	it("still strips an @-mention prefix when the literal path is absent (#4841)", async () => {
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "main.ts"), "export const main = 1;\n");

		assert.equal(resolveToCwd("@src/main.ts", cwd), join(cwd, "src", "main.ts"));
		const read = await createReadTool(cwd).execute("read-mention", { path: "@src/main.ts" });
		assert.match(textOf(read), /main = 1/);

		await createEditTool(cwd).execute("edit-mention", {
			path: "@src/main.ts",
			edits: [{ oldText: "main = 1", newText: "main = 2" }],
		});
		assert.equal(readFileSync(join(cwd, "src", "main.ts"), "utf-8"), "export const main = 2;\n");
		assert.equal(existsSync(join(cwd, "@src")), false);

		await createWriteTool(cwd).execute("write-mention", { path: "@src/new.ts", content: "new\n" });
		assert.equal(readFileSync(join(cwd, "src", "new.ts"), "utf-8"), "new\n");
		assert.equal(existsSync(join(cwd, "@src")), false);
	});

	it("still resolves a macOS screenshot name behind an @-mention (#4841)", async () => {
		const screenshot = join(cwd, "Screenshot 2024-01-01 at 10.00.00\u202FAM.txt");
		writeFileSync(screenshot, "screenshot notes\n");

		assert.equal(resolveReadPath("@Screenshot 2024-01-01 at 10.00.00 AM.txt", cwd), screenshot);
		const read = await createReadTool(cwd).execute("read-screenshot", {
			path: "@Screenshot 2024-01-01 at 10.00.00 AM.txt",
		});
		assert.match(textOf(read), /screenshot notes/);
	});

	it("still resolves decomposed and curly-quote macOS names behind an @-mention (#4841)", () => {
		writeFileSync(join(cwd, "file\u0065\u0301.txt"), "nfd");
		writeFileSync(join(cwd, "Capture d\u2019\u0065\u0301cran.txt"), "nfd curly");
		writeFileSync(join(cwd, "l'\u0065\u0301te\u0301.txt"), "nfd straight quote");

		for (const [input, expected] of [
			["@file\u00e9.txt", "file\u00e9.txt"],
			["@Capture d'\u00e9cran.txt", "Capture d\u2019\u00e9cran.txt"],
			["@l'\u00e9t\u00e9.txt", "l'\u00e9t\u00e9.txt"],
		]) {
			const resolved = resolveReadPath(input, cwd);
			assert.equal(existsSync(resolved), true, input);
			assert.equal(resolved.normalize("NFC"), join(cwd, expected).normalize("NFC"));
		}
	});

	it("uses the ASCII-space file for a pasted Unicode space when the literal file is absent (#4841)", async () => {
		writeFileSync(join(cwd, "a b.txt"), "ascii\n");

		assert.equal(resolveToCwd(NBSP_NAME, cwd), join(cwd, "a b.txt"));
		const read = await createReadTool(cwd).execute("read-pasted-space", { path: NBSP_NAME });
		assert.match(textOf(read), /ascii/);
		assert.equal(existsSync(join(cwd, NBSP_NAME)), false);
	});

	it("reads, edits and writes a no-break-space file name without touching the ASCII-space file (#4841)", async () => {
		writeFileSync(join(cwd, NBSP_NAME), "nbsp original\n");
		writeFileSync(join(cwd, "a b.txt"), "ascii original\n");

		const read = await createReadTool(cwd).execute("read-nbsp", { path: NBSP_NAME });
		assert.match(textOf(read), /nbsp original/);

		await createEditTool(cwd).execute("edit-nbsp", {
			path: NBSP_NAME,
			edits: [{ oldText: "nbsp original", newText: "nbsp edited" }],
		});
		assert.equal(readFileSync(join(cwd, NBSP_NAME), "utf-8"), "nbsp edited\n");

		await createWriteTool(cwd).execute("write-nbsp", { path: NBSP_NAME, content: "nbsp written\n" });
		assert.equal(readFileSync(join(cwd, NBSP_NAME), "utf-8"), "nbsp written\n");
		assert.equal(readFileSync(join(cwd, "a b.txt"), "utf-8"), "ascii original\n");
	});

	it("creates a new no-break-space file in an existing directory under its literal name (#4841)", async () => {
		await createWriteTool(cwd).execute("write-new-nbsp", { path: NBSP_NAME, content: "fresh\n" });
		assert.equal(readFileSync(join(cwd, NBSP_NAME), "utf-8"), "fresh\n");
		assert.equal(existsSync(join(cwd, "a b.txt")), false);
	});

	it("falls back to the normalised directory only when the literal parent is missing (#4841)", () => {
		mkdirSync(join(cwd, "my dir"));
		assert.equal(resolveToCwd("my\u00A0dir/new.txt", cwd), join(cwd, "my dir", "new.txt"));
		assert.equal(resolveToCwd("@new.txt", cwd), join(cwd, "@new.txt"));
	});
});
