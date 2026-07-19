import { test } from "bun:test";
import assert from "node:assert/strict";
import { $ } from "bun";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

type RecoveryFixture = {
  historicalWorkflowSha256: string;
  observedWorkflowRef: string;
  releaseBaseRef: string;
  releaseBaseSha: string;
  changelogSectionSha256: Record<string, string>;
};

type NativeManifest = {
  name: string;
  version: string;
  optionalDependencies?: Record<string, string>;
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = await Bun.file(`${root}/test/fixtures/release/0.9.10-alpha.1-recovery.json`).json() as RecoveryFixture;
const tag = "0.9.10-alpha.1";
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

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function releasedSection(text: string): string {
  const lf = text.replace(/\r\n/gu, "\n");
  const start = lf.indexOf(`## [${tag}]`);
  assert.notEqual(start, -1, `missing ${tag} section`);
  const next = lf.indexOf("\n## [", start + 1);
  return lf.slice(start, next < 0 ? lf.length : next + 1);
}

test("historical workflow bytes and graph prove attempt 2 cannot reach privileged jobs", async () => {
  const historical = await $`git show ${`${tag}:.github/workflows/publish.yml`}`.cwd(root).text();
  assert.equal(sha256(historical), fixture.historicalWorkflowSha256);
  assert.match(historical, /name: Publish\r?\n/u);
  assert.match(historical, /expected_workflow_ref="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/publish\.yml@refs\/heads\/\$\{DEFAULT_BRANCH\}"/u);
  assert.match(historical, /\[\[ "\$WORKFLOW_REF" == "\$expected_workflow_ref" \]\] \|\| \{[^\n]*exit 1;/u);
  assert.notEqual(
    fixture.observedWorkflowRef,
    "bastani-inc/atomic/.github/workflows/publish.yml@refs/heads/main",
    "the immutable rerun must deterministically fail its first integrity gate",
  );

  const integrity = historical.slice(historical.indexOf("    release-integrity:"), historical.indexOf("    linux-binary-smoke:"));
  assert.doesNotMatch(integrity, /contents: write|id-token: write/u);
  const publish = historical.slice(historical.indexOf("    publish:"));
  assert.match(publish, /needs:[\s\S]*- release-integrity/u);
  assert.doesNotMatch(publish.slice(0, publish.indexOf("steps:")), /if:\s*always\(\)/u);
});

test("historical release commit pins the literal immutable base trailers", async () => {
  const message = await $`git show -s --format=%B ${tag}`.cwd(root).text();
  assert.equal(
    message,
    `Release ${tag}\n\nRelease-base-ref: ${fixture.releaseBaseRef}\nRelease-base-sha: ${fixture.releaseBaseSha}\n\n`,
  );
  assert.equal((await $`git show -s --format=%P ${tag}`.cwd(root).text()).trim(), fixture.releaseBaseSha);
});

test("every released 0.9.10-alpha.1 changelog section remains byte-for-byte unchanged", async () => {
  assert.equal(Object.keys(fixture.changelogSectionSha256).length, 8);
  for (const [path, expectedHash] of Object.entries(fixture.changelogSectionSha256)) {
    const current = await Bun.file(`${root}/${path}`).text();
    const lf = current.replace(/\r\n/gu, "\n");
    assert.equal(releasedSection(lf.replace(/\n/gu, "\r\n")), releasedSection(lf), `${path} CRLF parity`);
    assert.equal(sha256(releasedSection(current)), expectedHash, path);
    const base = await $`git show ${`HEAD:${path}`}`.cwd(root).text();
    assert.equal(releasedSection(current), releasedSection(base), path);
  }
});

test("prepared native root tarball contains all six exact-version optional dependencies", async () => {
  const stage = mkdtempSync(join(tmpdir(), "atomic-native-release-contract-"));
  const nativeDir = join(stage, "native");
  const outputDir = join(stage, "packed");
  const version = tag;
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

test("protected publisher executable path invokes both context and ancestry validators", async () => {
  const helper = await Bun.file(`${root}/scripts/verify-publish-context.ts`).text();
  const main = helper.slice(helper.indexOf("if (import.meta.main)"));
  assert.match(main, /const route = validatePublishContext\(context\);/u);
  assert.match(main, /verifyProtectedWorkflowAncestry\(context\.workflowSha, process\.env\.PROTECTED_DEFAULT_REF\);/u);

  const workflow = await Bun.file(`${root}/.github/workflows/publish-release.yml`).text();
  assert.match(workflow, /git fetch --no-tags origin "refs\/heads\/\$\{DEFAULT_BRANCH\}:\$\{PROTECTED_DEFAULT_REF\}"/u);
  assert.match(workflow, /bun scripts\/verify-publish-context\.ts/u);
});
