/**
 * Build {{name}} into a single self-contained binary.
 *
 * Output: `./dist/{{name}}` (or `.exe` on Windows). The entire workflow
 * graph plus the bun runtime is compiled in. Distribute that one file.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist");
const targetPlat = process.platform === "win32" ? "windows" : process.platform;
const target = `bun-${targetPlat}-${process.arch}`;
const exeName = process.platform === "win32" ? "{{name}}.exe" : "{{name}}";

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log(`[build] compiling for ${target}…`);
const result = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    "--compile",
    "--target",
    target,
    path.join(here, "mycli.ts"),
    "--outfile",
    path.join(distDir, exeName),
  ],
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode ?? 1);
}

console.log(`[build] done. Try:`);
console.log(`        ./dist/${exeName} hello --prompt "say hi"`);
