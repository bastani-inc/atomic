import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWorktrees as cleanupWorkflow, createWorktrees as createWorkflow } from "../../packages/workflows/src/runs/shared/worktree-setup.js";
import { diffWorktrees } from "../../packages/workflows/src/runs/shared/worktree-diff.js";
import { cleanupWorktrees as cleanupSubagent, createWorktrees as createSubagent } from "../../packages/subagents/src/runs/shared/worktree.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";

type Setup = ReturnType<typeof createWorkflow>;
const lifecycles = [
  ["workflows", createWorkflow, cleanupWorkflow],
  ["subagents", createSubagent, cleanupSubagent],
] as const;

function repoFixture(): { root: string; main: string; linkedNested: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-life-")));
  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(join(main, "packages", "api"), { recursive: true });
  mkdirSync(join(main, ".husky"));
  runGitChecked(main, ["init", "-b", "main"]);
  writeFileSync(join(main, ".gitignore"), "local-only/\nincluded.env\nnode_modules/\n");
  writeFileSync(join(main, ".worktreeinclude"), "included.env\n");
  writeFileSync(join(main, ".husky", "pre-commit"), "#!/bin/sh\n");
  writeFileSync(join(main, "packages", "api", "tracked.txt"), "tracked\n");
  runGitChecked(main, ["add", "."]);
  runGitChecked(main, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "init"]);
  mkdirSync(join(main, ".atomic"), { recursive: true });
  mkdirSync(join(main, "local-only"));
  writeFileSync(join(main, ".atomic", "settings.local.json"), "{\"local\":true}\n");
  writeFileSync(join(main, ".atomic", "settings.json"), "{\"project\":true}\n");
  writeFileSync(join(main, "local-only", "cache.txt"), "cache\n");
  writeFileSync(join(main, "included.env"), "SECRET=fixture\n");
  runGitChecked(main, ["worktree", "add", "--detach", linked]);
  return { root, main, linkedNested: join(linked, "packages", "api") };
}

for (const [name, create, cleanup] of lifecycles) {
  describe(`${name} Claude-compatible temporary lifecycle`, () => {
    test("anchors at main root, uses -B branch naming, propagates setup, and cleans idempotently", () => {
      const fixture = repoFixture();
      let setup: Setup | undefined;
      try {
        setup = create(fixture.linkedNested, "feature/demo", 1, { symlinkDirectories: ["local-only"] });
        const worktree = setup.worktrees[0]!;
        const expected = join(fixture.main, ".atomic", "worktrees", "atomic-worktree-feature+demo-0");
        assert.equal(setup.cwd, fixture.main);
        assert.equal(worktree.path, expected);
        assert.equal(worktree.agentCwd, join(expected, "packages", "api"));
        assert.equal(worktree.branch, "worktree-atomic-worktree-feature+demo-0");
        assert.match(runGitChecked(fixture.main, ["branch", "--list", worktree.branch]), /worktree-atomic-worktree-feature\+demo-0/);
        assert.equal(readFileSync(join(fixture.main, ".atomic", "worktrees", ".gitignore"), "utf8"), "*\n");
        assert.equal(readFileSync(join(expected, ".atomic", "settings.local.json"), "utf8"), "{\"local\":true}\n");
        assert.equal(readFileSync(join(expected, ".atomic", "settings.json"), "utf8"), "{\"project\":true}\n");
        assert.equal(readFileSync(join(expected, "included.env"), "utf8"), "SECRET=fixture\n");
        assert.equal(lstatSync(join(expected, "local-only")).isSymbolicLink(), true);
        assert.equal(runGitChecked(fixture.main, ["config", "--local", "--get", "core.hooksPath"]).trim(), join(fixture.main, ".husky"));
        cleanup(setup);
        cleanup(setup);
        assert.equal(existsSync(expected), false);
        assert.equal(runGitChecked(fixture.main, ["branch", "--list", worktree.branch]).trim(), "");
      } finally {
        if (setup) cleanup(setup);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  });
}

test("explicit temporary baseBranch wins and -B resets a stale runner branch", () => {
  const fixture = repoFixture();
  const branch = "worktree-atomic-worktree-explicit-0";
  let setup: Setup | undefined;
  try {
    writeFileSync(join(fixture.main, "second.txt"), "second\n");
    runGitChecked(fixture.main, ["add", "."]);
    runGitChecked(fixture.main, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "second"]);
    runGitChecked(fixture.main, ["branch", branch, "HEAD"]);
    setup = createWorkflow(fixture.main, "explicit", 1, { baseBranch: "HEAD~1" });
    assert.equal(runGitChecked(setup.worktrees[0]!.path, ["rev-parse", "HEAD"]).trim(), runGitChecked(fixture.main, ["rev-parse", "HEAD~1"]).trim());
    const diffs = diffWorktrees(setup, ["writer"], join(fixture.root, "diffs"));
    assert.equal(diffs[0]!.filesChanged, 0);
    assert.equal(readFileSync(diffs[0]!.patchPath, "utf8"), "");
  } finally {
    if (setup) cleanupWorkflow(setup);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("temporary creation fetches a missing origin default branch before falling back to HEAD", () => {
  const fixture = repoFixture();
  const remote = join(fixture.root, "remote.git");
  let setup: Setup | undefined;
  try {
    mkdirSync(remote);
    runGitChecked(remote, ["init", "--bare", "--initial-branch=develop"]);
    runGitChecked(fixture.main, ["remote", "add", "origin", remote]);
    runGitChecked(fixture.main, ["push", "origin", "main:develop"]);
    const originCommit = runGitChecked(fixture.main, ["rev-parse", "origin/develop"]).trim();
    writeFileSync(join(fixture.main, "unpushed.txt"), "local\n");
    runGitChecked(fixture.main, ["add", "."]);
    runGitChecked(fixture.main, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "unpushed"]);
    runGitChecked(fixture.main, ["update-ref", "-d", "refs/remotes/origin/develop"]);

    setup = createWorkflow(fixture.main, "origin-default", 1);
    assert.equal(runGitChecked(setup.worktrees[0]!.path, ["rev-parse", "HEAD"]).trim(), originCommit);
    assert.equal(runGitChecked(fixture.main, ["rev-parse", "origin/develop"]).trim(), originCommit);
  } finally {
    if (setup) cleanupWorkflow(setup);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
