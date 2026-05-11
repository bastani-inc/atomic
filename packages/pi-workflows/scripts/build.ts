/**
 * Build script for pi-workflows.
 * Steps:
 *   1. Clean dist/
 *   2. Bundle src/index.ts  → dist/index.js
 *   3. Bundle src/extension/index.ts → dist/extension/index.js
 *   4. Emit declarations via tsconfig.build.json  → dist/**\/*.d.ts
 *   5. Run artifact verifier
 */

import { rmSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

function run(cmd: string, args: string[]): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const proc = Bun.spawnSync([cmd, ...args], {
    cwd: pkgRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error(`command failed (exit ${proc.exitCode}): ${cmd} ${args.join(" ")}`);
    process.exit(proc.exitCode ?? 1);
  }
}

// 1. Clean dist
const distDir = resolve(pkgRoot, "dist");
console.log("cleaning dist/");
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 2. Bundle src/index.ts → dist/index.js
run("bun", [
  "build",
  "src/index.ts",
  "--outdir",
  "dist",
  "--target",
  "bun",
]);

// 3. Bundle src/extension/index.ts → dist/extension/index.js
run("bun", [
  "build",
  "src/extension/index.ts",
  "--outdir",
  "dist/extension",
  "--target",
  "bun",
]);

// 4. Emit declarations
run("bun", [
  "x",
  "tsc",
  "--project",
  "tsconfig.build.json",
]);

// 5. Verify artifact
run("bun", [
  "run",
  "scripts/verify-artifact.ts",
]);

console.log("build complete");
