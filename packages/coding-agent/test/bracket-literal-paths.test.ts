import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.js";
import { splitPathLikeGlob } from "../src/core/tools/glob-path-utils.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

function textOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((item) => item.type === "text")
			.map((item) => item.text ?? "")
			.join("\n") ?? ""
	);
}

describe("paths with brackets (#5177)", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `atomic-bracket-paths-${process.pid}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(join(dir, "app", "[id]"), { recursive: true });
		mkdirSync(join(dir, "app", "i"), { recursive: true });
		writeFileSync(join(dir, "app", "[id]", "page.tsx"), "export const hello = 1;\n");
		writeFileSync(join(dir, "app", "i", "page.tsx"), "export const hello = 2;\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("search reads the literal file when a bracketed path exists (#5177)", async () => {
		const text = textOutput(
			await createSearchToolDefinition(dir).execute("search-literal", {
				pattern: "hello",
				paths: "app/[id]/page.tsx",
			}),
		);
		assert.match(text, /hello = 1/);
		assert.doesNotMatch(text, /hello = 2/);
	});

	it("search accepts a literal bracketed directory (#5177)", async () => {
		const text = textOutput(
			await createSearchToolDefinition(dir).execute("search-literal-dir", { pattern: "hello", paths: "app/[id]" }),
		);
		assert.match(text, /hello = 1/);
		assert.doesNotMatch(text, /hello = 2/);
	});

	it("find lists the literal file when a bracketed path exists (#5177)", async () => {
		const text = textOutput(
			await createFindToolDefinition(dir).execute("find-literal", { paths: ["app/[id]/page.tsx"] }),
		);
		assert.match(text, /\[id\]/);
		assert.doesNotMatch(text, /(^|\/)i\/page\.tsx/m);
	});

	it("find lists a literal bracketed directory's files (#5177)", async () => {
		const text = textOutput(await createFindToolDefinition(dir).execute("find-literal-dir", { paths: ["app/[id]"] }));
		assert.match(text, /page\.tsx/);
		assert.doesNotMatch(text, /hello/);
		assert.doesNotMatch(text, /(^|\/)i\//m);
	});

	it("a bracket glob still matches when no such literal path exists (#5177)", async () => {
		const text = textOutput(
			await createSearchToolDefinition(dir).execute("search-glob", { pattern: "hello", paths: "app/[ij]/page.tsx" }),
		);
		assert.match(text, /hello = 2/);
		assert.doesNotMatch(text, /hello = 1/);
		const found = textOutput(await createFindToolDefinition(dir).execute("find-glob", { paths: ["app/[ij]/*.tsx"] }));
		assert.match(found, /page\.tsx/);
		assert.doesNotMatch(found, /\[id\]/);
	});

	it.runIf(process.platform !== "win32")("an escaped bracket is literal (#5177)", async () => {
		assert.deepEqual(splitPathLikeGlob("app/\\[id\\]/page.tsx"), { basePath: "app/[id]/page.tsx" });
		assert.deepEqual(splitPathLikeGlob("app/\\[id\\]/*.tsx"), { basePath: "app/[id]", glob: "*.tsx" });
		assert.deepEqual(splitPathLikeGlob("app/*/\\[x\\].tsx"), { basePath: "app", glob: "*/\\[x\\].tsx" });
		const text = textOutput(
			await createSearchToolDefinition(dir).execute("search-escaped", {
				pattern: "hello",
				paths: "app/\\[id\\]/*.tsx",
			}),
		);
		assert.match(text, /hello = 1/);
		assert.doesNotMatch(text, /hello = 2/);
	});

	it("backslashes in drive and UNC paths stay separators (#5177)", () => {
		assert.deepEqual(splitPathLikeGlob("C:\\work\\**\\*.ts"), { basePath: "C:/work", glob: "**/*.ts" });
		assert.deepEqual(splitPathLikeGlob("\\\\server\\share\\dir\\*.ts"), {
			basePath: "//server/share/dir",
			glob: "*.ts",
		});
	});
});
