import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllFiles } from "./file-discovery.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "file-discovery-test-"));
}

function cleanUp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Test 1: git rung — populated repo returns tracked files
// ---------------------------------------------------------------------------

// `Bun.which` with an explicit `PATH` reads the env at call time. The 1-arg
// form caches PATH at process startup and would miss a binary installed
// after the test process started. Same gotcha guarded against in
// `spawn.ts:hasUv` — see its docstring. Using `Bun.spawnSync` for the
// availability probe is wrong here: it throws synchronously with
// `Executable not found in $PATH` when the binary is missing, so the
// `success: false` skip branch never runs (this is the regression that
// caused the test to fail on CI runners without `rg` pre-installed).
function isOnPath(binary: string): boolean {
  return Boolean(Bun.which(binary, { PATH: process.env.PATH ?? "" }));
}

test("listAllFiles: git rung — populated repo returns tracked files", () => {
  if (!isOnPath("git")) {
    console.log("SKIP: git not available");
    return;
  }

  const root = makeTmpDir();
  try {
    // Init git repo
    Bun.spawnSync({ cmd: ["git", "init"], cwd: root, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "config", "user.email", "test@test.com"], cwd: root, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "config", "user.name", "Test"], cwd: root, stdout: "pipe", stderr: "pipe" });

    // Write and add files
    writeFileSync(join(root, "alpha.ts"), "export const a = 1;");
    writeFileSync(join(root, "beta.ts"), "export const b = 2;");
    Bun.spawnSync({ cmd: ["git", "add", "alpha.ts", "beta.ts"], cwd: root, stdout: "pipe", stderr: "pipe" });

    const files = listAllFiles(root);

    expect(files).toContain("alpha.ts");
    expect(files).toContain("beta.ts");
  } finally {
    cleanUp(root);
  }
});

// ---------------------------------------------------------------------------
// Test 2: rg rung activates when git unavailable
//
// Strategy: place a `git` shim script on a temp dir and prepend that dir to
// PATH so Bun.spawnSync finds it. The shim exits with code 1 (success:false)
// so the git branch falls through. rg is still reachable via its real PATH
// entry which we append after the fake-bin dir.
// ---------------------------------------------------------------------------

test("listAllFiles: rg rung activates when git fails", () => {
  if (!isOnPath("rg")) {
    console.log("SKIP: rg not available");
    return;
  }

  const fakeBinDir = makeTmpDir();
  const root = makeTmpDir();
  const savedPath = process.env.PATH;

  try {
    // Write a `git` shim that always exits 1 (binary present → no ENOENT, but success:false).
    const shimPath = join(fakeBinDir, "git");
    writeFileSync(shimPath, "#!/bin/sh\nexit 1\n");
    Bun.spawnSync({ cmd: ["chmod", "+x", shimPath] });

    // Build PATH with fake-bin first so our shim wins, real bins still accessible for rg.
    process.env.PATH = `${fakeBinDir}:${savedPath}`;

    // Create fixture files in root
    writeFileSync(join(root, "gamma.ts"), "export const g = 3;");
    writeFileSync(join(root, "delta.ts"), "export const d = 4;");

    const files = listAllFiles(root);

    // rg returns relative paths from cwd; assert we got the fixture files
    expect(files.some((f) => f.includes("gamma.ts"))).toBe(true);
    expect(files.some((f) => f.includes("delta.ts"))).toBe(true);
  } finally {
    process.env.PATH = savedPath;
    cleanUp(fakeBinDir);
    cleanUp(root);
  }
});

// ---------------------------------------------------------------------------
// Test 3: walker fallback when both binaries missing — never throws
// ---------------------------------------------------------------------------

