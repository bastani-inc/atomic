import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const checkerPath = join(repoRoot, "scripts/check-file-length.ts");

test("check-file-length fallback walk respects .gitignore", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "atomic-file-length-fallback-"));

  try {
    writeFileSync(join(fixtureRoot, ".gitignore"), "ignored/\n");
    mkdirSync(join(fixtureRoot, "ignored"));
    writeFileSync(join(fixtureRoot, "ignored/hidden.ts"), "one\ntwo\n");
    writeFileSync(join(fixtureRoot, "visible.ts"), "one\ntwo\n");

    const result = Bun.spawnSync({
      cmd: [process.execPath, checkerPath, "--max=1"],
      cwd: fixtureRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = result.stderr.toString();
    assert.equal(result.exitCode, 1);
    assert.match(stderr, /visible\.ts/);
    assert.doesNotMatch(stderr, /ignored\/hidden\.ts/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("check-file-length ignores tracked files deleted from the working tree", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "atomic-file-length-deleted-"));

  try {
    writeFileSync(join(fixtureRoot, "deleted.ts"), "one\ntwo\n");
    const gitEnv = createGitEnvironment();
    const init = Bun.spawnSync(["git", "init", "--quiet"], { cwd: fixtureRoot, env: gitEnv });
    assert.equal(init.exitCode, 0);
    const add = Bun.spawnSync(["git", "add", "deleted.ts"], { cwd: fixtureRoot, env: gitEnv });
    assert.equal(add.exitCode, 0);
    rmSync(join(fixtureRoot, "deleted.ts"));

    const result = Bun.spawnSync({
      cmd: [process.execPath, checkerPath, "--max=1"],
      cwd: fixtureRoot,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.doesNotMatch(result.stderr.toString(), /Unable to read/u);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
