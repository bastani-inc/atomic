import { test, expect } from "bun:test";
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

test("listAllFiles: git rung — populated repo returns tracked files", () => {
  // Skip if git not on PATH at test runtime.
  const gitCheck = Bun.spawnSync({ cmd: ["git", "--version"], stdout: "pipe", stderr: "pipe" });
  if (!gitCheck.success) {
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
  // Skip if rg not on PATH.
  const rgCheck = Bun.spawnSync({ cmd: ["rg", "--version"], stdout: "pipe", stderr: "pipe" });
  if (!rgCheck.success) {
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
