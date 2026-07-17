import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("test workflow runs platform-independent suites once and preserves cross-platform smoke", async () => {
  const workflow = await Bun.file(join(root, ".github/workflows/test.yml")).text();
  for (const step of ["Typecheck", "File length check", "Docs link validation"]) {
    const block = workflow.slice(workflow.indexOf(`- name: ${step}`), workflow.indexOf("- name:", workflow.indexOf(`- name: ${step}`) + 1));
    assert.match(block, /if: runner\.os == 'Linux'/, `${step} must run on only one matrix leg`);
  }
  assert.match(workflow, /ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE: "1"/);
  assert.match(workflow, /--skip-install --skip-package-build --platform/);
  assert.match(workflow, /Smoke test Linux release archive/);
  assert.match(workflow, /Smoke test Windows release archive/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "unit tests/);
  assert.match(workflow, /name: Deterministic CI and release contracts[\s\S]*run: bun run test:ci-contracts/);
  const deterministicBlock = workflow.slice(workflow.indexOf("name: Deterministic CI and release contracts"), workflow.indexOf("name: Unit tests"));
  assert.doesNotMatch(deterministicBlock, /run-flaky-test-suite/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "integration tests/);
  assert.match(workflow, /run-flaky-test-suite\.ts --label "coding-agent tests/);
  assert.match(workflow, /name: Upload flaky-test diagnostics[\s\S]*if: always\(\)/);
});

test("publisher is a strict protected-main workflow_dispatch", async () => {
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();
  assert.match(publish, /workflow_dispatch:\n\s+inputs:\n\s+version:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/u);
  assert.doesNotMatch(publish, /\n\s+(?:create|workflow_run):/u);
  assert.match(publish, /run-name: Publish \$\{\{ inputs\.version \}\}/u);
  assert.match(publish, /group: publish-\$\{\{ inputs\.version \}\}/u);
  assert.match(publish, /DISPATCH_REF: \$\{\{ github\.ref \}\}/u);
  assert.match(publish, /expected_workflow_ref="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/publish\.yml@refs\/heads\/main"/u);
  assert.match(publish, /"\$WORKFLOW_SHA" == "\$TRIGGER_SHA"/u);
  assert.match(publish, /current_main_sha=.*refs\/heads\/main/u);
  assert.match(publish, /"\$current_main_sha" == "\$WORKFLOW_SHA"/u);
});

test("publisher preserves tag, base, deterministic tree, and exact-SHA contracts", async () => {
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();
  for (const invariant of [
    'git ls-remote --exit-code --refs origin "$expected_tag_ref"',
    "Release-base-ref",
    "Release-base-sha",
    '[[ "$release_base_sha" == "$release_parent" ]]',
    'git merge-base --is-ancestor "$release_base_sha" "$fetched_base_sha"',
    "scripts/verify-release-integrity.ts",
    "ref: ${{ needs.release-integrity.outputs.sha }}",
    "persist-credentials: false",
  ]) {
    assert.ok(publish.includes(invariant), `missing publisher integrity invariant: ${invariant}`);
  }
  assert.match(publish, /tag_response=.*git ls-remote[\s\S]*"\$tag_response" != \*\$'\\n'\*/u);
  assert.match(publish, /"\$resolved_tag_ref" == "\$expected_tag_ref"/u);
  assert.match(publish, /release_commit=.*\^\{commit\}[\s\S]*"\$release_commit" == "\$release_sha"/u);
});

test("publisher keeps least privilege, npm environment, OIDC, and pre-side-effect tag reconfirmation", async () => {
  const publish = await Bun.file(join(root, ".github/workflows/publish.yml")).text();
  assert.match(publish, /permissions:\n\s+contents: read/u);
  assert.match(publish, /publish:\n\s+name: Publish @bastani\/atomic\n\s+environment: npm-publish\n\s+permissions:\n\s+contents: write\n\s+id-token: write/u);
  assert.doesNotMatch(publish, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.match(publish, /npm publish --provenance/u);

  const nativePrepare = publish.indexOf("Prepare Atomic native packages for npm");
  const nativeReconfirm = publish.indexOf("Reconfirm release tag before @bastani/atomic-natives publish");
  const nativePublish = publish.indexOf("Publish Atomic native packages to npm");
  const atomicReconfirm = publish.indexOf("Reconfirm release tag before @bastani/atomic publish");
  const atomicPublish = publish.indexOf("- name: Publish to npm");
  const releaseReconfirm = publish.indexOf("Reconfirm release tag before GitHub Release");
  const githubRelease = publish.indexOf("Create GitHub Release with binaries");
  assert.ok(nativePrepare < nativeReconfirm && nativeReconfirm < nativePublish);
  assert.ok(nativePublish < atomicReconfirm);
  assert.ok(atomicReconfirm < atomicPublish && atomicPublish < releaseReconfirm);
  assert.ok(releaseReconfirm < githubRelease);
  assert.equal((publish.match(/run: bun scripts\/reconfirm-release-tag\.ts/gu) ?? []).length, 3);
});
