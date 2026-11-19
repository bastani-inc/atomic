import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { bunExecutable } from "../helpers/runtime.js";

function cli(script: string, args: string[], cwd = process.cwd()) {
	const r = spawnSync(bunExecutable(), [resolve(script), ...args, "--dry-run"], {
		cwd,
		env: createGitEnvironment(),
		encoding: "utf8",
	});
	assert.ok(!r.error && r.stdout, r.stderr || String(r.error));
	return { exit: r.status, json: JSON.parse(r.stdout) };
}

test("both repository release skills name executable scripts and valid subcommands", () => {
	for (const name of ["publish-release", "release-docs"]) {
		const skill = readFileSync(`.agents/skills/${name}/SKILL.md`, "utf8");
		const invoked = [...skill.matchAll(/bun run (scripts\/[\w./-]+\.ts)(?: ([a-z][\w-]*))?/g)];
		assert.ok(invoked.length, `No script invocations in ${name}`);
		for (const [_, path, command] of invoked) {
			assert.ok(existsSync(path), `Missing ${path} in ${name}`);
			if (path.startsWith("scripts/release/")) {
				assert.ok(command, `Missing subcommand of ${path}`);
				assert.equal(cli(path, [command, "--help"]).exit, 0, `${path} ${command}`);
			}
		}
	}
});

test("release diff gate distinguishes passed, blocked and invalid input, including a hidden index change", () => {
	const root = mkdtempSync(join(tmpdir(), "release-cli-"));
	const repo = join(root, "repo");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, env: createGitEnvironment(), stdio: "pipe" });
	const script = "scripts/release/publish-release.ts";
	const gate = () => cli(script, ["check-changelog-diff", "--base", "main"], repo);
	try {
		mkdirSync(join(repo, "packages/coding-agent"), { recursive: true });
		git("init", "-b", "main");
		writeFileSync(join(repo, "packages/coding-agent/package.json"), '{"version":"0.0.0"}');
		writeFileSync(join(repo, "keep.txt"), "original");
		git("add", ".");
		git(
			"-c",
			"user.name=Atomic Test",
			"-c",
			"user.email=test@example.com",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--no-gpg-sign",
			"-m",
			"versionless base",
		);
		git("clone", "--bare", repo, join(root, "origin.git"));
		git("remote", "add", "origin", join(root, "origin.git"));
		const empty = gate();
		assert.equal(empty.exit, 2);
		assert.equal(empty.json.status, "blocked");
		writeFileSync(join(repo, "packages/coding-agent/CHANGELOG.md"), "release notes");
		const notes = gate();
		assert.equal(notes.exit, 0);
		assert.deepEqual(notes.json.changedFiles, ["packages/coding-agent/CHANGELOG.md"]);
		writeFileSync(join(repo, "keep.txt"), "staged change");
		git("add", "keep.txt");
		writeFileSync(join(repo, "keep.txt"), "original");
		const hidden = gate();
		assert.equal(hidden.exit, 2);
		assert.match(hidden.json.summary, /keep\.txt/u);
		const invalid = cli(script, ["validate", "--version", "v1.0.0"], repo);
		assert.equal(invalid.exit, 1);
		assert.equal(invalid.json.status, "error");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
