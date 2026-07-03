/**
 * Integration smoke: run the built @bastani/atomic package under Node from an
 * installed-like layout (dependencies as node_modules siblings, no monorepo
 * packages/ directories next to the loader).
 *
 * Regression guard for #1600/#1609: the extension-loader alias fallback used
 * require.resolve("<pkg>/package.json"), which throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED under Node for packages that do not export
 * "./package.json" (e.g. @earendil-works/pi-ai). Every builtin extension
 * failed to load for npm installs (bin runs under `#!/usr/bin/env node`),
 * while the compiled binary (virtualModules) and Bun-run dev/test paths
 * (lenient exports-map resolution) stayed green — so only a Node-runtime
 * smoke over the installed layout can catch this class of regression.
 */
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const repoNodeModules = join(repoRoot, "node_modules");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCli = join(packageDir, "dist", "cli.js");

const distBuilt = fs.existsSync(distCli);
const nodeAvailable = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;
const isCI = process.env.CI === "true" || process.env.CI === "1";

if (isCI) {
  // CI must never silently skip this regression guard.
  assert.ok(distBuilt, "packages/coding-agent/dist/cli.js missing in CI — run the build step first");
  assert.ok(nodeAvailable, "node is not on PATH in CI — required for the installed-package smoke");
}

const runTest = distBuilt && nodeAvailable ? test : test.skip;
if (!distBuilt || !nodeAvailable) {
  console.warn(
    "[installed-package-node-extensions] skipped: requires a built packages/coding-agent/dist and node on PATH",
  );
}

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Symlink (junction on Windows, so no elevation is needed) a real directory. */
function linkDir(target: string, linkPath: string): void {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(fs.realpathSync(target), linkPath, linkType);
}

/**
 * Build <tmp>/install/node_modules mirroring the repo's node_modules via
 * links, except @bastani/atomic itself, which is copied (not linked) so the
 * loader's realpath does not lead back into the monorepo and re-enable the
 * workspace-path short circuit.
 */
function buildInstalledLayout(): string {
  tmpRoot = fs.mkdtempSync(join(os.tmpdir(), "atomic-node-smoke-"));
  const layoutNodeModules = join(tmpRoot, "install", "node_modules");
  fs.mkdirSync(layoutNodeModules, { recursive: true });

  for (const entry of fs.readdirSync(repoNodeModules)) {
    if (entry === ".bin" || entry === ".cache") continue;
    const source = join(repoNodeModules, entry);
    if (!fs.statSync(source).isDirectory()) continue;
    if (entry === "@bastani") {
      const scopeDir = join(layoutNodeModules, entry);
      fs.mkdirSync(scopeDir);
      for (const scoped of fs.readdirSync(source)) {
        if (scoped === "atomic") continue;
        linkDir(join(source, scoped), join(scopeDir, scoped));
      }
      continue;
    }
    linkDir(source, join(layoutNodeModules, entry));
  }

  const atomicDest = join(layoutNodeModules, "@bastani", "atomic");
  fs.mkdirSync(atomicDest, { recursive: true });
  fs.copyFileSync(join(packageDir, "package.json"), join(atomicDest, "package.json"));
  fs.cpSync(join(packageDir, "dist"), join(atomicDest, "dist"), { recursive: true, dereference: true });
  return atomicDest;
}

runTest(
  "installed @bastani/atomic loads builtin extensions under Node",
  () => {
    const atomicDest = buildInstalledLayout();
    assert.ok(tmpRoot, "layout setup must assign tmpRoot");
    // Isolated HOME + empty cwd: no repo-local or user config can leak in,
    // and the run deterministically ends at the no-configured-models exit.
    const homeDir = join(tmpRoot, "home");
    const workDir = join(tmpRoot, "cwd");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    const result = spawnSync("node", [join(atomicDest, "dist", "cli.js"), "--no-session"], {
      cwd: workDir,
      input: "",
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.signal, null, `smoke run killed by ${result.signal}:\n${output}`);
    assert.ok(!output.includes("Failed to load extension"), `extension load failure under Node:\n${output}`);
    assert.ok(!output.includes('is not defined by "exports"'), `exports-map resolution failure under Node:\n${output}`);
    if (result.status !== 0) {
      assert.match(
        output,
        /No models available|No model selected|No API key found/,
        `unexpected non-zero exit (${result.status}):\n${output}`,
      );
    }
  },
  240_000,
);