test("listAllFiles: walker fallback when both binaries missing — never throws", () => {
  const root = makeTmpDir();
  const savedPath = process.env.PATH;

  try {
    writeFileSync(join(root, "epsilon.ts"), "export const e = 5;");
    writeFileSync(join(root, "zeta.ts"), "export const z = 6;");

    // Override PATH so both git and rg ENOENT in Bun.spawnSync.
    process.env.PATH = "/nonexistent-bin-dir-for-test";

    let files: string[] = [];
    expect(() => {
      files = listAllFiles(root);
    }).not.toThrow();

    // Walker should find the fixture files (no .gitignore excluding them)
    expect(files).toContain("epsilon.ts");
    expect(files).toContain("zeta.ts");
  } finally {
    process.env.PATH = savedPath;
    cleanUp(root);
  }
});

// ---------------------------------------------------------------------------
// Test 4: empty dir + missing binaries returns []
// ---------------------------------------------------------------------------

test("listAllFiles: empty dir + missing binaries returns []", () => {
  const root = makeTmpDir();
  const savedPath = process.env.PATH;

  try {
    // Override PATH so both git and rg ENOENT.
    process.env.PATH = "/nonexistent-bin-dir-for-test";

    let files: string[] = [];
    expect(() => {
      files = listAllFiles(root);
    }).not.toThrow();

    expect(files).toEqual([]);
  } finally {
    process.env.PATH = savedPath;
    cleanUp(root);
  }
});

// ---------------------------------------------------------------------------
// Test 5: env-scrub regression — GIT_DIR pointing at a foreign repo is ignored
//
// Without envForRoot() scrubbing GIT_DIR, `git ls-files` inherits the parent
// env and returns files from the *foreign* repo instead of `root`. This test
// proves the fix (commit e102f33e) holds.
// ---------------------------------------------------------------------------

describe("listAllFiles — env scrub regression", () => {
  test("GIT_DIR pointing at foreign repo does not pollute results", () => {
    if (!isOnPath("git")) {
      console.log("SKIP: git not available");
      return;
    }

    const repoA = makeTmpDir();   // target repo with known files
    const repoB = makeTmpDir();   // foreign repo — GIT_DIR will point here
    const savedGitDir = process.env.GIT_DIR;
    const savedGitWorkTree = process.env.GIT_WORK_TREE;

    try {
      // --- build repo A (target) with files a.txt, b.txt ---
      const spawnA = (cmd: string[]) =>
        Bun.spawnSync({ cmd, cwd: repoA, stdout: "pipe", stderr: "pipe" });
      spawnA(["git", "init"]);
      spawnA(["git", "config", "user.email", "test@test.com"]);
      spawnA(["git", "config", "user.name", "Test"]);
      writeFileSync(join(repoA, "a.txt"), "file a");
      writeFileSync(join(repoA, "b.txt"), "file b");
      spawnA(["git", "add", "."]);
      spawnA(["git", "commit", "-m", "init"]);

      // --- build repo B (foreign) with files x.txt, y.txt ---
      const spawnB = (cmd: string[]) =>
        Bun.spawnSync({ cmd, cwd: repoB, stdout: "pipe", stderr: "pipe" });
      spawnB(["git", "init"]);
      spawnB(["git", "config", "user.email", "test@test.com"]);
      spawnB(["git", "config", "user.name", "Test"]);
      writeFileSync(join(repoB, "x.txt"), "file x");
      writeFileSync(join(repoB, "y.txt"), "file y");
      spawnB(["git", "add", "."]);
      spawnB(["git", "commit", "-m", "init"]);

      // --- poison the environment to simulate running inside a git hook ---
      process.env.GIT_DIR = join(repoB, ".git");
      process.env.GIT_WORK_TREE = repoB;

      const files = listAllFiles(repoA);

      // Must contain repo-A files
      expect(files).toContain("a.txt");
      expect(files).toContain("b.txt");

      // Must NOT contain repo-B files (envForRoot() strips GIT_DIR / GIT_WORK_TREE)
      expect(files).not.toContain("x.txt");
      expect(files).not.toContain("y.txt");
    } finally {
      // Restore env vars
      if (savedGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = savedGitDir;
      }
      if (savedGitWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = savedGitWorkTree;
      }
      cleanUp(repoA);
      cleanUp(repoB);
    }
  });
});
