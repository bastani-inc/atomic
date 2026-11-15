import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { isPathInside } from "../src/utils/path-inside.js";

type Case = readonly [parent: string, child: string, inside: boolean];

const posixCases: readonly Case[] = [
	["/repo", "/repo", true],
	["/repo/", "/repo", true],
	["/repo", "/repo/a", true],
	["/repo", "/repo/a/b", true],
	["/repo", "/repo/..x", true],
	["/repo", "/repo/..cache", true],
	["/repo", "/repo/...", true],
	["/repo", "/repo/.x", true],
	["/repo", "/repo/a/..x/b", true],
	["/repo", "/repo/a/../b", true],
	["/repo", "/", false],
	["/repo", "/repo/..", false],
	["/repo", "/repo/../x", false],
	["/repo", "/repo/a/../..", false],
	["/repo", "/repo/a/../../..x", false],
	["/repo", "/repository", false],
	["/repo", "/other/repo", false],
	["/repo/a", "/repo", false],
];

const windowsCases: readonly Case[] = [
	["C:\\repo", "C:\\repo", true],
	["C:\\repo", "C:\\repo\\a", true],
	["C:\\repo", "C:\\repo\\..x", true],
	["C:\\repo", "C:\\repo\\..notes.md", true],
	["C:\\repo", "C:\\repo\\.x", true],
	["C:\\repo", "C:/repo/..x", true],
	["C:\\repo", "c:\\REPO\\a", true],
	["c:\\Repo", "C:\\repo\\..x", true],
	["C:\\repo", "C:\\", false],
	["C:\\repo", "C:\\repo\\..", false],
	["C:\\repo", "C:\\repo\\..\\x", false],
	["C:\\repo", "C:/repo/../x", false],
	["C:\\repo", "C:\\repo\\a\\..\\..", false],
	["C:\\repo", "C:\\repository", false],
	["C:\\repo", "D:\\repo", false],
	["C:\\repo", "D:\\repo\\a", false],
	["C:\\repo", "\\\\server\\share\\repo", false],
	["\\\\server\\share\\repo", "\\\\server\\share\\repo\\..x", true],
	["\\\\server\\share\\repo", "\\\\server\\share\\other", false],
];

describe("isPathInside (#4836)", () => {
	for (const [parent, child, inside] of posixCases) {
		test(`posix: ${child} is ${inside ? "inside" : "outside"} ${parent} (#4836)`, () => {
			assert.equal(isPathInside(parent, child, path.posix), inside);
		});
	}

	for (const [parent, child, inside] of windowsCases) {
		test(`win32: ${child} is ${inside ? "inside" : "outside"} ${parent} (#4836)`, () => {
			assert.equal(isPathInside(parent, child, path.win32), inside);
		});
	}

	test("a relative path API result written with forward slashes still counts as escaping on Windows (#4836)", () => {
		const forwardSlashes: Parameters<typeof isPathInside>[2] = {
			sep: "\\",
			relative: (from, to) => path.win32.relative(from, to).replaceAll("\\", "/"),
			isAbsolute: path.win32.isAbsolute,
		};
		assert.equal(isPathInside("C:\\repo", "C:\\x", forwardSlashes), false);
		assert.equal(isPathInside("C:\\repo", "C:\\repo\\..x", forwardSlashes), true);
	});

	test("an absolute relative() result is outside the parent (#4836)", () => {
		const crossRoot: Parameters<typeof isPathInside>[2] = {
			sep: "/",
			relative: () => "/elsewhere",
			isAbsolute: path.posix.isAbsolute,
		};
		assert.equal(isPathInside("/repo", "/elsewhere", crossRoot), false);
	});

	test("defaults to the host platform's path rules (#4836)", () => {
		const root = path.resolve("repo");
		assert.equal(isPathInside(root, path.join(root, "..x")), true);
		assert.equal(isPathInside(root, path.join(root, "..", "x")), false);
	});
});
