import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");

// Built from parts so this file does not match its own patterns.
const RETIRED_EDITOR = ["hash", "line"].join("");
const RETIRED_SNAPSHOT_HEADER = ["#", "TAG"].join("");
const RETIRED_INTERCEPTOR = ["bash", "[-_ ]?", "interceptor"].join("");
const OUTSIDE_CHANGELOGS = [".", ":(exclude,glob)**/CHANGELOG.md"];

function gitGrep(flags: string[], pattern: string): string[] {
	try {
		return execFileSync(
			"git",
			["-C", repoRoot, "grep", "--untracked", "-I", "-n", ...flags, "-e", pattern, "--", ...OUTSIDE_CHANGELOGS],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		)
			.trim()
			.split("\n");
	} catch (error) {
		if ((error as { status?: number }).status === 1) return [];
		throw error;
	}
}

describe("retired edit machinery stays removed (#4328)", () => {
	test("no file outside a CHANGELOG mentions the retired editor, its snapshot header or the shell command interceptor", () => {
		const references = [
			...gitGrep(["-i", "-E"], RETIRED_EDITOR),
			...gitGrep(["-i", "-E"], RETIRED_INTERCEPTOR),
			...gitGrep(["-F"], RETIRED_SNAPSHOT_HEADER),
		];
		assert.deepEqual(references, []);
	});

	test("no tracked path is named after them", () => {
		const paths = execFileSync("git", ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard"], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		})
			.trim()
			.split("\n");
		const named = paths.filter(
			(path) =>
				existsSync(join(repoRoot, path)) && new RegExp(`${RETIRED_EDITOR}|${RETIRED_INTERCEPTOR}`, "i").test(path),
		);
		assert.deepEqual(named, []);
	});
});
