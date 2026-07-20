import { test } from "bun:test";
import assert from "node:assert/strict";
import { $ } from "bun";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";


type NativeManifest = {
  name: string;
  version: string;
  optionalDependencies?: Record<string, string>;
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const packageVersion = "1.2.3-alpha.1";
const nativePackageNames = [
  "@bastani/atomic-natives-darwin-arm64",
  "@bastani/atomic-natives-darwin-x64",
  "@bastani/atomic-natives-linux-arm64-gnu",
  "@bastani/atomic-natives-linux-x64-gnu",
  "@bastani/atomic-natives-win32-arm64-msvc",
  "@bastani/atomic-natives-win32-x64-msvc",
] as const;

const nativeBinaryNames = [
  "atomic_natives.darwin-arm64.node",
  "atomic_natives.darwin-x64.node",
  "atomic_natives.linux-arm64-gnu.node",
  "atomic_natives.linux-x64-gnu.node",
  "atomic_natives.win32-arm64-msvc.node",
  "atomic_natives.win32-x64-msvc.node",
] as const;


test("prepared native root tarball contains all six exact-version optional dependencies", async () => {
  const stage = mkdtempSync(join(tmpdir(), "atomic-native-release-contract-"));
  const nativeDir = join(stage, "native");
  const outputDir = join(stage, "packed");
  const version = packageVersion;
  try {
    mkdirSync(nativeDir);
    mkdirSync(outputDir);
    for (const file of ["README.md", "CHANGELOG.md"]) {
      copyFileSync(join(root, "packages/natives", file), join(stage, file));
    }
    for (const file of ["index.js", "index.d.ts"]) {
      copyFileSync(join(root, "packages/natives/native", file), join(nativeDir, file));
    }
    const sourceManifest = await Bun.file(join(root, "packages/natives/package.json")).json() as NativeManifest;
    writeFileSync(join(stage, "package.json"), `${JSON.stringify({ ...sourceManifest, version }, null, 2)}\n`);
    for (const file of nativeBinaryNames) writeFileSync(join(nativeDir, file), "fixture");

    const toolPath = [join(root, "node_modules/.bin"), process.env.PATH].filter(Boolean).join(delimiter);
    const env = { ...process.env, PATH: toolPath };
    await $`bun run --cwd ${stage} create-npm-dirs`.env(env).quiet();
    await $`bun run --cwd ${stage} artifacts`.env(env).quiet();
    await $`bun run --cwd ${stage} prepublish:native -- --skip-optional-publish`.env(env).quiet();
    await $`bun pm pack --cwd ${stage} --destination ${outputDir} --quiet`.quiet();

    const tarballs = readdirSync(outputDir).filter((file) => file.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const packedJson = await $`tar -xOf ${join(outputDir, tarballs[0]!)} package/package.json`.text();
    const packed = JSON.parse(packedJson) as NativeManifest;
    assert.equal(packed.name, "@bastani/atomic-natives");
    assert.equal(packed.version, version);
    assert.deepEqual(Object.keys(packed.optionalDependencies ?? {}).sort(), [...nativePackageNames].sort());
    for (const dependency of nativePackageNames) {
      assert.equal(packed.optionalDependencies?.[dependency], version, dependency);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("publish pipeline prepares exact native package set and publishes in dependency order", async () => {
  const workflow = await Bun.file(`${root}/.github/workflows/publish.yml`).text();
  const expectedOrder = [
    ...nativePackageNames,
    "@bastani/atomic-natives",
    "@bastani/atomic",
  ].join(" ");
  assert.match(workflow, /prepublish:native -- --skip-optional-publish/u);
  assert.match(workflow, /Expected exactly eight npm packages/u);
  assert.ok(workflow.includes(`packages=(${expectedOrder})`), "npm packages must publish native leaves, native root, then coding agent");
  assert.match(workflow, /npm view "\$name@\$VERSION" version[\s\S]*already exists; skipping[\s\S]*npm publish "\$\{tarballs\[\$name\]\}" --provenance/u);
});
