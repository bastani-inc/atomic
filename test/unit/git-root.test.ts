import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot as findWorkflowRoot, resolveMainRepoRoot as resolveWorkflowRoot } from "../../packages/workflows/src/runs/shared/worktree-root.js";
import { findGitRoot as findSubagentRoot, resolveMainRepoRoot as resolveSubagentRoot } from "../../packages/subagents/src/runs/shared/worktree-root.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";

const implementations = [
  ["workflows", findWorkflowRoot, resolveWorkflowRoot],
  ["subagents", findSubagentRoot, resolveSubagentRoot],
] as const;

for (const [name, findRoot, resolveRoot] of implementations) {
  describe(`${name} filesystem-only Git root resolution`, () => {
    test("handles main roots, nested directories, cwd files, and real linked-worktree pointers", () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-root-")));
      const main = join(root, "main");
      const linked = join(root, "linked");
      const alias = join(root, "nested-alias");
      try {
        mkdirSync(join(main, "nested"), { recursive: true });
        runGitChecked(main, ["init", "-b", "main"]);
        writeFileSync(join(main, "nested", "file.txt"), "x");
        runGitChecked(main, ["add", "."]);
        runGitChecked(main, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "init"]);
        runGitChecked(main, ["worktree", "add", "--detach", linked]);
        symlinkSync(join(main, "nested"), alias, process.platform === "win32" ? "junction" : "dir");
        assert.equal(findRoot(join(main, "nested", "file.txt")), main);
        assert.equal(findRoot(alias), main);
        assert.equal(resolveRoot(main), main);
        assert.equal(findRoot(linked), linked);
        assert.equal(resolveRoot(linked), main);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test("rejects missing-prefix, empty, non-worktrees, and nested metadata pointers without throwing", () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-root-bad-")));
      const linked = join(root, "linked");
      try {
        mkdirSync(linked);
        writeFileSync(join(linked, ".git"), "bad\n");
        assert.equal(resolveRoot(linked), undefined);
        writeFileSync(join(linked, ".git"), "gitdir:   \n");
        assert.equal(resolveRoot(linked), undefined);
        const bad = join(root, "main", ".git", "linked", "entry");
        mkdirSync(bad, { recursive: true });
        writeFileSync(join(linked, ".git"), `gitdir: ${bad}\n`);
        assert.equal(resolveRoot(linked), undefined);
        const nested = join(root, "main", ".git", "worktrees", "outer", "inner");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(linked, ".git"), `gitdir: ${nested}\n`);
        assert.equal(resolveRoot(linked), undefined);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test("rejects a pointer to another repository's real worktree admin directory", () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-root-foreign-")));
      const foreign = join(root, "foreign");
      const foreignLinked = join(root, "foreign-linked");
      const crafted = join(root, "crafted");
      try {
        mkdirSync(foreign);
        runGitChecked(foreign, ["init", "-b", "main"]);
        writeFileSync(join(foreign, "tracked.txt"), "x\n");
        runGitChecked(foreign, ["add", "."]);
        runGitChecked(foreign, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", "init"]);
        runGitChecked(foreign, ["worktree", "add", "--detach", foreignLinked]);
        mkdirSync(crafted);
        writeFileSync(join(crafted, ".git"), readFileSync(join(foreignLinked, ".git"), "utf8"));
        assert.equal(resolveRoot(crafted), undefined);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });
}
