import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SDK_PKG_ROOT = resolve(import.meta.dir, "..");

let buildExitCode: number;

beforeAll(async () => {
  const proc = Bun.spawn(["bun", "run", "script/build.ts"], {
    cwd: SDK_PKG_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  buildExitCode = await proc.exited;
}, 120_000);

test("build exits 0", () => {
  expect(buildExitCode).toBe(0);
});

test("every exports entry has .js and .d.ts in dist", async () => {
  expect(buildExitCode).toBe(0);

  const pkg = await Bun.file(join(SDK_PKG_ROOT, "package.json")).json() as {
    exports: Record<string, string>;
  };

  const missing: string[] = [];

  for (const [exportKey, srcPath] of Object.entries(pkg.exports)) {
    // Skip non-TypeScript exports (e.g. bare .json data files like sdk-protocol-version.json).
    // These don't get compiled into dist — they're referenced directly from the package root.
    if (!(srcPath as string).match(/\.tsx?$/)) continue;

    // srcPath is like "./src/index.ts" — map to "./dist/index.js" + "./dist/index.d.ts"
    const base = (srcPath as string)
      .replace(/^\.\/src\//, "./dist/")
      .replace(/\.tsx?$/, "");
    const jsPath = join(SDK_PKG_ROOT, `${base}.js`);
    const dtsPath = join(SDK_PKG_ROOT, `${base}.d.ts`);

    if (!existsSync(jsPath)) missing.push(`${exportKey}: missing ${base}.js`);
    if (!existsSync(dtsPath)) missing.push(`${exportKey}: missing ${base}.d.ts`);
  }

  expect(missing).toEqual([]);
}, 5_000);
