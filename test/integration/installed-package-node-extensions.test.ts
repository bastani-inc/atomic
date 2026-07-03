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
import { delimiter, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const repoNodeModules = join(repoRoot, "node_modules");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCli = join(packageDir, "dist", "cli.js");

const distBuilt = fs.existsSync(distCli);

/**
 * Locate a REAL Node runtime on PATH. The repo's bunfig `[run] bun = true`
 * prepends a node->bun shim to PATH for package scripts (e.g.
 * `bun run test:integration`), so a bare spawnSync("node") can hit bun
 * masquerading as node — which exits 1 for `--version` here and, worse, would
 * silently neuter this regression guard (Bun's lenient exports-map resolution
 * hides the Node-only failure). Every candidate is therefore verified to be
 * genuine Node via `typeof Bun === "undefined"`.
 */
function findRealNode(): string | null {
  const names = process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"];
  const seen = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (seen.has(candidate) || !fs.existsSync(candidate)) continue;
      seen.add(candidate);
      const probe = spawnSync(candidate, ["-e", "process.stdout.write(typeof Bun)"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (probe.status === 0 && probe.stdout === "undefined") return candidate;
    }
  }
  return null;
}

const nodeExe = findRealNode();

// Hard-require the smoke only where the pipeline guarantees its
// prerequisites (test.yml sets this flag on the integration step, which runs
// after the package build). Other CI contexts — e.g. publish.yml runs
// `test:all` BEFORE building dist/ — skip gracefully; the same commit's
// npm-under-Node coverage is enforced by the test.yml gate on branch pushes
// and PRs.
const requireSmoke = process.env.ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE === "1";
if (requireSmoke) {
  assert.ok(distBuilt, "packages/coding-agent/dist/cli.js missing — run the build step before the integration tests");
  assert.ok(
    nodeExe,
    `no real Node runtime found on PATH (bun-as-node shims are rejected) — required for the installed-package smoke. PATH=${process.env.PATH}`,
  );
}

const runTest = distBuilt && nodeExe ? test : test.skip;
if (!distBuilt || !nodeExe) {
  console.warn(
    "[installed-package-node-extensions] skipped: requires a built packages/coding-agent/dist and a real (non-bun-shim) node on PATH",
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

    assert.ok(nodeExe, "real node executable must be resolved before the smoke runs");
    const result = spawnSync(nodeExe, [join(atomicDest, "dist", "cli.js"), "--no-session"], {
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
