import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface VersionedPackageJson {
  name: string;
  version: string;
  private?: boolean;
}

interface BumpResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function writeJson(path: string, value: VersionedPackageJson): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): VersionedPackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as VersionedPackageJson;
}

function createFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atomic-bump-version-"));
  mkdirSync(join(root, "packages", "alpha"), { recursive: true });
  mkdirSync(join(root, "packages", "beta"), { recursive: true });

  writeJson(join(root, "package.json"), {
    name: "fixture-monorepo",
    version: "0.1.0",
    private: true,
  });
  writeJson(join(root, "packages", "alpha", "package.json"), {
    name: "@fixture/alpha",
    version: "0.1.0",
    private: true,
  });
  writeJson(join(root, "packages", "beta", "package.json"), {
    name: "@fixture/beta",
    version: "0.1.0",
    private: true,
  });
  writeFileSync(
    join(root, "packages", "alpha", "README.md"),
    '<img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version 0.1.0">\n',
  );

  return root;
}

function runBump(root: string, version: string): BumpResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", join(process.cwd(), "scripts", "bump-version.ts"), version, "--root", root],
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("scripts/bump-version.ts", () => {
  test("updates every versioned package manifest and README badge", () => {
    const root = createFixtureRoot();
    try {
      const result = runBump(root, "1.2.3-4");
      assert.equal(result.exitCode, 0, result.stderr);

      assert.equal(readJson(join(root, "package.json")).version, "1.2.3-4");
      assert.equal(readJson(join(root, "packages", "alpha", "package.json")).version, "1.2.3-4");
      assert.equal(readJson(join(root, "packages", "beta", "package.json")).version, "1.2.3-4");
      assert.match(
        readFileSync(join(root, "packages", "alpha", "README.md"), "utf8"),
        /version-1\.2\.3--4-blue" alt="Version 1\.2\.3-4"/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects v-prefixed and non-numeric prerelease versions", () => {
    const invalidVersions = ["v1.2.3", "1.2.3-rc.1", "1.2.3-1.2", "01.2.3"];

    for (const version of invalidVersions) {
      const root = createFixtureRoot();
      try {
        const result = runBump(root, version);
        assert.notEqual(result.exitCode, 0, `${version} should be rejected`);
        assert.match(result.stderr, /Expected MAJOR\.MINOR\.PATCH or MAJOR\.MINOR\.PATCH-NUMBER/);
        assert.equal(readJson(join(root, "package.json")).version, "0.1.0");
        assert.equal(readJson(join(root, "packages", "alpha", "package.json")).version, "0.1.0");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
