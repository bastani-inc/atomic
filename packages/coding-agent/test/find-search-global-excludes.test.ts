import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;

let tempRoot: string;
let repo: string;
let originalCwd: string;
let originalEnv: Map<string, string | undefined>;

beforeEach(() => {
	originalCwd = process.cwd();
	originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "global-excludes-")));
	const home = join(tempRoot, "home");
	mkdirSync(home);
	writeFileSync(join(home, "global-excludes"), "deep/**/x.log\nfoo/**\n");
	const excludesPath = join(home, "global-excludes").replaceAll("\\", "/");
	writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${excludesPath}\n`);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.XDG_CONFIG_HOME = join(home, ".config");

	repo = join(tempRoot, "repo");
	mkdirSync(join(repo, "deep", "sub"), { recursive: true });
	mkdirSync(join(repo, "foo"));
	mkdirSync(join(repo, ".git"));
	for (const file of ["deep/x.log", "deep/sub/x.log", "foo/t.txt", "top.txt"]) {
		writeFileSync(join(repo, file), "needle\n");
	}
	process.chdir(repo);
});

afterEach(() => {
	process.chdir(originalCwd);
	for (const [key, value] of originalEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(tempRoot, { recursive: true, force: true });
});

async function findFiles(cwd: string): Promise<string[]> {
	const result = await createFindTool(cwd).execute("find", { paths: ["**/*"] });
	const details = result.details as { files?: string[] } | undefined;
	return [...(details?.files ?? [])].filter((file) => !file.endsWith("/")).sort();
}

async function searchFiles(cwd: string): Promise<string[]> {
	const result = await createSearchToolDefinition(cwd, { contextBefore: 0, contextAfter: 0 }).execute("search", {
		pattern: "needle",
		paths: ["."],
	});
	const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
	return text
		.split("\n")
		.filter((line) => line.endsWith(": needle"))
		.map((line) => line.slice(0, line.indexOf(":")))
		.sort();
}

describe("global git excludes with a slash apply from the repository root (#5068)", () => {
	it("find applies foo/** and deep/**/x.log from the repository root (#5068)", async () => {
		assert.deepEqual(await findFiles(repo), ["top.txt"]);
	});

	it("search applies foo/** and deep/**/x.log from the repository root (#5068)", async () => {
		assert.deepEqual(await searchFiles(repo), ["top.txt"]);
	});

	it("find applies foo/** and deep/**/x.log through a symlinked repository root (#5068)", async () => {
		const link = join(tempRoot, "link");
		symlinkSync(repo, link, "junction");
		assert.deepEqual(await findFiles(link), ["top.txt"]);
	});

	it("search applies foo/** and deep/**/x.log through a symlinked repository root (#5068)", async () => {
		const link = join(tempRoot, "link");
		symlinkSync(repo, link, "junction");
		assert.deepEqual(await searchFiles(link), ["top.txt"]);
	});
});
