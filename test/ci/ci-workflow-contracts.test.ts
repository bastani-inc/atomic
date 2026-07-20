import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalReleaseBaseRef,
  parseReleaseBaseTrailers,
  validateCanonicalReleaseBaseRef,
} from "../../scripts/release-base.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const publishPath = join(root, ".github/workflows/publish.yml");

function jobBlock(workflow: string, name: string, next?: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing job: ${name}`);
  const end = next ? workflow.indexOf(`  ${next}:`, start + 1) : workflow.length;
  return workflow.slice(start, end);
}

test("test workflow preserves its two-platform matrix and deterministic contracts", async () => {
  const workflow = await Bun.file(join(root, ".github/workflows/test.yml")).text();
  assert.match(workflow, /blacksmith-4vcpu-ubuntu-2404/);
  assert.match(workflow, /blacksmith-4vcpu-windows-2025/);
  assert.match(workflow, /name: Deterministic CI and release contracts[\s\S]*run: bun run test:ci-contracts/);
  assert.match(workflow, /Smoke test Linux release archive/);
  assert.match(workflow, /Smoke test Windows release archive/);
});

test("publish workflow has direct tag and recovery triggers", async () => {
  const workflow = await Bun.file(publishPath).text();
  assert.match(workflow, /push:\s*\n\s*tags:/);
  assert.match(workflow, /"\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*"/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*tag:[\s\S]*required: true[\s\S]*source_ref:[\s\S]*required: false/);
  assert.match(workflow, /SOURCE_REF: \$\{\{ github\.event\.inputs\.source_ref \|\| github\.event\.inputs\.tag \|\| github\.ref_name \}\}/);
  assert.doesNotMatch(workflow, /workflow_run:|create:|repository_dispatch:/);
});

test("publish workflow uses one lightweight integrity gate", async () => {
  const workflow = await Bun.file(publishPath).text();
  const integrity = jobBlock(workflow, "integrity", "native-artifacts");
  assert.equal([...workflow.matchAll(/^  integrity:$/gmu)].length, 1);
  assert.match(integrity, /ref: \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(integrity, /packages\/coding-agent\/package\.json/);
  assert.match(integrity, /Package version \$version does not match tag \$RELEASE_TAG/);
  assert.match(integrity, /subject.*git show -s --format=%s/);
  assert.match(integrity, /Release \$RELEASE_TAG/);
  assert.doesNotMatch(integrity, /Release-base-|merge-base|workflow_ref|workflow_sha|git archive|bump-version|generate-coding-agent-shrinkwrap/iu);
});

test("publish graph stages a draft before npm and undrafts last", async () => {
  const workflow = await Bun.file(publishPath).text();
  for (const job of ["integrity", "native-artifacts", "linux-binary-smoke", "windows-binary-smoke", "build", "stage-github-release", "publish-npm", "publish-github-release", "cleanup-draft-github-release"]) {
    assert.match(workflow, new RegExp(`^  ${job}:$`, "mu"));
  }
  assert.match(jobBlock(workflow, "build", "stage-github-release"), /needs: \[integrity, native-artifacts, linux-binary-smoke, windows-binary-smoke\]/);
  const stage = jobBlock(workflow, "stage-github-release", "publish-npm");
  assert.match(stage, /needs: \[integrity, build\]/);
  assert.match(stage, /already published.*Refusing to mutate[\s\S]*--verify-tag --draft/s);
  assert.match(jobBlock(workflow, "publish-npm", "publish-github-release"), /needs: \[integrity, stage-github-release\]/);
  assert.match(jobBlock(workflow, "publish-github-release", "cleanup-draft-github-release"), /needs: \[stage-github-release, publish-npm\][\s\S]*--draft=false/);
  assert.match(jobBlock(workflow, "cleanup-draft-github-release"), /always\(\).*needs\.stage-github-release\.result != 'skipped'.*needs\.publish-npm\.result != 'success'/);
});

test("publish permissions, timeouts, runners, and OIDC are least privilege", async () => {
  const workflow = await Bun.file(publishPath).text();
  assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /permissions:\s*\n\s*contents: read/);
  const npm = jobBlock(workflow, "publish-npm", "publish-github-release");
  assert.match(npm, /environment: npm-publish/);
  assert.match(npm, /permissions:\s*\n\s*contents: read\s*\n\s*id-token: write/);
  assert.doesNotMatch(npm, /contents: write/);
  assert.match(npm, /npm publish .*--provenance.*--tag "\$NPM_TAG"/);
  assert.match(npm, /npm view .*@\$VERSION.*already exists; skipping/s);
  for (const writeJob of [jobBlock(workflow, "stage-github-release", "publish-npm"), jobBlock(workflow, "publish-github-release", "cleanup-draft-github-release"), jobBlock(workflow, "cleanup-draft-github-release")]) {
    assert.match(writeJob, /contents: write/);
    assert.match(writeJob, /GH_REPO: \$\{\{ github\.repository \}\}/);
    assert.doesNotMatch(writeJob, /id-token: write|npm publish/);
  }
  assert.equal([...workflow.matchAll(/^    timeout-minutes:/gmu)].length, 9);
  assert.match(workflow, /blacksmith-4vcpu-ubuntu-2404-arm/);
  assert.match(workflow, /macos-26-intel/);
  assert.match(workflow, /blacksmith-6vcpu-macos-26/);
  assert.match(workflow, /blacksmith-4vcpu-windows-2025/);
});

test("native release matrix pins all shipped targets and the Linux glibc floor", async () => {
  const workflow = await Bun.file(publishPath).text();
  const native = jobBlock(workflow, "native-artifacts", "linux-binary-smoke");
  for (const target of [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
  ]) assert.match(native, new RegExp(target));
  assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /GLIBC_FLOOR: "2\.17"/);
  assert.match(native, /build_target="\$\{BARE_TARGET\}\.\$\{GLIBC_FLOOR\}"/);
  assert.match(native, /toolchain: 1\.97\.0/);
  assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /RUSTUP_TOOLCHAIN: "1\.97\.0"/);
  assert.match(native, /NATIVE_TARGET: \$\{\{ matrix\.platform == 'darwin' && matrix\.target \|\| '' \}\}/);
  assert.match(native, /CROSS_TARGET: \$\{\{ matrix\.platform != 'darwin'/);
  assert.match(native, /cargo-zigbuild/);
  assert.match(native, /RUSTFLAGS=-C target-cpu=x86-64-v2/);
  assert.match(native, /fail-fast: false/);
  assert.match(native, /name: atomic-natives-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}/);
  assert.match(native, /macos-26-intel/);
  assert.match(native, /blacksmith-6vcpu-macos-26/);
  assert.doesNotMatch(native, /run-id:|github-token:|artifact_lookup|cache/iu);
});

test("release build retains Atomic native, smoke, shrinkwrap, metadata, and asset contracts", async () => {
  const workflow = await Bun.file(publishPath).text();
  assert.match(workflow, /"win32-arm64-msvc"/);
  assert.match(workflow, /atomic-windows-arm64\.zip/);
  assert.match(workflow, /bun run check:shrinkwrap/);
  assert.match(workflow, /Build Linux x64 archive[\s\S]*--platform linux-x64/);
  assert.match(workflow, /Build Windows x64 archive[\s\S]*--platform windows-x64/);
  assert.match(workflow, /Failed to load extension/);
  assert.match(workflow, /native optionalDependencies must be the six exact-version platform packages/);
  assert.match(workflow, /test .* = 8/);
  assert.doesNotMatch(workflow, /Release-base-ref|Release-base-sha|RELEASE_BASE_REFS|deterministic release tree|create-event binding/iu);
});

test("obsolete release workflow files and publisher-only verifiers are absent", () => {
  for (const path of [
    ".github/workflows/publish" + "-tag-created.yml",
    ".github/workflows/publish" + "-release.yml",
    "scripts/verify" + "-publish-context.ts",
    "scripts/verify" + "-release-integrity.ts",
  ]) assert.equal(existsSync(join(root, path)), false, path);
});


test("developer release setup documents only the direct publish workflow", async () => {
  const setup = await Bun.file(join(root, "DEV_SETUP.md")).text();
  assert.match(setup, /tag push starts `\.github\/workflows\/publish\.yml` directly/u);
  assert.match(setup, /trusted publishers with workflow filename `publish\.yml` and environment `npm-publish`/u);
  for (const forbidden of [
    "publish" + "-tag-created.yml",
    "publish" + "-release.yml",
    "RELEASE" + "_BASE_REFS",
    "NPM" + "_TOKEN",
    "NODE" + "_AUTH_TOKEN",
  ]) assert.equal(setup.includes(forbidden), false, forbidden);
});
test("release-base metadata remains available to the versionless cut flow", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(canonicalReleaseBaseRef("main"), "refs/heads/main");
  assert.equal(validateCanonicalReleaseBaseRef("refs/heads/release/workstream-1"), "refs/heads/release/workstream-1");
  for (const newline of ["\n", "\r\n"]) {
    const message = `Release 1.2.3${newline}${newline}Release-base-ref: refs/heads/main${newline}Release-base-sha: ${sha}${newline}`;
    assert.deepEqual(parseReleaseBaseTrailers(message), { baseRef: "refs/heads/main", baseSha: sha });
  }
});

test("cut-release still creates the detached version-stamped tag", async () => {
  const script = await Bun.file(join(root, "scripts/cut-release.ts")).text();
  assert.match(script, /canonicalReleaseBaseRef\(baseBranch\)/);
  assert.match(script, /Release-base-ref: \$\{baseRef\}\\nRelease-base-sha: \$\{baseSha\}/);
  assert.match(script, /git -C \$\{ROOT\} push origin \$\{version\}/);
  assert.doesNotMatch(script, /Bun\.sleep|setTimeout/);
});
