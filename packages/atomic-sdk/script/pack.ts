#!/usr/bin/env bun
/**
 * Pack `@bastani/atomic-sdk` into a tarball that mirrors what
 * `script/publish.ts` would publish to npm — exports rewritten from
 * `./src/<file>.ts` to `{ types: "./dist/<file>.d.ts", import:
 * "./dist/<file>.js" }`, dist-only `files`. Used by the SDK fixture
 * smoke matrix so the fixture installs against the same shape an
 * end-user `bun add @bastani/atomic-sdk` would resolve.
 *
 * Outputs the tarball filename (no trailing newline) on stdout so
 * shell scripts can `TARBALL=$(bun pack.ts)` it directly. Build/pack
 * progress goes to stderr so the captured stdout is just the
 * filename.
 *
 * Restores `package.json` to its source shape on exit so dev
 * checkouts continue to resolve `./src/`.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Build dist/ first; the rewritten exports point at dist files. Build
// progress is captured and forwarded to stderr so the captured stdout
// from this script is just the tarball filename.
{
  const buildResult = Bun.spawnSync(["bun", join(SDK_PKG_ROOT, "script/build.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (buildResult.stdout) process.stderr.write(buildResult.stdout);
  if (buildResult.stderr) process.stderr.write(buildResult.stderr);
  if (buildResult.exitCode !== 0) process.exit(buildResult.exitCode ?? 1);
}

const pkgPath = join(SDK_PKG_ROOT, "package.json");
const pkg = await Bun.file(pkgPath).json();
const originalExports = pkg.exports;

// Mirror script/publish.ts's rewrite — `types` MUST come before
// `import` so TS resolves the .d.ts before the .js.
const rewritten: Record<string, { types: string; import: string }> = {};
for (const [key, src] of Object.entries(originalExports as Record<string, string>)) {
  const base = (src as string).replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, "");
  rewritten[key] = { types: `${base}.d.ts`, import: `${base}.js` };
}
pkg.exports = rewritten;
await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Pack with the rewritten exports. `--quiet` writes only the tarball
// filename to stdout — what the workflow consumes.
let exitCode = 0;
let tarball = "";
try {
  const result = Bun.spawnSync(["bun", "pm", "pack", "--quiet"], {
    cwd: SDK_PKG_ROOT,
    stdout: "pipe",
    stderr: "inherit",
  });
  exitCode = result.exitCode ?? 1;
  tarball = result.stdout
    ? new TextDecoder().decode(result.stdout).trim()
    : "";
} finally {
  pkg.exports = originalExports;
  await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

if (exitCode !== 0) process.exit(exitCode);
process.stdout.write(tarball);
